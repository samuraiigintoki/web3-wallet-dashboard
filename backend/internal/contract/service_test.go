package contract_test

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/samuraiigintoki/web3-wallet-dashboard/backend/internal/contract"
)

type mockChainValidator struct {
	supportedChains map[int64]bool
	err             error
}

func (m *mockChainValidator) IsSupported(ctx context.Context, chainID int64) (bool, error) {
	if m.err != nil {
		return false, m.err
	}
	return m.supportedChains[chainID], nil
}

func setupService() (*contract.Service, *contract.InMemoryRepository) {
	repo := contract.NewInMemoryRepository()
	val := &mockChainValidator{
		supportedChains: map[int64]bool{1: true, 137: true},
	}
	svc := contract.NewService(repo, val)
	return svc, repo
}

func TestService_Create(t *testing.T) {
	ctx := context.Background()

	t.Run("successful creation with normalized address", func(t *testing.T) {
		svc, _ := setupService()
		input := contract.CreateInput{
			Address:    "0xABCDEF1234567890ABCDEF1234567890ABCDEF12",
			ChainID:    1,
			Label:      "Uniswap V3 Pool",
			StartBlock: 1234567,
		}

		c, err := svc.Create(ctx, 101, input)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}

		if c.Address != strings.ToLower(input.Address) {
			t.Errorf("expected lowercase address %s, got %s", strings.ToLower(input.Address), c.Address)
		}
		if c.Label != "Uniswap V3 Pool" {
			t.Errorf("expected label 'Uniswap V3 Pool', got %s", c.Label)
		}
		if c.StartBlock != 1234567 {
			t.Errorf("expected start block 1234567, got %d", c.StartBlock)
		}
		if !c.Enabled {
			t.Errorf("expected enabled true")
		}
		if c.CreatedAt.IsZero() {
			t.Errorf("expected non-zero CreatedAt")
		}
	})

	t.Run("address validations", func(t *testing.T) {
		svc, _ := setupService()
		invalidAddresses := []string{
			"",
			"0x123",
			"123456789012345678901234567890123456789012",
			"0xZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ",
		}

		for _, addr := range invalidAddresses {
			_, err := svc.Create(ctx, 101, contract.CreateInput{
				Address:    addr,
				ChainID:    1,
				Label:      "Test",
				StartBlock: 0,
			})
			var valErr *contract.ValidationError
			if !errors.As(err, &valErr) || valErr.Field != "address" {
				t.Errorf("expected address validation error for %q, got %v", addr, err)
			}
		}
	})

	t.Run("negative start block validation", func(t *testing.T) {
		svc, _ := setupService()
		_, err := svc.Create(ctx, 101, contract.CreateInput{
			Address:    "0xabcdef1234567890abcdef1234567890abcdef12",
			ChainID:    1,
			Label:      "Test",
			StartBlock: -1,
		})
		var valErr *contract.ValidationError
		if !errors.As(err, &valErr) || valErr.Field != "startBlock" {
			t.Errorf("expected startBlock validation error, got %v", err)
		}
	})

	t.Run("label validations and unicode rune counting", func(t *testing.T) {
		svc, _ := setupService()

		// Empty/whitespace label
		for _, lbl := range []string{"", "   "} {
			_, err := svc.Create(ctx, 101, contract.CreateInput{
				Address:    "0xabcdef1234567890abcdef1234567890abcdef12",
				ChainID:    1,
				Label:      lbl,
				StartBlock: 0,
			})
			var valErr *contract.ValidationError
			if !errors.As(err, &valErr) || valErr.Field != "label" {
				t.Errorf("expected label validation error for %q, got %v", lbl, err)
			}
		}

		// Unicode Hindi label: 20 characters (60 bytes) -> should pass <= 50 rune check
		hindiLabel := "नमस्ते दुनिया नमस्ते" // 20 runes, 58 bytes
		_, err := svc.Create(ctx, 101, contract.CreateInput{
			Address:    "0xabcdef1234567890abcdef1234567890abcdef12",
			ChainID:    1,
			Label:      hindiLabel,
			StartBlock: 0,
		})
		if err != nil {
			t.Fatalf("expected Hindi label with <=50 runes to pass, got: %v", err)
		}

		// 51 characters label -> should fail
		longLabel := strings.Repeat("a", 51)
		_, err = svc.Create(ctx, 101, contract.CreateInput{
			Address:    "0xabcdef1234567890abcdef1234567890abcdef13",
			ChainID:    1,
			Label:      longLabel,
			StartBlock: 0,
		})
		var valErr *contract.ValidationError
		if !errors.As(err, &valErr) || valErr.Field != "label" {
			t.Errorf("expected label length validation error, got %v", err)
		}
	})

	t.Run("unsupported chain validation", func(t *testing.T) {
		svc, _ := setupService()

		chainCases := []struct {
			chainID int64
			msg     string
		}{
			{999, "unsupported chain id"},
			{0, "invalid chainId"},
			{-5, "invalid chainId"},
		}

		for _, tc := range chainCases {
			_, err := svc.Create(ctx, 101, contract.CreateInput{
				Address:    "0xabcdef1234567890abcdef1234567890abcdef12",
				ChainID:    tc.chainID,
				Label:      "Test",
				StartBlock: 0,
			})
			var valErr *contract.ValidationError
			if !errors.As(err, &valErr) || valErr.Field != "chainId" || valErr.Message != tc.msg {
				t.Errorf("expected validation field 'chainId' with message %q, got: %v", tc.msg, err)
			}
		}
	})

	t.Run("chain validator error propagation", func(t *testing.T) {
		repo := contract.NewInMemoryRepository()
		expectedErr := errors.New("validator network timeout")
		val := &mockChainValidator{err: expectedErr}
		svc := contract.NewService(repo, val)

		_, err := svc.Create(ctx, 101, contract.CreateInput{
			Address:    "0xabcdef1234567890abcdef1234567890abcdef12",
			ChainID:    1,
			Label:      "Test",
			StartBlock: 0,
		})
		if !errors.Is(err, expectedErr) {
			t.Errorf("expected validator error %v to propagate unchanged, got: %v", expectedErr, err)
		}
	})

	t.Run("deployment reuse by second user and startBlock echo", func(t *testing.T) {
		svc, _ := setupService()
		addr := "0x1111111111111111111111111111111111111111"

		// User 1 creates deployment with startBlock = 1000
		c1, err := svc.Create(ctx, 1, contract.CreateInput{
			Address:    addr,
			ChainID:    1,
			Label:      "User1 Label",
			StartBlock: 1000,
		})
		if err != nil {
			t.Fatalf("failed to create User 1 tracking: %v", err)
		}

		// User 2 tracks same contract deployment with startBlock = 5000
		c2, err := svc.Create(ctx, 2, contract.CreateInput{
			Address:    strings.ToUpper(addr),
			ChainID:    1,
			Label:      "User2 Label",
			StartBlock: 5000,
		})
		if err != nil {
			t.Fatalf("failed to create User 2 tracking: %v", err)
		}

		if c1.ID != c2.ID {
			t.Errorf("expected same deployment ID, got c1=%d, c2=%d", c1.ID, c2.ID)
		}
		// Stored startBlock (1000) must be echoed back to User 2
		if c2.StartBlock != 1000 {
			t.Errorf("expected echoed startBlock 1000, got %d", c2.StartBlock)
		}
	})

	t.Run("duplicate tracking conflict for same user", func(t *testing.T) {
		svc, _ := setupService()
		addr := "0x2222222222222222222222222222222222222222"

		_, err := svc.Create(ctx, 1, contract.CreateInput{
			Address:    addr,
			ChainID:    1,
			Label:      "First Track",
			StartBlock: 0,
		})
		if err != nil {
			t.Fatalf("failed first tracking: %v", err)
		}

		_, err = svc.Create(ctx, 1, contract.CreateInput{
			Address:    addr,
			ChainID:    1,
			Label:      "Duplicate Track",
			StartBlock: 0,
		})
		if !errors.Is(err, contract.ErrAlreadyTracked) {
			t.Errorf("expected ErrAlreadyTracked on duplicate tracking, got %v", err)
		}
	})
}

func TestService_Get(t *testing.T) {
	ctx := context.Background()
	svc, _ := setupService()

	c, err := svc.Create(ctx, 1, contract.CreateInput{
		Address:    "0x3333333333333333333333333333333333333333",
		ChainID:    1,
		Label:      "User 1 Tracking",
		StartBlock: 100,
	})
	if err != nil {
		t.Fatalf("failed to create: %v", err)
	}

	t.Run("successful lookup for owner", func(t *testing.T) {
		got, err := svc.Get(ctx, 1, c.ID)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if got.ID != c.ID || got.Label != "User 1 Tracking" {
			t.Errorf("mismatched record: %+v", got)
		}
	})

	t.Run("scoped lookup fails for foreign user", func(t *testing.T) {
		_, err := svc.Get(ctx, 2, c.ID)
		if !errors.Is(err, contract.ErrContractNotFound) {
			t.Errorf("expected ErrContractNotFound for foreign user, got %v", err)
		}
	})

	t.Run("lookup fails for nonexistent id", func(t *testing.T) {
		_, err := svc.Get(ctx, 1, 99999)
		if !errors.Is(err, contract.ErrContractNotFound) {
			t.Errorf("expected ErrContractNotFound for nonexistent id, got %v", err)
		}
	})
}

func TestService_List(t *testing.T) {
	ctx := context.Background()
	svc, _ := setupService()

	// Seed 3 contracts for User 1, 1 contract for User 2
	_, _ = svc.Create(ctx, 1, contract.CreateInput{Address: "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", ChainID: 1, Label: "Alpha Vault", StartBlock: 1})
	_, _ = svc.Create(ctx, 1, contract.CreateInput{Address: "0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB", ChainID: 137, Label: "Beta Pool", StartBlock: 2})
	c3, _ := svc.Create(ctx, 1, contract.CreateInput{Address: "0xCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC", ChainID: 1, Label: "Gamma Swap", StartBlock: 3})
	_, _ = svc.Create(ctx, 2, contract.CreateInput{Address: "0xDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD", ChainID: 1, Label: "Alpha Clone", StartBlock: 4})

	// Disable Gamma Swap (c3) to test tri-state enabled filters
	disabledVal := false
	_, _ = svc.Update(ctx, 1, c3.ID, nil, &disabledVal)

	t.Run("scoped list returns only user trackings", func(t *testing.T) {
		list, total, err := svc.List(ctx, 1, contract.ListFilter{})
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if total != 3 || len(list) != 3 {
			t.Errorf("expected 3 items for user 1, got %d (total: %d)", len(list), total)
		}
	})

	t.Run("filter by chain id", func(t *testing.T) {
		list, total, err := svc.List(ctx, 1, contract.ListFilter{ChainID: 137})
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if total != 1 || len(list) != 1 || list[0].Label != "Beta Pool" {
			t.Errorf("expected 1 item for chain 137, got total %d", total)
		}
	})

	t.Run("filter by unsupported or negative chain returns validation error", func(t *testing.T) {
		_, _, err := svc.List(ctx, 1, contract.ListFilter{ChainID: -5})
		var valErr *contract.ValidationError
		if !errors.As(err, &valErr) || valErr.Field != "chainId" || valErr.Message != "invalid chainId" {
			t.Errorf("expected negative chainId validation error, got %v", err)
		}

		// Test unsupported chain ID validation error
		_, _, err = svc.List(ctx, 1, contract.ListFilter{ChainID: 999})
		if !errors.As(err, &valErr) || valErr.Field != "chainId" || valErr.Message != "unsupported chain id" {
			t.Errorf("expected unsupported chainId validation error, got %v", err)
		}
	})

	t.Run("enabled tri-state filter", func(t *testing.T) {
		// 1. Filter with enabled = nil (should return both enabled and disabled)
		list, total, err := svc.List(ctx, 1, contract.ListFilter{})
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if total != 3 || len(list) != 3 {
			t.Errorf("expected all 3 items when filter.Enabled is nil, got %d", len(list))
		}

		// 2. Filter with enabled = true
		trueVal := true
		list, total, err = svc.List(ctx, 1, contract.ListFilter{Enabled: &trueVal})
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if total != 2 {
			t.Errorf("expected 2 items when filter.Enabled is true, got %d", total)
		}
		for _, item := range list {
			if !item.Enabled {
				t.Errorf("expected only enabled items, got item: %s", item.Label)
			}
		}

		// 3. Filter with enabled = false
		falseVal := false
		list, total, err = svc.List(ctx, 1, contract.ListFilter{Enabled: &falseVal})
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if total != 1 || list[0].ID != c3.ID {
			t.Errorf("expected 1 disabled item (Gamma Swap), got %d", total)
		}
	})

	t.Run("chain validator error propagation during list", func(t *testing.T) {
		repo := contract.NewInMemoryRepository()
		expectedErr := errors.New("validator lookup failure")
		val := &mockChainValidator{err: expectedErr}
		svc := contract.NewService(repo, val)

		_, _, err := svc.List(ctx, 1, contract.ListFilter{ChainID: 1})
		if !errors.Is(err, expectedErr) {
			t.Errorf("expected list validator error %v to propagate unchanged, got: %v", expectedErr, err)
		}
	})

	t.Run("search by label and address term", func(t *testing.T) {
		list, total, err := svc.List(ctx, 1, contract.ListFilter{Search: "ALPHA"})
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if total != 1 || list[0].Label != "Alpha Vault" {
			t.Errorf("expected Alpha Vault, got total=%d", total)
		}

		list, total, err = svc.List(ctx, 1, contract.ListFilter{Search: "bbbbbb"})
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if total != 1 || list[0].Label != "Beta Pool" {
			t.Errorf("expected Beta Pool address match, got total=%d", total)
		}
	})

	t.Run("pagination bounds validation", func(t *testing.T) {
		_, _, err := svc.List(ctx, 1, contract.ListFilter{Page: 10001})
		var valErr *contract.ValidationError
		if !errors.As(err, &valErr) || valErr.Field != "page" {
			t.Errorf("expected page validation error, got %v", err)
		}

		_, _, err = svc.List(ctx, 1, contract.ListFilter{PageSize: 101})
		if !errors.As(err, &valErr) || valErr.Field != "pageSize" {
			t.Errorf("expected pageSize validation error, got %v", err)
		}
	})
}

func TestService_Update(t *testing.T) {
	ctx := context.Background()
	svc, _ := setupService()

	c, err := svc.Create(ctx, 1, contract.CreateInput{
		Address:    "0x4444444444444444444444444444444444444444",
		ChainID:    1,
		Label:      "Initial Label",
		StartBlock: 0,
	})
	if err != nil {
		t.Fatalf("failed to create: %v", err)
	}

	t.Run("404 precedence over invalid payload for foreign/nonexistent record", func(t *testing.T) {
		emptyLabel := ""
		// User 2 attempts invalid update on User 1's contract
		_, err := svc.Update(ctx, 2, c.ID, &emptyLabel, nil)
		if !errors.Is(err, contract.ErrContractNotFound) {
			t.Errorf("expected 404 ErrContractNotFound precedence over validation error, got %v", err)
		}
	})

	t.Run("all-nil update is a no-op returning unchanged record", func(t *testing.T) {
		updated, err := svc.Update(ctx, 1, c.ID, nil, nil)
		if err != nil {
			t.Fatalf("unexpected error on nil-update: %v", err)
		}
		if updated.Label != "Initial Label" || !updated.Enabled {
			t.Errorf("expected unchanged record, got %+v", updated)
		}
	})

	t.Run("valid update label and enabled", func(t *testing.T) {
		newLabel := "Updated Label"
		disabled := false
		updated, err := svc.Update(ctx, 1, c.ID, &newLabel, &disabled)
		if err != nil {
			t.Fatalf("failed to update: %v", err)
		}
		if updated.Label != "Updated Label" || updated.Enabled != false {
			t.Errorf("expected updated values, got label=%s, enabled=%v", updated.Label, updated.Enabled)
		}
	})

	t.Run("partial update enabled-only with label nil", func(t *testing.T) {
		enabledVal := true
		updated, err := svc.Update(ctx, 1, c.ID, nil, &enabledVal)
		if err != nil {
			t.Fatalf("failed enabled-only update: %v", err)
		}
		if updated.Label != "Updated Label" || !updated.Enabled {
			t.Errorf("expected label to be preserved and enabled to update, got: %+v", updated)
		}
	})

	t.Run("label validations on update", func(t *testing.T) {
		// Empty / whitespace label validation
		emptyLabel := "   "
		_, err := svc.Update(ctx, 1, c.ID, &emptyLabel, nil)
		var valErr *contract.ValidationError
		if !errors.As(err, &valErr) || valErr.Field != "label" {
			t.Errorf("expected empty label validation error, got %v", err)
		}

		// 51 characters label validation
		longLabel := strings.Repeat("x", 51)
		_, err = svc.Update(ctx, 1, c.ID, &longLabel, nil)
		if !errors.As(err, &valErr) || valErr.Field != "label" || valErr.Message != "must be 50 characters or less" {
			t.Errorf("expected 51-character label validation error on update, got: %v", err)
		}
	})
}

func TestService_Delete(t *testing.T) {
	ctx := context.Background()
	svc, _ := setupService()
	addr := "0x5555555555555555555555555555555555555555"

	// Both User 1 and User 2 track the same contract deployment
	c1, _ := svc.Create(ctx, 1, contract.CreateInput{Address: addr, ChainID: 1, Label: "User 1 Contract", StartBlock: 0})
	c2, _ := svc.Create(ctx, 2, contract.CreateInput{Address: addr, ChainID: 1, Label: "User 2 Contract", StartBlock: 0})

	t.Run("foreign user cannot delete", func(t *testing.T) {
		err := svc.Delete(ctx, 3, c1.ID)
		if !errors.Is(err, contract.ErrContractNotFound) {
			t.Errorf("expected ErrContractNotFound, got %v", err)
		}
	})

	t.Run("successful delete leaves deployment and other user tracking intact", func(t *testing.T) {
		err := svc.Delete(ctx, 1, c1.ID)
		if err != nil {
			t.Fatalf("unexpected error deleting tracking: %v", err)
		}

		// User 1 lookup should fail
		_, err = svc.Get(ctx, 1, c1.ID)
		if !errors.Is(err, contract.ErrContractNotFound) {
			t.Errorf("expected user 1 tracking to be deleted, got %v", err)
		}

		// Non-idempotent check: second delete of same ID must return ErrContractNotFound
		err = svc.Delete(ctx, 1, c1.ID)
		if !errors.Is(err, contract.ErrContractNotFound) {
			t.Errorf("expected ErrContractNotFound on second delete, got: %v", err)
		}

		// User 2 tracking must remain intact
		u2Record, err := svc.Get(ctx, 2, c2.ID)
		if err != nil {
			t.Fatalf("expected user 2 tracking intact, got error: %v", err)
		}
		if u2Record.ID != c2.ID {
			t.Errorf("user 2 tracking corrupted")
		}
	})
}
