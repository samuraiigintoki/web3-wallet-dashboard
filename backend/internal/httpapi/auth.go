package httpapi

import (
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/samuraiigintoki/web3-wallet-dashboard/backend/internal/user"
)

type RegisterRequest struct {
	Email    string `json:"email"`
	Password string `json:"password"`
}

type UserResponse struct {
	ID        int64     `json:"id"`
	Email     string    `json:"email"`
	CreatedAt time.Time `json:"createdAt"`
}

type UserResponseEnvelope struct {
	Data UserResponse `json:"data"`
}

type LoginRequest struct {
	Email    string `json:"email"`
	Password string `json:"password"`
}

type LoginResponse struct {
	Token     string    `json:"token"`
	ExpiresAt time.Time `json:"expiresAt"`
}

type LoginResponseEnvelope struct {
	Data LoginResponse `json:"data"`
}

type MessageResponse struct {
	Message string `json:"message"`
}

type MessageResponseEnvelope struct {
	Data MessageResponse `json:"data"`
}

func (h *Handler) registerUser(w http.ResponseWriter, r *http.Request) {
	var req RegisterRequest
	if err := decodeJSONBody(w, r, &req); err != nil {
		writeError(w, http.StatusBadRequest, CodeInvalidJSON, "invalid request body", nil)
		return
	}

	u, err := h.userSvc.Register(r.Context(), req.Email, req.Password)
	if err != nil {
		var valErr *user.ValidationError
		if errors.As(err, &valErr) {
			details := map[string]string{valErr.Field: valErr.Message}
			writeError(w, http.StatusUnprocessableEntity, CodeValidationError, "validation failed", details)
			return
		}
		if errors.Is(err, user.ErrDuplicateEmail) {
			writeError(w, http.StatusConflict, CodeUserConflict, "email already registered", nil)
			return
		}
		writeError(w, http.StatusInternalServerError, CodeInternalError, "internal error", nil)
		return
	}

	writeJSON(w, http.StatusCreated, UserResponseEnvelope{
		Data: UserResponse{
			ID:        u.ID,
			Email:     u.Email,
			CreatedAt: u.CreatedAt,
		},
	})
}

func (h *Handler) loginUser(w http.ResponseWriter, r *http.Request) {
	var req LoginRequest
	if err := decodeJSONBody(w, r, &req); err != nil {
		writeError(w, http.StatusBadRequest, CodeInvalidJSON, "invalid request body", nil)
		return
	}

	token, session, err := h.userSvc.Login(r.Context(), req.Email, req.Password)
	if err != nil {
		if errors.Is(err, user.ErrInvalidCredentials) {
			writeError(w, http.StatusUnauthorized, CodeInvalidCredentials, "invalid credentials", nil)
			return
		}
		writeError(w, http.StatusInternalServerError, CodeInternalError, "internal error", nil)
		return
	}

	writeJSON(w, http.StatusOK, LoginResponseEnvelope{
		Data: LoginResponse{
			Token:     token,
			ExpiresAt: session.ExpiresAt,
		},
	})
}

func (h *Handler) logoutUser(w http.ResponseWriter, r *http.Request) {
	authHeader := r.Header.Get("Authorization")
	if !strings.HasPrefix(authHeader, "Bearer ") {
		writeError(w, http.StatusUnauthorized, CodeUnauthenticated, "unauthenticated", nil)
		return
	}

	token := strings.TrimSpace(strings.TrimPrefix(authHeader, "Bearer "))
	if token == "" {
		writeError(w, http.StatusUnauthorized, CodeUnauthenticated, "unauthenticated", nil)
		return
	}

	if err := h.userSvc.Logout(r.Context(), token); err != nil {
		writeError(w, http.StatusInternalServerError, CodeInternalError, "internal error", nil)
		return
	}

	writeJSON(w, http.StatusOK, MessageResponseEnvelope{
		Data: MessageResponse{
			Message: "logged out",
		},
	})
}

func (h *Handler) getCurrentUser(w http.ResponseWriter, r *http.Request) {
	u, ok := UserFromContext(r.Context())
	if !ok {
		writeError(w, http.StatusUnauthorized, CodeUnauthenticated, "unauthenticated", nil)
		return
	}

	writeJSON(w, http.StatusOK, UserResponseEnvelope{
		Data: UserResponse{
			ID:        u.ID,
			Email:     u.Email,
			CreatedAt: u.CreatedAt,
		},
	})
}
