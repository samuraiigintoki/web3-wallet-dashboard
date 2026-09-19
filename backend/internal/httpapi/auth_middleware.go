package httpapi

import (
	"context"
	"net/http"
	"strings"

	"github.com/samuraiigintoki/web3-wallet-dashboard/backend/internal/user"
)

type authContextKey struct{}

var userCtxKey = authContextKey{}

func UserFromContext(ctx context.Context) (user.User, bool) {

	val := ctx.Value(userCtxKey)
	u, ok := val.(user.User)

	return u, ok
}

func RequireAuth(userSvc *user.Service) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
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

			u, err := userSvc.ValidateSession(r.Context(), token)
			if err != nil {
				writeError(w, http.StatusUnauthorized, CodeUnauthenticated, "unauthenticated", nil)
				return
			}

			ctx := context.WithValue(r.Context(), userCtxKey, u)
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}
