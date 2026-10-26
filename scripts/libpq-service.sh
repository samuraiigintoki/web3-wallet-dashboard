#!/usr/bin/env bash

# Build a mode-600 libpq service file without placing a database URI in argv or
# exposing it through pg_dump, pg_restore, or psql process arguments.
prepare_pg_service() {
  local connection_uri="${1:-}"
  local service_file="${2:-}"
  local service_name="${3:-}"

  if [[ -z "$connection_uri" || -z "$service_file" || -z "$service_name" ]]; then
    return 1
  fi

  DB_SERVICE_URL="$connection_uri" python3 - "$service_file" "$service_name" >/dev/null 2>&1 <<'PY'
import os
import re
import sys
from urllib.parse import parse_qsl, unquote, urlsplit

path, service_name = sys.argv[1:]
if not re.fullmatch(r"[A-Za-z0-9_-]+", service_name):
    raise SystemExit(1)

raw_url = os.environ.get("DB_SERVICE_URL", "")
parsed = urlsplit(raw_url)
if parsed.scheme not in ("postgres", "postgresql"):
    raise SystemExit(1)

params = {}
if parsed.hostname:
    params["host"] = parsed.hostname
if parsed.port is not None:
    params["port"] = str(parsed.port)
if parsed.username is not None:
    params["user"] = unquote(parsed.username, errors="strict")
if parsed.password is not None:
    params["password"] = unquote(parsed.password, errors="strict")
if parsed.path.lstrip("/"):
    params["dbname"] = unquote(parsed.path.lstrip("/"), errors="strict")

for key, value in parse_qsl(parsed.query, keep_blank_values=True, strict_parsing=False):
    if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", key):
        raise SystemExit(1)
    key = key.lower()
    if key in ("service", "servicefile"):
        raise SystemExit(1)
    params[key] = value

if not params.get("host") or not params.get("dbname"):
    raise SystemExit(1)

for value in params.values():
    if any(char in value for char in ("\x00", "\r", "\n")):
        raise SystemExit(1)

def quote(value):
    return "'" + value.replace("\\", "\\\\").replace("'", "\\'") + "'"

contents = [f"[{service_name}]\n"]
for key, value in params.items():
    line = f"{key}={quote(value)}\n"
    if len(line.encode("utf-8")) >= 1023:
        raise SystemExit(1)
    contents.append(line)
fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
with os.fdopen(fd, "w", encoding="utf-8") as service:
    service.writelines(contents)
    service.flush()
    os.fsync(service.fileno())
PY
}
