# syntax=docker/dockerfile:1

# Build stage. One module, two binaries: the API and the migration CLI. The
# migrations are embedded in the binary with go:embed, so the runtime image
# needs no SQL files on disk.
FROM golang:1.26-alpine AS build

WORKDIR /src

COPY backend/go.mod backend/go.sum ./
RUN go mod download

COPY backend/ ./

# CGO is off, so the binaries run on plain Alpine with no libc dependency.
RUN CGO_ENABLED=0 go build -trimpath -o /out/api ./cmd/api \
 && CGO_ENABLED=0 go build -trimpath -o /out/migrate ./cmd/migrate

# Final stage. Same Alpine family as the postgres:16-alpine service, so the two
# share a libc generation and a base layer lineage.
FROM alpine:3.20

RUN apk add --no-cache ca-certificates tzdata \
 && adduser -D -H -u 10001 appuser

# Set in the image, not only claimed in docs, so the process time zone and any
# log timestamp read UTC regardless of the host.
ENV TZ=UTC

COPY --from=build /out/api /usr/local/bin/api
COPY --from=build /out/migrate /usr/local/bin/migrate

USER appuser

EXPOSE 8080

# Liveness only. Readiness is deliberately absent: a database blip must not
# restart a container that is still serving, which is the reason B3 split the
# two endpoints. /health/live answers without touching the database.
HEALTHCHECK --interval=10s --timeout=3s --start-period=3s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:8080/health/live || exit 1

# The API is what the image runs by default. No ENTRYPOINT is set, so the
# migrate service in docker-compose.yml overrides just the command and reuses
# this same image for a one-shot `migrate up`.
CMD ["api"]
