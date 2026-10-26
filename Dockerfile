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

# Migrate-then-serve. Copied rather than written inline so a platform's own
# command field has no shell quoting to survive, and because the default below
# is this script: the image, not the platform, owns the decision to migrate
# before serving.
COPY backend/scripts/docker-start.sh /usr/local/bin/start
RUN chmod 0755 /usr/local/bin/start

USER appuser

EXPOSE 8080

# Liveness only. Readiness is deliberately absent: a database blip must not
# restart a container that is still serving, which is the reason B3 split the
# two endpoints. /health/live answers without touching the database.
HEALTHCHECK --interval=10s --timeout=3s --start-period=3s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:8080/health/live || exit 1

# The start script is what the image runs by default, so every path into this
# image migrates before it serves unless RUN_MIGRATIONS says otherwise. That
# matters for a platform whose service is created by an API call or a command
# field that silently does not persist: the image behaviour is the one thing
# nobody can forget to configure. docker-compose runs `migrate up` as its own
# service and leaves RUN_MIGRATIONS unset, so there the script starts the API and
# nothing else.
#
# No ENTRYPOINT is set, so a one-shot `migrate up` overrides just the command and
# reuses the same image.
CMD ["/usr/local/bin/start"]
