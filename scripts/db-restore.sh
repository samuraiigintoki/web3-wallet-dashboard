#!/usr/bin/env bash
set -euo pipefail
umask 077

fail() {
  local status="$1"
  shift
  printf 'db-restore: %s\n' "$*" >&2
  exit "$status"
}

if [[ "$#" -ne 1 || -z "${1:-}" ]]; then
  fail 2 'usage: TARGET_DATABASE_URL=... scripts/db-restore.sh DUMP_FILE'
fi
if [[ -z "${TARGET_DATABASE_URL:-}" ]]; then
  fail 2 'TARGET_DATABASE_URL is required; there is no default restore target'
fi

archive="$1"
if [[ ! -f "$archive" || ! -r "$archive" ]]; then
  fail 2 'dump file is not readable'
fi
for tool in pg_restore psql; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    fail 2 "$tool is required"
  fi
done
if ! command -v python3 >/dev/null 2>&1; then
  fail 2 'python3 is required to prepare a protected PostgreSQL connection file'
fi

restore_version="$(pg_restore --version 2>/dev/null || true)"
psql_version="$(psql --version 2>/dev/null || true)"
if [[ "$restore_version" != *') 17.'* || "$psql_version" != *') 17.'* ]]; then
  fail 2 'PostgreSQL 17 pg_restore and psql are required'
fi

if ! pg_restore --list --no-password "$archive" >/dev/null 2>&1; then
  fail 1 'input is not a valid PostgreSQL custom-format dump'
fi

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/libpq-service.sh
source "$script_dir/libpq-service.sh"
if ! temporary_directory="$(mktemp -d "${TMPDIR:-/tmp}/.db-restore.XXXXXXXXXX" 2>/dev/null)"; then
  fail 1 'cannot create a temporary restore directory'
fi
trap 'rm -rf -- "$temporary_directory"' EXIT
service_file="$temporary_directory/pg-service.conf"
if ! prepare_pg_service "$TARGET_DATABASE_URL" "$service_file" db_restore_target; then
  fail 2 'TARGET_DATABASE_URL must be a valid PostgreSQL URI'
fi
unset TARGET_DATABASE_URL

# Restore only into a new, empty database. The public schema itself is present
# in a fresh PostgreSQL database, but any user schema or object makes it unsafe.
read_only_check="$(cat <<'SQL'
SELECT CASE WHEN
  EXISTS (
    SELECT 1
    FROM pg_catalog.pg_namespace AS n
    WHERE n.nspname NOT IN ('pg_catalog', 'information_schema', 'public')
      AND n.nspname NOT LIKE 'pg_toast%'
  )
  OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS c
    JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
    WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
      AND n.nspname NOT LIKE 'pg_toast%'
  )
  OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS p
    JOIN pg_catalog.pg_namespace AS n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
  )
  OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_type AS t
    JOIN pg_catalog.pg_namespace AS n ON n.oid = t.typnamespace
    WHERE n.nspname = 'public' AND t.typtype <> 'b'
  )
  OR EXISTS (SELECT 1 FROM pg_catalog.pg_largeobject_metadata)
THEN 1 ELSE 0 END;
SQL
)"
if ! target_has_objects="$(
  PGSERVICEFILE="$service_file" PGSERVICE=db_restore_target psql \
    --no-psqlrc \
    --no-password \
    --quiet \
    --tuples-only \
    --no-align \
    --set=ON_ERROR_STOP=1 \
    --dbname=service=db_restore_target \
    --command="$read_only_check" \
    2>/dev/null
)"; then
  fail 1 'could not inspect the restore target; no restore was attempted'
fi
if [[ "$target_has_objects" != '0' ]]; then
  fail 2 'restore target is not empty; no changes were made'
fi

# No --clean or --create is used. A single transaction makes a failed restore
# roll back instead of leaving a partially restored database.
if ! PGSERVICEFILE="$service_file" PGSERVICE=db_restore_target pg_restore \
  --no-password \
  --single-transaction \
  --exit-on-error \
  --no-owner \
  --no-privileges \
  --dbname=service=db_restore_target \
  "$archive" \
  >/dev/null 2>&1; then
  fail 1 'restore failed; the transaction was rolled back'
fi

rm -rf -- "$temporary_directory"
trap - EXIT
printf 'Database restore completed in the explicit empty target.\n'
