package httpapi

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/samuraiigintoki/web3-wallet-dashboard/backend/internal/chain"
	"github.com/samuraiigintoki/web3-wallet-dashboard/backend/internal/contract"
	"github.com/samuraiigintoki/web3-wallet-dashboard/backend/internal/user"
	"github.com/samuraiigintoki/web3-wallet-dashboard/backend/internal/wallet"
)

// errorUserRepo implements user.UserRepository to simulate database failures
type errorUserRepo struct {
	user.UserRepository
}

func (e *errorUserRepo) GetSessionByTokenHash(ctx context.Context, tokenHash string) (user.UserSession, error) {
	return user.UserSession{}, errors.New("database connection down")
}

func newTestRouter(userRepo user.UserRepository) http.Handler {
	walletRepo := wallet.NewInMemoryWalletRepo()

	chainRepo := chain.NewInMemoryRepository()
	chainRepo.Seed(chain.Chain{ChainID: 1, Name: "Ethereum", Symbol: "ETH", Enabled: true})
	chainSvc := chain.NewService(chainRepo)

	walletSvc := wallet.NewService(walletRepo, chainSvc)

	if userRepo == nil {
		userRepo = user.NewInMemoryRepository()
	}
	userSvc := user.NewService(userRepo)

	contractSvc := contract.NewService(contract.NewInMemoryRepository(), chainSvc)

	return NewRouter(walletSvc, userSvc, chainSvc, contractSvc)
}

func TestRequireAuth_Middleware(t *testing.T) {
	ctx := context.Background()
	userRepo := user.NewInMemoryRepository()
	router := newTestRouter(userRepo)

	createdUser, err := userRepo.Create(ctx, user.User{
		Email: "alice@example.com",
	})
	if err != nil {
		t.Fatalf("failed to seed user: %v", err)
	}

	validRawToken := "valid-test-token-12345"
	validSum := sha256.Sum256([]byte(validRawToken))
	validHash := base64.RawURLEncoding.EncodeToString(validSum[:])
	_, err = userRepo.CreateSession(ctx, user.UserSession{
		UserID:    createdUser.ID,
		TokenHash: validHash,
		ExpiresAt: time.Now().Add(24 * time.Hour),
	})
	if err != nil {
		t.Fatalf("failed to seed valid session: %v", err)
	}

	expiredRawToken := "expired-test-token-12345"
	expiredSum := sha256.Sum256([]byte(expiredRawToken))
	expiredHash := base64.RawURLEncoding.EncodeToString(expiredSum[:])
	_, err = userRepo.CreateSession(ctx, user.UserSession{
		UserID:    createdUser.ID,
		TokenHash: expiredHash,
		ExpiresAt: time.Now().Add(-1 * time.Hour),
	})
	if err != nil {
		t.Fatalf("failed to seed expired session: %v", err)
	}

	t.Run("Valid Token Returns 200 and User Email", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, "/api/v1/users/me", nil)
		req.Header.Set("Authorization", "Bearer "+validRawToken)
		rec := httptest.NewRecorder()

		router.ServeHTTP(rec, req)

		if rec.Code != http.StatusOK {
			t.Fatalf("expected 200 OK, got: %d, body: %s", rec.Code, rec.Body.String())
		}
		if !strings.Contains(rec.Body.String(), "alice@example.com") {
			t.Fatalf("expected body to contain alice@example.com, got: %s", rec.Body.String())
		}
	})

	t.Run("Expired Token Returns 401 UNAUTHENTICATED", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, "/api/v1/users/me", nil)
		req.Header.Set("Authorization", "Bearer "+expiredRawToken)
		rec := httptest.NewRecorder()

		router.ServeHTTP(rec, req)

		if rec.Code != http.StatusUnauthorized {
			t.Fatalf("expected 401 Unauthorized, got: %d", rec.Code)
		}
		if !strings.Contains(rec.Body.String(), CodeUnauthenticated) {
			t.Fatalf("expected error code %s, got body: %s", CodeUnauthenticated, rec.Body.String())
		}
	})

	t.Run("Garbage Token Returns 401 UNAUTHENTICATED", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, "/api/v1/users/me", nil)
		req.Header.Set("Authorization", "Bearer garbage-token")
		rec := httptest.NewRecorder()

		router.ServeHTTP(rec, req)

		if rec.Code != http.StatusUnauthorized {
			t.Fatalf("expected 401 Unauthorized, got: %d", rec.Code)
		}
		if !strings.Contains(rec.Body.String(), CodeUnauthenticated) {
			t.Fatalf("expected error code %s, got body: %s", CodeUnauthenticated, rec.Body.String())
		}
	})

	t.Run("Missing Authorization Header Returns 401 UNAUTHENTICATED", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, "/api/v1/users/me", nil)
		rec := httptest.NewRecorder()

		router.ServeHTTP(rec, req)

		if rec.Code != http.StatusUnauthorized {
			t.Fatalf("expected 401 Unauthorized, got: %d", rec.Code)
		}
		if !strings.Contains(rec.Body.String(), CodeUnauthenticated) {
			t.Fatalf("expected error code %s, got body: %s", CodeUnauthenticated, rec.Body.String())
		}
	})

	t.Run("Database Error Returns 500 INTERNAL_SERVER_ERROR", func(t *testing.T) {
		errRouter := newTestRouter(&errorUserRepo{UserRepository: user.NewInMemoryRepository()})
		req := httptest.NewRequest(http.MethodGet, "/api/v1/users/me", nil)
		req.Header.Set("Authorization", "Bearer some-token")
		rec := httptest.NewRecorder()

		errRouter.ServeHTTP(rec, req)

		if rec.Code != http.StatusInternalServerError {
			t.Fatalf("expected 500 Internal Server Error, got: %d", rec.Code)
		}
		if !strings.Contains(rec.Body.String(), CodeInternalError) {
			t.Fatalf("expected error code %s, got body: %s", CodeInternalError, rec.Body.String())
		}
	})
}

func TestRegisterHandler(t *testing.T) {
	router := newTestRouter(nil)

	t.Run("201 Created Valid Payload", func(t *testing.T) {
		body := `{"email":"new@example.com","password":"validpassword"}`
		req := httptest.NewRequest(http.MethodPost, "/api/v1/auth/register", strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		rec := httptest.NewRecorder()

		router.ServeHTTP(rec, req)

		if rec.Code != http.StatusCreated {
			t.Fatalf("expected 201 Created, got: %d, body: %s", rec.Code, rec.Body.String())
		}

		respBody := rec.Body.String()
		if !strings.Contains(respBody, "id") || !strings.Contains(respBody, "email") || !strings.Contains(respBody, "createdAt") {
			t.Fatalf("expected id, email, and createdAt in response, got: %s", respBody)
		}
		if strings.Contains(strings.ToLower(respBody), "password") || strings.Contains(strings.ToLower(respBody), "hash") {
			t.Fatalf("expected no password or hash in response body, got: %s", respBody)
		}
	})

	t.Run("409 Conflict Duplicate Email", func(t *testing.T) {
		body := `{"email":"new@example.com","password":"validpassword"}`
		req := httptest.NewRequest(http.MethodPost, "/api/v1/auth/register", strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		rec := httptest.NewRecorder()

		router.ServeHTTP(rec, req)

		if rec.Code != http.StatusConflict {
			t.Fatalf("expected 409 Conflict, got: %d, body: %s", rec.Code, rec.Body.String())
		}
		if !strings.Contains(rec.Body.String(), CodeUserConflict) {
			t.Fatalf("expected %s in body, got: %s", CodeUserConflict, rec.Body.String())
		}
	})

	t.Run("422 Validation Error 73-byte Password with Details Map", func(t *testing.T) {
		payload, err := json.Marshal(RegisterRequest{
			Email:    "longpass@example.com",
			Password: strings.Repeat("a", 73),
		})
		if err != nil {
			t.Fatalf("failed to marshal payload: %v", err)
		}

		req := httptest.NewRequest(http.MethodPost, "/api/v1/auth/register", bytes.NewReader(payload))
		req.Header.Set("Content-Type", "application/json")
		rec := httptest.NewRecorder()

		router.ServeHTTP(rec, req)

		if rec.Code != http.StatusUnprocessableEntity {
			t.Fatalf("expected 422 Unprocessable Entity, got: %d, body: %s", rec.Code, rec.Body.String())
		}
		if !strings.Contains(rec.Body.String(), CodeValidationError) {
			t.Fatalf("expected %s in body, got: %s", CodeValidationError, rec.Body.String())
		}
		if !strings.Contains(rec.Body.String(), "password") {
			t.Fatalf("expected details map to contain 'password' field, got: %s", rec.Body.String())
		}
	})

	t.Run("400 Bad Request Invalid JSON", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodPost, "/api/v1/auth/register", strings.NewReader(`{"email":`))
		req.Header.Set("Content-Type", "application/json")
		rec := httptest.NewRecorder()

		router.ServeHTTP(rec, req)

		if rec.Code != http.StatusBadRequest {
			t.Fatalf("expected 400 Bad Request, got: %d", rec.Code)
		}
		if !strings.Contains(rec.Body.String(), CodeInvalidJSON) {
			t.Fatalf("expected %s in body, got: %s", CodeInvalidJSON, rec.Body.String())
		}
	})
}

func TestLoginHandler_Identical401(t *testing.T) {
	ctx := context.Background()
	walletRepo := wallet.NewInMemoryWalletRepo()

	chainRepo := chain.NewInMemoryRepository()
	chainRepo.Seed(chain.Chain{ChainID: 1, Name: "Ethereum", Symbol: "ETH", Enabled: true})
	chainSvc := chain.NewService(chainRepo)

	walletSvc := wallet.NewService(walletRepo, chainSvc)

	userRepo := user.NewInMemoryRepository()
	userSvc := user.NewService(userRepo)

	contractSvc := contract.NewService(contract.NewInMemoryRepository(), chainSvc)

	router := NewRouter(walletSvc, userSvc, chainSvc, contractSvc)

	_, err := userSvc.Register(ctx, "registered@example.com", "correctpassword")
	if err != nil {
		t.Fatalf("failed to register user: %v", err)
	}

	// Subtest 1: Unknown email
	reqUnknown := httptest.NewRequest(http.MethodPost, "/api/v1/auth/login", strings.NewReader(`{"email":"unknown@example.com","password":"any"}`))
	reqUnknown.Header.Set("Content-Type", "application/json")
	recUnknown := httptest.NewRecorder()
	router.ServeHTTP(recUnknown, reqUnknown)

	if recUnknown.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401 for unknown email, got: %d", recUnknown.Code)
	}
	bodyUnknown := recUnknown.Body.Bytes()

	// Subtest 2: Wrong password
	reqWrong := httptest.NewRequest(http.MethodPost, "/api/v1/auth/login", strings.NewReader(`{"email":"registered@example.com","password":"wrongpassword"}`))
	reqWrong.Header.Set("Content-Type", "application/json")
	recWrong := httptest.NewRecorder()
	router.ServeHTTP(recWrong, reqWrong)

	if recWrong.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401 for wrong password, got: %d", recWrong.Code)
	}
	bodyWrong := recWrong.Body.Bytes()

	if !bytes.Equal(bodyUnknown, bodyWrong) {
		t.Fatalf("expected identical 401 response bodies for unknown email and wrong password.\nUnknown: %s\nWrong:   %s", string(bodyUnknown), string(bodyWrong))
	}

	// Subtest 3: Success
	t.Run("Valid Credentials 200 OK", func(t *testing.T) {
		reqValid := httptest.NewRequest(http.MethodPost, "/api/v1/auth/login", strings.NewReader(`{"email":"registered@example.com","password":"correctpassword"}`))
		reqValid.Header.Set("Content-Type", "application/json")
		recValid := httptest.NewRecorder()

		router.ServeHTTP(recValid, reqValid)

		if recValid.Code != http.StatusOK {
			t.Fatalf("expected 200 OK, got: %d, body: %s", recValid.Code, recValid.Body.String())
		}

		var env LoginResponseEnvelope
		if err := json.NewDecoder(recValid.Body).Decode(&env); err != nil {
			t.Fatalf("failed to decode login response: %v", err)
		}
		if env.Data.Token == "" {
			t.Fatalf("expected non-empty token")
		}
		if env.Data.ExpiresAt.IsZero() {
			t.Fatalf("expected non-zero expiresAt")
		}
	})
}

func TestLogoutHandler(t *testing.T) {
	ctx := context.Background()
	walletRepo := wallet.NewInMemoryWalletRepo()

	chainRepo := chain.NewInMemoryRepository()
	chainRepo.Seed(chain.Chain{ChainID: 1, Name: "Ethereum", Symbol: "ETH", Enabled: true})
	chainSvc := chain.NewService(chainRepo)

	walletSvc := wallet.NewService(walletRepo, chainSvc)

	userRepo := user.NewInMemoryRepository()
	userSvc := user.NewService(userRepo)

	contractSvc := contract.NewService(contract.NewInMemoryRepository(), chainSvc)

	router := NewRouter(walletSvc, userSvc, chainSvc, contractSvc)

	_, err := userSvc.Register(ctx, "logoutuser@example.com", "mypassword")
	if err != nil {
		t.Fatalf("failed to register user: %v", err)
	}

	loginReq := httptest.NewRequest(http.MethodPost, "/api/v1/auth/login", strings.NewReader(`{"email":"logoutuser@example.com","password":"mypassword"}`))
	loginReq.Header.Set("Content-Type", "application/json")
	loginRec := httptest.NewRecorder()
	router.ServeHTTP(loginRec, loginReq)

	var loginEnv LoginResponseEnvelope
	if err := json.NewDecoder(loginRec.Body).Decode(&loginEnv); err != nil {
		t.Fatalf("failed to decode login response: %v", err)
	}
	token := loginEnv.Data.Token

	// Step 1: GET /api/v1/users/me -> 200
	reqMe := httptest.NewRequest(http.MethodGet, "/api/v1/users/me", nil)
	reqMe.Header.Set("Authorization", "Bearer "+token)
	recMe := httptest.NewRecorder()
	router.ServeHTTP(recMe, reqMe)

	if recMe.Code != http.StatusOK {
		t.Fatalf("expected 200 OK on /api/v1/users/me, got: %d", recMe.Code)
	}

	// Step 2: POST /api/v1/auth/logout -> 200
	reqLogout := httptest.NewRequest(http.MethodPost, "/api/v1/auth/logout", nil)
	reqLogout.Header.Set("Authorization", "Bearer "+token)
	recLogout := httptest.NewRecorder()
	router.ServeHTTP(recLogout, reqLogout)

	if recLogout.Code != http.StatusOK {
		t.Fatalf("expected 200 OK on /api/v1/auth/logout, got: %d", recLogout.Code)
	}

	// Step 3: GET /api/v1/users/me again -> 401
	reqMeAfter := httptest.NewRequest(http.MethodGet, "/api/v1/users/me", nil)
	reqMeAfter.Header.Set("Authorization", "Bearer "+token)
	recMeAfter := httptest.NewRecorder()
	router.ServeHTTP(recMeAfter, reqMeAfter)

	if recMeAfter.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401 Unauthorized on /api/v1/users/me after logout, got: %d", recMeAfter.Code)
	}
}
