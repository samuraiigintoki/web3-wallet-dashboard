// Package integration holds the Week 6 end-to-end flow: a real PostgreSQL
// database, the real repository, the real scanner and the real HTTP router,
// with the RPC endpoint replaced by a scriptable fake chain. Nothing here is
// imported by production code.
package integration

import (
	"bytes"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io/fs"
	"log/slog"
	"math/big"
	"net/http"
	"net/http/httptest"
	"os"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/samuraiigintoki/web3-wallet-dashboard/backend/internal/chain"
	"github.com/samuraiigintoki/web3-wallet-dashboard/backend/internal/contract"
	"github.com/samuraiigintoki/web3-wallet-dashboard/backend/internal/evm"
	"github.com/samuraiigintoki/web3-wallet-dashboard/backend/internal/httpapi"
	"github.com/samuraiigintoki/web3-wallet-dashboard/backend/internal/indexer"
	"github.com/samuraiigintoki/web3-wallet-dashboard/backend/internal/user"
	"github.com/samuraiigintoki/web3-wallet-dashboard/backend/internal/wallet"
	"github.com/samuraiigintoki/web3-wallet-dashboard/backend/migrations"

	_ "github.com/jackc/pgx/v5/stdlib"
)

const (
	// integrationSchema is this suite's own schema. Like the indexer suite it
	// never touches public, so it can run beside the other packages.
	integrationSchema = "integration_test"

	// testPassword satisfies the registration policy: 21 code points.
	testPassword = "correct-horse-battery"

	flowChainID    int64 = 11155111
	flowAddress          = "0x5b324f41e5889cf94cba8e909089683a1a97c318"
	flowOwnerA           = "0x14912965632cd9ab70c046e8d23e9b8dfa9f2746"
	flowOwnerB           = "0x00000000000000000000000000000000000000b2"
	flowRecipient        = "0x00000000000000000000000000000000000000c3"
	flowStartBlock int64 = 1000
	// flowLatestBlock is the tip the first scan catches up to, flowResumedTip
	// the tip after the restart, and flowForkHeight the first height the
	// replacement branch owns.
	flowLatestBlock int64 = 1250
	flowResumedTip  int64 = 1300
	flowForkHeight  int64 = 1050

	canonicalBranch = "canonical"
	forkBranch      = "fork"

	// safeHeadConfirmations mirrors the scanner's reversible confirmation
	// heuristic, so the flow's expectations follow the same rule the system
	// does rather than a second copy of the number.
	safeHeadConfirmations int64 = 12
)

// SQL plumbing -----------------------------------------------------------------

// setupFlowDatabase builds the dedicated schema from the migration set and
// returns a pooled connection pointed at it. Every caller gets a schema built
// from scratch, so a rerun never inherits rows from an earlier one.
func setupFlowDatabase(t *testing.T) *sql.DB {
	t.Helper()
	ctx := t.Context()

	baseDSN := os.Getenv("DATABASE_URL")
	if baseDSN == "" {
		t.Skip("skipping integration test: DATABASE_URL not set")
	}

	admin, err := sql.Open("pgx", baseDSN)
	if err != nil {
		t.Fatalf("open admin connection: %v", err)
	}
	defer admin.Close()
	if err := admin.PingContext(ctx); err != nil {
		t.Fatalf("connect to the database: %v", err)
	}
	if err := createFlowSchema(ctx, admin); err != nil {
		t.Fatalf("prepare the integration schema: %v", err)
	}

	db, err := sql.Open("pgx", schemaDSN(baseDSN, integrationSchema))
	if err != nil {
		t.Fatalf("open integration connection: %v", err)
	}
	t.Cleanup(func() { db.Close() })
	if err := db.PingContext(ctx); err != nil {
		t.Fatalf("connect to the integration schema: %v", err)
	}
	return db
}

func createFlowSchema(ctx context.Context, admin *sql.DB) error {
	conn, err := admin.Conn(ctx)
	if err != nil {
		return fmt.Errorf("acquire migration connection: %w", err)
	}
	defer conn.Close()

	if _, err := conn.ExecContext(ctx, "DROP SCHEMA IF EXISTS "+integrationSchema+" CASCADE"); err != nil {
		return fmt.Errorf("drop stale schema: %w", err)
	}
	if _, err := conn.ExecContext(ctx, "CREATE SCHEMA "+integrationSchema); err != nil {
		return fmt.Errorf("create schema: %w", err)
	}
	if _, err := conn.ExecContext(ctx, "SET search_path TO "+integrationSchema); err != nil {
		return fmt.Errorf("set search path: %w", err)
	}

	entries, err := fs.ReadDir(migrations.FS, ".")
	if err != nil {
		return fmt.Errorf("read migrations: %w", err)
	}
	upFiles := make([]string, 0, len(entries))
	for _, entry := range entries {
		if !entry.IsDir() && strings.HasSuffix(entry.Name(), ".up.sql") {
			upFiles = append(upFiles, entry.Name())
		}
	}
	sort.Strings(upFiles)

	for _, filename := range upFiles {
		content, err := migrations.FS.ReadFile(filename)
		if err != nil {
			return fmt.Errorf("read %s: %w", filename, err)
		}
		if _, err := conn.ExecContext(ctx, string(content)); err != nil {
			return fmt.Errorf("apply %s: %w", filename, err)
		}
	}
	return nil
}

// schemaDSN points the pooled connections at the suite's schema. pgx accepts
// search_path as a startup parameter.
func schemaDSN(baseDSN, schema string) string {
	if strings.Contains(baseDSN, "://") {
		separator := "?"
		if strings.Contains(baseDSN, "?") {
			separator = "&"
		}
		return baseDSN + separator + "search_path=" + schema
	}
	return baseDSN + " search_path=" + schema
}

// Fake chain ------------------------------------------------------------------

// flowEvent is one log a test scripts onto the fake chain.
type flowEvent struct {
	name             string
	owner            string
	multisigTxIndex  uint64
	to               string
	valueWei         *big.Int
	data             []byte
	transactionIndex int
	logIndex         int
}

// fakeChain is a scriptable indexer.ChainReader. It models a canonical chain as
// one branch per height: heights below the fork height use the original branch,
// heights at and above it use the replacement one. Reassigning a branch changes
// every hash derived from it, which is what a reorganization does.
type fakeChain struct {
	t          testing.TB
	address    string
	latest     int64
	forkHeight int64
	plans      map[string]map[int64][]flowEvent

	headerCalls int
	logCalls    []evm.LogFilter
}

func newFakeChain(t testing.TB) *fakeChain {
	return &fakeChain{
		t:       t,
		address: flowAddress,
		plans:   map[string]map[int64][]flowEvent{},
	}
}

// setTip moves the head of the chain forward.
func (c *fakeChain) setTip(latest int64) { c.latest = latest }

// forkFrom reassigns every hash at and above height, and switches the logs those
// heights serve to the replacement branch. Heights below it stay untouched, so
// the last common ancestor is height - 1.
func (c *fakeChain) forkFrom(height int64) { c.forkHeight = height }

// add scripts one event onto a branch.
func (c *fakeChain) add(branch string, number int64, event flowEvent) {
	if c.plans[branch] == nil {
		c.plans[branch] = map[int64][]flowEvent{}
	}
	c.plans[branch][number] = append(c.plans[branch][number], event)
}

func (c *fakeChain) branchAt(number int64) string {
	if c.forkHeight > 0 && number >= c.forkHeight {
		return forkBranch
	}
	return canonicalBranch
}

// blockHash derives the canonical hash of one height of one branch. It is a
// real 32-byte hex value so the stored rows satisfy the schema's shape checks.
func (c *fakeChain) blockHash(branch string, number int64) string {
	if number < 0 {
		return "0x" + strings.Repeat("00", 32)
	}
	sum := sha256.Sum256([]byte(fmt.Sprintf("week6-block|%s|%d", branch, number)))
	return "0x" + hex.EncodeToString(sum[:])
}

func (c *fakeChain) transactionHash(branch string, number int64, transactionIndex int) string {
	sum := sha256.Sum256([]byte(fmt.Sprintf("week6-tx|%s|%d|%d", branch, number, transactionIndex)))
	return "0x" + hex.EncodeToString(sum[:])
}

// canonicalHash is the hash the current chain serves for one height.
func (c *fakeChain) canonicalHash(number int64) string {
	return c.blockHash(c.branchAt(number), number)
}

// canonicalLogs returns the logs the current chain serves for one height in
// canonical order. It is the source of truth the database is compared against.
func (c *fakeChain) canonicalLogs(number int64) []flowEvent {
	return c.branchLogs(c.branchAt(number), number)
}

func (c *fakeChain) branchLogs(branch string, number int64) []flowEvent {
	events := append([]flowEvent(nil), c.plans[branch][number]...)
	sort.Slice(events, func(i, j int) bool {
		if events[i].transactionIndex != events[j].transactionIndex {
			return events[i].transactionIndex < events[j].transactionIndex
		}
		return events[i].logIndex < events[j].logIndex
	})
	return events
}

func (c *fakeChain) BlockNumber(context.Context) (uint64, error) {
	return uint64(c.latest), nil
}

func (c *fakeChain) BlockHeaders(_ context.Context, blockNumbers []uint64) ([]evm.BlockHeader, error) {
	c.headerCalls++
	headers := make([]evm.BlockHeader, 0, len(blockNumbers))
	for _, number := range blockNumbers {
		if int64(number) > c.latest {
			return nil, fmt.Errorf("fake chain has no block %d, its tip is %d", number, c.latest)
		}
		headers = append(headers, evm.BlockHeader{
			Number:     number,
			Hash:       c.canonicalHash(int64(number)),
			ParentHash: c.blockHash(c.branchAt(int64(number)-1), int64(number)-1),
		})
	}
	return headers, nil
}

// FilterLogs serves the logs of one inclusive range in canonical order. It
// rejects anything the real client would never send, so a scanner that stopped
// building its filter through evm.NewLogFilter fails here instead of silently
// scanning a narrower window.
func (c *fakeChain) FilterLogs(_ context.Context, filter evm.LogFilter) ([]evm.RawLog, error) {
	c.logCalls = append(c.logCalls, filter)

	if !strings.EqualFold(filter.Address, c.address) {
		return nil, fmt.Errorf("fake chain received a filter for %q, it serves %q", filter.Address, c.address)
	}
	if len(filter.Topics) != 1 {
		return nil, fmt.Errorf("fake chain received %d topic groups, want the four supported topics", len(filter.Topics))
	}
	if !sameTopicSet(filter.Topics[0], evm.SupportedEventTopics()) {
		return nil, fmt.Errorf("fake chain received topics %v, want the four supported topics", filter.Topics[0])
	}

	fromBlock := int64(filter.FromBlock)
	toBlock := int64(filter.ToBlock)
	if fromBlock > toBlock {
		return nil, fmt.Errorf("fake chain received an inverted range %d..%d", fromBlock, toBlock)
	}

	logs := []evm.RawLog{}
	for number := fromBlock; number <= toBlock && number <= c.latest; number++ {
		branch := c.branchAt(number)
		for _, event := range c.branchLogs(branch, number) {
			logs = append(logs, c.rawLog(branch, number, event))
		}
	}
	return logs, nil
}

// rawLog encodes one scripted event and proves the fixture, not the scanner, is
// correct: the log is decoded before it is served, so a topic or data mistake
// fails with the decoder's own message instead of surfacing as a scan failure.
func (c *fakeChain) rawLog(branch string, number int64, event flowEvent) evm.RawLog {
	raw := evm.RawLog{
		Address:          c.address,
		Topics:           flowTopics(event),
		Data:             flowData(event),
		BlockNumber:      uint64(number),
		BlockHash:        c.blockHash(branch, number),
		TransactionHash:  c.transactionHash(branch, number, event.transactionIndex),
		TransactionIndex: uint64(event.transactionIndex),
		LogIndex:         uint64(event.logIndex),
	}

	decoder, err := evm.NewEventDecoder(c.address)
	if err != nil {
		c.t.Fatalf("build decoder for the fixture: %v", err)
	}
	decoded, err := decoder.Decode(raw)
	if err != nil {
		c.t.Fatalf("fixture %s at block %d does not decode: %v", event.name, number, err)
	}
	if name := decodedEventName(decoded); name != event.name {
		c.t.Fatalf("fixture at block %d decoded as %s, want %s", number, name, event.name)
	}
	return raw
}

func decodedEventName(decoded evm.DecodedEvent) string {
	switch decoded.(type) {
	case evm.SubmitTransactionEvent:
		return "SubmitTransaction"
	case evm.ConfirmTransactionEvent:
		return "ConfirmTransaction"
	case evm.RevokeConfirmationEvent:
		return "RevokeConfirmation"
	case evm.ExecuteTransactionEvent:
		return "ExecuteTransaction"
	default:
		return "unknown"
	}
}

// flowEventTopics maps an event name onto its topic0. The order comes from the
// decoder's own list; the mapping is proven for every fixture by the decode in
// rawLog.
var flowEventTopics = map[string]string{
	"SubmitTransaction":  evm.SupportedEventTopics()[0],
	"ConfirmTransaction": evm.SupportedEventTopics()[1],
	"RevokeConfirmation": evm.SupportedEventTopics()[2],
	"ExecuteTransaction": evm.SupportedEventTopics()[3],
}

func flowTopics(event flowEvent) []string {
	topic0, ok := flowEventTopics[event.name]
	if !ok {
		panic("fixture uses an unsupported event name " + event.name)
	}

	topics := []string{topic0, addressWord(event.owner), uint256Word(event.multisigTxIndex)}
	if event.name == "SubmitTransaction" {
		topics = append(topics, addressWord(event.to))
	}
	return topics
}

// flowData encodes the non-indexed arguments. A SubmitTransaction carries the
// exact wei value and the calldata, so its data is ABI encoded as a static
// uint256 followed by a dynamic bytes value; the three owner events index every
// argument and carry no data at all.
func flowData(event flowEvent) []byte {
	if event.name != "SubmitTransaction" {
		return nil
	}

	value := event.valueWei
	if value == nil {
		value = big.NewInt(0)
	}

	var encoded strings.Builder
	fmt.Fprintf(&encoded, "%064x", value)
	fmt.Fprintf(&encoded, "%064x", 64)
	fmt.Fprintf(&encoded, "%064x", len(event.data))
	padded := make([]byte, ((len(event.data)+31)/32)*32)
	copy(padded, event.data)
	encoded.WriteString(hex.EncodeToString(padded))

	decoded, err := hex.DecodeString(encoded.String())
	if err != nil {
		panic("fixture calldata is not hex: " + err.Error())
	}
	return decoded
}

func addressWord(address string) string {
	trimmed := strings.TrimPrefix(strings.ToLower(address), "0x")
	return "0x" + strings.Repeat("0", 64-len(trimmed)) + trimmed
}

func uint256Word(value uint64) string {
	return fmt.Sprintf("0x%064x", value)
}

func sameTopicSet(got, want []string) bool {
	if len(got) != len(want) {
		return false
	}
	set := make(map[string]bool, len(got))
	for _, topic := range got {
		set[strings.ToLower(topic)] = true
	}
	for _, topic := range want {
		if !set[strings.ToLower(topic)] {
			return false
		}
	}
	return true
}

// Router ----------------------------------------------------------------------

// flowAPI wires the router exactly as cmd/api does, against the same schema the
// scanner writes to, so the deployment the API creates is the one the scanner
// watches and the events the scanner writes are the ones the API serves.
type flowAPI struct {
	t      *testing.T
	router http.Handler
	logs   *bytes.Buffer
}

func newFlowAPI(t *testing.T, db *sql.DB, repo indexer.Repository) *flowAPI {
	t.Helper()

	chainRepo := chain.NewInMemoryRepository()
	chainRepo.Seed(
		chain.Chain{ChainID: 1, Name: "Ethereum", Symbol: "ETH", Enabled: true, CreatedAt: time.Now()},
		chain.Chain{ChainID: flowChainID, Name: "Sepolia", Symbol: "ETH", IsTestnet: true, Enabled: true, CreatedAt: time.Now()},
	)
	chainSvc := chain.NewService(chainRepo)

	logs := &bytes.Buffer{}
	logger := slog.New(slog.NewTextHandler(logs, &slog.HandlerOptions{Level: slog.LevelWarn}))

	router := httpapi.NewRouter(
		wallet.NewService(wallet.NewInMemoryWalletRepo(), chainSvc),
		// Users and sessions are the real Postgres services: the deployment the
		// scanner watches has a foreign key to the user the session belongs to,
		// so both sides have to be rows in this schema.
		user.NewService(user.NewPostgresUserRepository(db)),
		chainSvc,
		contract.NewService(contract.NewPostgresRepository(db), chainSvc),
		repo,
		logger,
		flowReadiness{},
		flowLimiter{},
		flowLimiter{},
	)
	return &flowAPI{t: t, router: router, logs: logs}
}

// flowReadiness reports ready: readiness is not what this flow is proving.
type flowReadiness struct{}

func (flowReadiness) Check(context.Context) error { return nil }

// flowLimiter never limits: the flow makes more requests than a bucket allows,
// and rate limiting has its own suite.
type flowLimiter struct{}

func (flowLimiter) Allow(string) (bool, time.Duration) { return true, 0 }

func (api *flowAPI) do(method, path, body, token string) *httptest.ResponseRecorder {
	api.t.Helper()

	var req *http.Request
	if body == "" {
		req = httptest.NewRequest(method, path, nil)
	} else {
		req = httptest.NewRequest(method, path, strings.NewReader(body))
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}

	rec := httptest.NewRecorder()
	api.router.ServeHTTP(rec, req)
	return rec
}

// token registers a user through the public route and returns a session token,
// so every later request carries a real bearer session.
func (api *flowAPI) token(email string) string {
	api.t.Helper()

	credentials := fmt.Sprintf(`{"email":%q,"password":%q}`, email, testPassword)
	if rec := api.do(http.MethodPost, "/api/v1/auth/register", credentials, ""); rec.Code != http.StatusCreated {
		api.t.Fatalf("register %s: expected 201, got %d body=%s", email, rec.Code, rec.Body.String())
	}
	rec := api.do(http.MethodPost, "/api/v1/auth/login", credentials, "")
	if rec.Code != http.StatusOK {
		api.t.Fatalf("login %s: expected 200, got %d body=%s", email, rec.Code, rec.Body.String())
	}

	var envelope httpapi.LoginResponseEnvelope
	if err := json.Unmarshal(rec.Body.Bytes(), &envelope); err != nil {
		api.t.Fatalf("decode login envelope: %v", err)
	}
	return envelope.Data.Token
}

// track creates the tracked deployment through the API, which is what makes the
// scanner's watch set a product-level input rather than a fixture.
func (api *flowAPI) track(token string, startBlock int64) httpapi.ContractResponse {
	api.t.Helper()

	body := fmt.Sprintf(`{"address":%q,"chainId":%d,"label":"Week 6 flow","startBlock":%d}`,
		flowAddress, flowChainID, startBlock)
	rec := api.do(http.MethodPost, "/api/v1/contracts", body, token)
	if rec.Code != http.StatusCreated {
		api.t.Fatalf("track contract: expected 201, got %d body=%s", rec.Code, rec.Body.String())
	}

	var envelope httpapi.ContractResponseEnvelope
	if err := json.Unmarshal(rec.Body.Bytes(), &envelope); err != nil {
		api.t.Fatalf("decode contract envelope: %v", err)
	}
	return envelope.Data
}

func (api *flowAPI) contract(token string, contractID int64) httpapi.ContractResponse {
	api.t.Helper()

	rec := api.do(http.MethodGet, fmt.Sprintf("/api/v1/contracts/%d", contractID), "", token)
	if rec.Code != http.StatusOK {
		api.t.Fatalf("get contract %d: expected 200, got %d body=%s", contractID, rec.Code, rec.Body.String())
	}

	var envelope httpapi.ContractResponseEnvelope
	if err := json.Unmarshal(rec.Body.Bytes(), &envelope); err != nil {
		api.t.Fatalf("decode contract envelope: %v", err)
	}
	return envelope.Data
}

// events reads one page and returns both the decoded envelope and the raw body,
// so a test can assert the wire shape as well as the decoded values.
func (api *flowAPI) events(token string, contractID int64, page, pageSize string) (httpapi.EventListEnvelope, map[string]any) {
	api.t.Helper()

	path := fmt.Sprintf("/api/v1/contracts/%d/events?page=%s&pageSize=%s", contractID, page, pageSize)
	rec := api.do(http.MethodGet, path, "", token)
	if rec.Code != http.StatusOK {
		api.t.Fatalf("list events for contract %d: expected 200, got %d body=%s", contractID, rec.Code, rec.Body.String())
	}

	var envelope httpapi.EventListEnvelope
	if err := json.Unmarshal(rec.Body.Bytes(), &envelope); err != nil {
		api.t.Fatalf("decode events envelope: %v", err)
	}

	raw := map[string]any{}
	if err := json.Unmarshal(rec.Body.Bytes(), &raw); err != nil {
		api.t.Fatalf("decode raw events body: %v", err)
	}
	return envelope, raw
}
