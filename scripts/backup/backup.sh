#!/usr/bin/env bash
# Take one encrypted, restorable copy of the staging database.
#
# The free tier has no managed backup: Neon's free plan keeps a short history and
# nothing on this project takes a copy of it. This script is that copy. It does
# four things and stops if any of them fails:
#
#   1. dumps the database in pg_dump's custom format, which is what pg_restore
#      needs to rebuild it in one pass;
#   2. writes a sha256 of the dump as it was taken;
#   3. encrypts the dump and decrypts it again to prove the file that will be
#      stored is the file that can be read, comparing the sha256 of the round
#      trip rather than trusting that the write completed;
#   4. writes a manifest holding the table row counts, so a restore can be
#      checked against something that was recorded before the fact.
#
# The plaintext dump never leaves the temporary directory, and the directory is
# removed on exit, including on failure.
#
# Usage:
#   DATABASE_URL=postgres://... BACKUP_PASSPHRASE=... scripts/backup/backup.sh
#
# Environment:
#   DATABASE_URL        required, the database to copy
#   BACKUP_PASSPHRASE   required, the passphrase the artifact is encrypted with
#   BACKUP_OUT_DIR      where the artifact lands, default ./backups
#   PGD_BIN             directory of the Postgres clients, default PATH
#
# Output: <out>/wallet-<UTC timestamp>.dump.enc, its .json manifest, and a
# .sha256 of the encrypted file. Everything printed is safe to log.

set -euo pipefail

# The artifact is encrypted, and it is still nobody else's business. Every file
# this script creates is readable by its owner only.
umask 077

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
. "$script_dir/lib.sh"

require_var DATABASE_URL "Point it at the database to copy."
require_var BACKUP_PASSPHRASE "Without it the artifact would be plaintext."

out_dir="${BACKUP_OUT_DIR:-./backups}"
mkdir -p "$out_dir"
out_dir="$(cd "$out_dir" && pwd)"

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
base="$out_dir/wallet-$stamp"

work_dir="$(mktemp -d)"
cleanup() {
  rm -rf "$work_dir"
}
trap cleanup EXIT
chmod 700 "$work_dir"

echo "source: $(redact_url "$DATABASE_URL")"
echo "target: $base.dump.enc"

plain="$work_dir/wallet.dump"
encrypted="$base.dump.enc"

# --no-owner and --no-privileges: the free tier's role names are not the ones a
# restore target will have, and a dump that insists on them fails to load
# anywhere but the database it came from.
"$(pg_bin pg_dump)" \
  --format=custom \
  --no-owner \
  --no-privileges \
  --file="$plain" \
  "$DATABASE_URL"

dump_bytes="$(wc -c < "$plain" | tr -d ' ')"
dump_sha="$(sha256sum "$plain" | cut -d' ' -f1)"
echo "dump: $dump_bytes bytes, sha256 $dump_sha"

# pbkdf2 with an explicit iteration count: the default OpenSSL uses for -pbkdf2
# is lower than what a passphrase-derived key should cost today.
openssl enc -aes-256-cbc -pbkdf2 -iter 600000 -salt \
  -in "$plain" \
  -out "$encrypted" \
  -pass env:BACKUP_PASSPHRASE

# Prove the artifact decrypts and matches. A truncated or half-written file is
# the failure this catches, and it is caught here rather than on the day the
# backup is needed.
roundtrip_sha="$(
  openssl enc -d -aes-256-cbc -pbkdf2 -iter 600000 \
    -in "$encrypted" \
    -pass env:BACKUP_PASSPHRASE | sha256sum | cut -d' ' -f1
)"
if [[ "$roundtrip_sha" != "$dump_sha" ]]; then
  echo "the encrypted artifact does not decrypt to the dump that was taken" >&2
  rm -f "$encrypted"
  exit 1
fi

encrypted_bytes="$(wc -c < "$encrypted" | tr -d ' ')"
encrypted_sha="$(sha256sum "$encrypted" | cut -d' ' -f1)"
printf '%s  %s\n' "$encrypted_sha" "$(basename "$encrypted")" > "$base.dump.enc.sha256"
echo "artifact: $encrypted_bytes bytes, sha256 $encrypted_sha"

counts_file="$work_dir/counts.txt"
table_counts "$DATABASE_URL" > "$counts_file"

# The manifest is what the restore drill compares against. The passphrase and the
# connection string are not in it: an artifact that carries its own key has no
# key.
{
  printf '{\n'
  printf '  "taken_at": "%s",\n' "$stamp"
  printf '  "source": "%s",\n' "$(redact_url "$DATABASE_URL")"
  printf '  "pg_dump": "%s",\n' "$("$(pg_bin pg_dump)" --version | sed 's/^pg_dump (PostgreSQL) //')"
  printf '  "dump_bytes": %s,\n' "$dump_bytes"
  printf '  "dump_sha256": "%s",\n' "$dump_sha"
  printf '  "encrypted_bytes": %s,\n' "$encrypted_bytes"
  printf '  "encrypted_sha256": "%s",\n' "$encrypted_sha"
  printf '  "cipher": "aes-256-cbc, pbkdf2, 600000 iterations, salted",\n'
  printf '  "tables": {'
  first=1
  while read -r table rows; do
    [[ -z "$table" ]] && continue
    if [[ ! "$table" =~ ^[a-z_][a-z0-9_]*$ ]]; then
      echo "unexpected table name in the manifest: $table" >&2
      exit 1
    fi
    if [[ "$first" -eq 1 ]]; then
      printf '\n'
      first=0
    else
      printf ',\n'
    fi
    printf '    "%s": %s' "$table" "$rows"
  done < "$counts_file"
  printf '\n  }\n'
  printf '}\n'
} > "$base.json"

echo "manifest: $base.json"
echo "backup written: $(basename "$encrypted")"
