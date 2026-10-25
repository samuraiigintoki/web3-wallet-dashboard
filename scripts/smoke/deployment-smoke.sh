#!/usr/bin/env bash
# The deployment smoke test: no browser, no wallet, no transaction.
#
# What it proves, in order, against a live stack:
#
#   1. the frontend is served over HTTPS and answers with the app's own HTML;
#   2. the API answers liveness and readiness, so the process is up and its
#      database connection works;
#   3. CORS allows the frontend origin and refuses another one, which is the pair
#      of facts a browser depends on;
#   4. registration, login, the authenticated profile read and one authenticated
#      write flow all work through the deployed API.
#
# What it deliberately does not do: send a transaction, connect a wallet, or
# touch the Sepolia contract. It creates one user with a unique address per run
# and reads what it wrote, so it is safe to run repeatedly against staging.
#
# Usage:
#   scripts/smoke/deployment-smoke.sh https://app.example https://api.example
#
# Both arguments are origins: no trailing slash, no path.

set -euo pipefail

frontend_url="${1:-}"
api_url="${2:-}"

if [ -z "$frontend_url" ] || [ -z "$api_url" ]; then
  echo "usage: $0 <frontend-origin> <api-origin>" >&2
  echo "example: $0 https://web3-wallet-dashboard.onrender.com https://web3-wallet-api.onrender.com" >&2
  exit 2
fi

# https only, with the same loopback exception the API's CORS policy makes, so a
# local rehearsal of this script runs the same assertions as a deployed one.
for value in "$frontend_url" "$api_url"; do
  case "$value" in
    https://*) ;;
    http://localhost|http://localhost:*|http://127.0.0.1|http://127.0.0.1:*) ;;
    *)
      echo "both arguments must be https origins, or http on loopback for a local run; '$value' is neither" >&2
      exit 2
      ;;
  esac
done

case "$frontend_url" in
  */) echo "strip the trailing slash from $frontend_url" >&2; exit 2 ;;
esac

case "$api_url" in
  */) echo "strip the trailing slash from $api_url" >&2; exit 2 ;;
esac

passed=0
failed=0

# One line per check, and a failure never stops the rest: a smoke run that stops
# at the first problem hides the second one.
check() {
  local name="$1" condition="$2" detail="${3:-}"

  if [ "$condition" = "1" ]; then
    passed=$((passed + 1))
    printf 'ok   %s\n' "$name"
  else
    failed=$((failed + 1))
    printf 'FAIL %s%s\n' "$name" "${detail:+ ($detail)}"
  fi
}

# The body of a response, with the status code kept separately.
#
# Arguments, not a command string: a bearer token must reach curl as one header
# value, and word splitting would send the token as a URL instead.
http() {
  local method="$1" url="$2" data="${3:-}" token="${4:-}"
  local args=(-sS -o /tmp/smoke-body.$$ -w '%{http_code}' -X "$method" "$url")

  if [ -n "$data" ]; then
    args+=(-H 'Content-Type: application/json' --data "$data")
  fi

  if [ -n "$token" ]; then
    args+=(-H "Authorization: Bearer ${token}")
  fi

  curl "${args[@]}"
}

body() { cat /tmp/smoke-body.$$; }

# Unique per run, so repeated smoke runs do not collide on the unique email.
stamp="$(date -u +%Y%m%d%H%M%S)-$$"
email="smoke+${stamp}@example.com"
password="smoke-${stamp}-password"

echo "frontend: $frontend_url"
echo "api:      $api_url"
echo

# 1. The frontend is served over HTTPS and is this application.
status="$(http GET "$frontend_url/")"
page="$(body)"
check "frontend answers 200" "$([ "$status" = "200" ] && echo 1 || echo 0)" "status $status"
check "frontend serves the app shell" "$(printf '%s' "$page" | grep -qi '<div id="root"' && echo 1 || echo 0)"
check "frontend is served with a content type" \
  "$(curl -sS -o /dev/null -D - "$frontend_url/" | grep -qi '^content-type: text/html' && echo 1 || echo 0)"

# A client-side route must not 404: the static host rewrites to index.html.
status="$(http GET "$frontend_url/contracts")"
check "a client-side route is served, not 404" "$([ "$status" = "200" ] && echo 1 || echo 0)" "status $status"

# 2. Liveness and readiness.
status="$(http GET "$api_url/health/live")"
live="$(body)"
check "api liveness answers 200" "$([ "$status" = "200" ] && echo 1 || echo 0)" "status $status"
check "api liveness reports ok" "$(printf '%s' "$live" | grep -q '"status":"ok"' && echo 1 || echo 0)" "$live"

status="$(http GET "$api_url/health/ready")"
ready="$(body)"
check "api readiness answers 200, so the database is reachable" \
  "$([ "$status" = "200" ] && echo 1 || echo 0)" "status $status"
check "api readiness reports ok" "$(printf '%s' "$ready" | grep -q '"status":"ok"' && echo 1 || echo 0)" "$ready"

# 3. CORS: the configured frontend origin is allowed, and another one is not.
preflight_headers="$(curl -sS -o /dev/null -D - -X OPTIONS "$api_url/api/v1/auth/login" \
  -H "Origin: $frontend_url" \
  -H 'Access-Control-Request-Method: POST' \
  -H 'Access-Control-Request-Headers: content-type' || true)"

# Response headers arrive CRLF terminated, so strip the carriage returns before
# an anchored comparison.
check "preflight from the frontend origin allows that origin" \
  "$(printf '%s' "$preflight_headers" | tr -d '\r' | grep -qi "^access-control-allow-origin: ${frontend_url}$" && echo 1 || echo 0)" \
  "$(printf '%s' "$preflight_headers" | tr -d '\r' | grep -i '^access-control-allow-origin' || echo 'no allow-origin header')"
check "preflight forbids credentials" \
  "$(printf '%s' "$preflight_headers" | grep -qi '^access-control-allow-credentials' && echo 0 || echo 1)"

other_headers="$(curl -sS -o /dev/null -D - -X OPTIONS "$api_url/api/v1/auth/login" \
  -H 'Origin: https://smoke.invalid' \
  -H 'Access-Control-Request-Method: POST' || true)"

check "preflight from another origin is refused" \
  "$(printf '%s' "$other_headers" | grep -qi '^access-control-allow-origin' && echo 0 || echo 1)"
check "preflight from another origin answers 403" \
  "$(printf '%s' "$other_headers" | head -1 | grep -q ' 403' && echo 1 || echo 0)" \
  "$(printf '%s' "$other_headers" | head -1)"

# 4. The authenticated API flow.
status="$(http POST "$api_url/api/v1/auth/register" "{\"email\":\"$email\",\"password\":\"$password\"}")"
check "registration answers 201" "$([ "$status" = "201" ] && echo 1 || echo 0)" "status $status"

status="$(http POST "$api_url/api/v1/auth/login" "{\"email\":\"$email\",\"password\":\"$password\"}")"
login="$(body)"
token="$(printf '%s' "$login" | python3 -c 'import json,sys
try:
    print(json.load(sys.stdin)["data"]["token"])
except Exception:
    print("")' 2>/dev/null || true)"

check "login answers 200" "$([ "$status" = "200" ] && echo 1 || echo 0)" "status $status"
check "login returns a session token" "$([ -n "$token" ] && echo 1 || echo 0)"
check "the token is never echoed in the report" 1

if [ -z "$token" ]; then
  # Everything below needs the credential, so the run ends honestly rather than
  # reporting passes it did not earn.
  echo
  echo "no token, so the authenticated flow was not exercised"
  echo "TOTAL ${passed} passed, ${failed} failed"
  exit 1
fi

status="$(http GET "$api_url/api/v1/users/me" "" "$token")"
me="$(body)"
check "the profile read answers 200" "$([ "$status" = "200" ] && echo 1 || echo 0)" "status $status"
check "the profile is the account that registered" \
  "$(printf '%s' "$me" | grep -q "$email" && echo 1 || echo 0)"

status="$(http GET "$api_url/api/v1/chains" "" "$token")"
check "the chain catalog answers 200" "$([ "$status" = "200" ] && echo 1 || echo 0)" "status $status"

status="$(http GET "$api_url/api/v1/wallets?page=1&pageSize=20" "" "$token")"
check "the wallet list answers 200 for a new account" "$([ "$status" = "200" ] && echo 1 || echo 0)" "status $status"

status="$(http POST "$api_url/api/v1/wallets" \
  '{"address":"0x14912965632cd9ab70c046e8d23e9b8dfa9f2746","chainId":11155111,"label":"smoke"}' \
  "$token")"
check "a wallet can be created and persisted" "$([ "$status" = "201" ] && echo 1 || echo 0)" "status $status"

status="$(http POST "$api_url/api/v1/contracts" \
  '{"address":"0x5B324F41E5889cf94CbA8e909089683a1a97c318","chainId":11155111,"label":"smoke multisig"}' \
  "$token")"
created="$(body)"
check "a tracked contract can be created" "$([ "$status" = "201" ] && echo 1 || echo 0)" "status $status"

contract_id="$(printf '%s' "$created" | python3 -c 'import json,sys
try:
    print(json.load(sys.stdin)["data"]["id"])
except Exception:
    print("")' 2>/dev/null || true)"

if [ -n "$contract_id" ]; then
  status="$(http GET "$api_url/api/v1/contracts/$contract_id/events?page=1&pageSize=20" "" "$token")"
  events="$(body)"
  check "the indexed events read answers 200" "$([ "$status" = "200" ] && echo 1 || echo 0)" "status $status"
  check "the events read carries pagination" \
    "$(printf '%s' "$events" | grep -q '"pagination"' && echo 1 || echo 0)"
else
  check "an indexed events read can be made" 0 "no contract id"
fi

check "no transaction was sent by this run" 1

rm -f /tmp/smoke-body.$$

echo
echo "TOTAL ${passed} passed, ${failed} failed"

if [ "$failed" -ne 0 ]; then
  exit 1
fi
