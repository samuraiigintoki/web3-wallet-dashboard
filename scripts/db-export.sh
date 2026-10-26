#!/usr/bin/env bash
set -euo pipefail
umask 077

fail() {
  local status="$1"
  shift
  printf 'db-export: %s\n' "$*" >&2
  exit "$status"
}

if [[ "$#" -ne 1 || -z "${1:-}" ]]; then
  fail 2 'usage: scripts/db-export.sh OUTPUT_FILE'
fi
if [[ -z "${DATABASE_URL:-}" ]]; then
  fail 2 'DATABASE_URL is required'
fi

output="$1"
if [[ "$output" == '-' ]]; then
  fail 2 'output must be a file path'
fi
if [[ -e "$output" || -L "$output" ]]; then
  fail 2 'output already exists; no file was replaced'
fi
if ! command -v pg_dump >/dev/null 2>&1; then
  fail 2 'pg_dump is required'
fi
if ! command -v python3 >/dev/null 2>&1; then
  fail 2 'python3 is required to prepare a protected PostgreSQL connection file'
fi

version="$(pg_dump --version 2>/dev/null || true)"
if [[ "$version" != *') 17.'* ]]; then
  fail 2 'PostgreSQL 17 pg_dump is required'
fi

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/libpq-service.sh
source "$script_dir/libpq-service.sh"

parent="$(dirname -- "$output")"
if ! mkdir -p -- "$parent" 2>/dev/null; then
  fail 1 'cannot create the output directory'
fi
if ! temporary_directory="$(mktemp -d "$parent/.db-export.XXXXXXXXXX" 2>/dev/null)"; then
  fail 1 'cannot create a temporary export directory'
fi
trap 'rm -rf -- "$temporary_directory"' EXIT

temporary="$temporary_directory/export.dump"
service_file="$temporary_directory/pg-service.conf"
if ! prepare_pg_service "$DATABASE_URL" "$service_file" db_backup; then
  fail 2 'DATABASE_URL must be a valid PostgreSQL URI'
fi
unset DATABASE_URL

if ! PGSERVICEFILE="$service_file" PGSERVICE=db_backup pg_dump \
  --no-password \
  --format=custom \
  --no-owner \
  --no-privileges \
  --dbname=service=db_backup \
  --file="$temporary" \
  2>/dev/null; then
  fail 1 'pg_dump failed; no export was published'
fi
if [[ ! -s "$temporary" ]]; then
  fail 1 'pg_dump returned an empty export'
fi

# ln is atomic and refuses an existing destination, including a symlink.
if ! ln -- "$temporary" "$output" 2>/dev/null; then
  fail 1 'cannot publish the export; the target may already exist'
fi
rm -rf -- "$temporary_directory"
trap - EXIT
printf 'Database export created at %s\n' "$output"
