#!/usr/bin/env bash
# Restore a backup taken by backup.sh into one database, and check the result.
#
# The restore is only useful if it can be run without thinking, on the day the
# database is gone. So the guards are narrow and explicit:
#
#   - the target must be given in the environment, not on the command line, so it
#     does not end up in a shell history or a process list;
#   - a target that already holds tables is refused unless RESTORE_FORCE=1,
#     because pg_restore --clean drops what it finds;
#   - a target that is not on this machine is refused unless
#     RESTORE_TARGET_CONFIRMED=1, so pointing this at staging is a decision
#     someone makes rather than a typo that happens;
#   - the decrypted dump is checked against the manifest's sha256 before
#     pg_restore reads it;
#   - the row counts after the restore are compared with the manifest, and a
#     difference is a failed restore, not a note.
#
# Usage:
#   DATABASE_URL=postgres://... BACKUP_PASSPHRASE=... \
#     scripts/backup/restore.sh backups/wallet-20260101T000000Z.dump.enc
#
# Environment:
#   DATABASE_URL        required, the database to restore into
#   BACKUP_PASSPHRASE   required
#   RESTORE_FORCE       1 to restore over a database that already has tables
#   RESTORE_TARGET_CONFIRMED  1 to allow a target that is not localhost
#   RESTORE_EXPECTED    manifest to compare counts against, default the one next
#                       to the artifact
#   PGD_BIN             directory of the Postgres clients, default PATH

set -euo pipefail

# The artifact is encrypted, and it is still nobody else's business. Every file
# this script creates is readable by its owner only.
umask 077

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
. "$script_dir/lib.sh"

artifact="${1:-}"
if [[ -z "$artifact" || ! -f "$artifact" ]]; then
  echo "usage: $0 <file.dump.enc>" >&2
  exit 2
fi

require_var DATABASE_URL "Point it at the database to restore into."
require_var BACKUP_PASSPHRASE "The artifact is encrypted with it."

artifact="$(cd "$(dirname "$artifact")" && pwd)/$(basename "$artifact")"
expected_manifest="${RESTORE_EXPECTED:-${artifact%.dump.enc}.json}"

# Local only, unless someone says otherwise. The check is on the host part of
# the URL, not on the whole string, so a password containing "localhost" cannot
# pass it by accident.
target_host="$(
  printf '%s' "$DATABASE_URL" | sed -e 's|^[a-z]*://||' -e 's|^[^@]*@||' -e 's|[:/].*$||'
)"
case "$target_host" in
  localhost|127.0.0.1|::1|"") ;;
  *)
    if [[ "${RESTORE_TARGET_CONFIRMED:-0}" != "1" ]]; then
      echo "refusing to restore into $target_host: it is not this machine." >&2
      echo "set RESTORE_TARGET_CONFIRMED=1 if that is what you mean." >&2
      exit 2
    fi
    ;;
esac

existing="$(
  "$(pg_bin psql)" "$DATABASE_URL" --no-psqlrc --quiet --tuples-only --no-align -c \
    "SELECT count(*) FROM pg_tables WHERE schemaname = 'public'"
)"
if [[ "$existing" != "0" && "${RESTORE_FORCE:-0}" != "1" ]]; then
  echo "refusing to restore: the target already holds $existing table(s) and pg_restore --clean would drop them." >&2
  echo "set RESTORE_FORCE=1 if that is what you mean." >&2
  exit 2
fi

work_dir="$(mktemp -d)"
cleanup() {
  rm -rf "$work_dir"
}
trap cleanup EXIT
chmod 700 "$work_dir"

echo "artifact: $(basename "$artifact")"
echo "target:   $(redact_url "$DATABASE_URL")"

plain="$work_dir/wallet.dump"
if ! openssl enc -d -aes-256-cbc -pbkdf2 -iter 600000 \
  -in "$artifact" \
  -out "$plain" \
  -pass env:BACKUP_PASSPHRASE 2> "$work_dir/openssl.err"; then
  # A wrong passphrase fails inside OpenSSL's padding check, which reports
  # "bad decrypt" and nothing else. Say what that means instead.
  echo "could not decrypt $(basename "$artifact"): the passphrase is wrong or the file is damaged" >&2
  cat "$work_dir/openssl.err" >&2
  exit 1
fi

sha="$(sha256sum "$plain" | cut -d' ' -f1)"
if [[ -f "$expected_manifest" ]]; then
  expected_sha="$(sed -n 's/.*"dump_sha256": "\([0-9a-f]\{64\}\)".*/\1/p' "$expected_manifest")"
  if [[ -n "$expected_sha" && "$sha" != "$expected_sha" ]]; then
    echo "the decrypted dump does not match the manifest: $sha != $expected_sha" >&2
    exit 1
  fi
else
  echo "warning: no manifest at $(basename "$expected_manifest"), skipping the sha256 check" >&2
fi

# --clean --if-exists makes this the same command whether the target is a fresh
# database or a half-written one; --exit-on-error turns the first failed object
# into a failed restore instead of a directory that looks populated.
"$(pg_bin pg_restore)" \
  --dbname="$DATABASE_URL" \
  --clean \
  --if-exists \
  --no-owner \
  --no-privileges \
  --exit-on-error \
  "$plain"

echo "restored, comparing row counts"

counts_file="$work_dir/counts.txt"
table_counts "$DATABASE_URL" > "$counts_file"

if [[ ! -f "$expected_manifest" ]]; then
  cat "$counts_file"
  echo "restore finished without a manifest to compare against"
  exit 0
fi

# Compare as sorted key/value lines, so a table that is missing, extra, or
# holding a different number of rows all report here.
sed -n '/"tables": {/,/^  }/p' "$expected_manifest" \
  | sed -n 's/^ *"\([a-z_][a-z0-9_]*\)": \([0-9]\+\).*/\1 \2/p' \
  | sort > "$work_dir/expected.txt"
sort "$counts_file" > "$work_dir/actual.txt"

if ! diff -u "$work_dir/expected.txt" "$work_dir/actual.txt" > "$work_dir/diff.txt"; then
  echo "the restore does not match the manifest:" >&2
  cat "$work_dir/diff.txt" >&2
  exit 1
fi

echo "row counts match the manifest for $(wc -l < "$work_dir/actual.txt" | tr -d ' ') table(s)"
echo "restore verified"
