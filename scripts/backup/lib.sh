#!/usr/bin/env bash
# Shared helpers for the backup and restore scripts.
#
# Both scripts handle a connection string and a passphrase, so both need the
# same two guarantees: nothing prints a credential, and a missing value stops
# the run instead of producing an empty or unencrypted file.

# Print a connection string in a form that is safe to log: scheme, user and
# host, with the password and the database name dropped.
#
# Partial redaction is not redaction. A value that merely has its password
# removed is still a live endpoint with a live user, so only the parts needed to
# identify which database this is survive.
redact_url() {
  local url="$1"
  if [[ "$url" != *"@"* ]]; then
    printf '<unparseable>'
    return
  fi
  local scheme="${url%%://*}"
  local rest="${url#*://}"
  local userinfo="${rest%%@*}"
  local hostpart="${rest#*@}"
  local host="${hostpart%%/*}"
  local user="${userinfo%%:*}"
  printf '%s://%s@%s (database name withheld)' "$scheme" "$user" "$host"
}

# Read one variable by name and exit with a usable message when it is empty.
require_var() {
  local name="$1"
  local hint="$2"
  local value="${!name:-}"
  if [[ -z "$value" ]]; then
    echo "refusing to run: $name is not set. $hint" >&2
    exit 2
  fi
}

# Where the Postgres client binaries come from.
#
# The default is the client on PATH. PGD_BIN points at a versioned install on a
# host that has several, and it is also how the version is pinned: a dump must
# be taken with a client at least as new as the server, or the server version
# check refuses it.
pg_bin() {
  local name="$1"
  if [[ -n "${PGD_BIN:-}" ]]; then
    printf '%s/%s' "$PGD_BIN" "$name"
  else
    printf '%s' "$name"
  fi
}

# Emit "table rows" lines, sorted, for every table in the public schema.
#
# The counts are exact `count(*)` values, not the planner's `n_live_tup`
# estimate: an estimate that agrees after a restore would agree by luck.
#
# This is the number a restore is checked against. It is not a proof that every
# byte came back, and it is not meant to be: the point is that a restore into an
# empty database ends up holding the same rows the source did, which is the
# failure a backup tool actually has.
table_counts() {
  local url="$1"
  "$(pg_bin psql)" "$url" --no-psqlrc --quiet --tuples-only --no-align --field-separator=' ' <<'SQL'
SELECT format(
  'SELECT t, n FROM (%s) AS counts(t, n) ORDER BY t',
  string_agg(
    format('SELECT %L AS t, count(*) AS n FROM %I.%I', tablename, schemaname, tablename),
    ' UNION ALL '
  )
) AS q
FROM pg_tables
WHERE schemaname = 'public'
\gexec
SQL
}
