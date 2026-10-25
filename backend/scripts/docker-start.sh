#!/bin/sh
# What the container runs on a platform that has no separate migration step.
#
# Locally, docker-compose runs `migrate up` as its own one-shot service and starts
# the API only after that service exits successfully. A hosting platform's free
# tier has no equivalent: a pre-deploy command is a paid feature there, so the
# deployment either migrates at boot or does not migrate at all.
#
# So this script migrates first, then hands the process over to the API, and
# migrating is what it does when told nothing at all. That default is deliberate:
# readiness only proves the database answers, so a container that skips
# migrations looks perfectly healthy while serving an old schema. The failure has
# to be the other way round, and silence has to mean "migrate".
#
#   RUN_MIGRATIONS unset or empty  migrate, then start the API. The image's
#                                  default, and what every platform gets without
#                                  configuring anything.
#   RUN_MIGRATIONS=on              the same, stated out loud.
#   RUN_MIGRATIONS=off             start the API only. For a second instance of a
#                                  multi-instance deployment, or for
#                                  docker-compose, which migrates in its own
#                                  service and would otherwise do it twice.
#   anything else                  exit 2 without starting anything. A typo such
#                                  as `true` or `1` must not be read as "off".
#
# A failed migration exits non-zero and the API never starts, so the platform
# keeps the previous deploy serving rather than running new code against an old
# schema.
#
# `exec` matters: the API becomes PID 1, so the platform's SIGTERM reaches it and
# the server drains instead of being killed.
#
# MIGRATE_BIN and API_BIN exist so the test in backend/internal/deploy can run
# this script against stubs. The image sets neither and gets the paths built into
# it.
set -eu

migrate_bin="${MIGRATE_BIN:-/usr/local/bin/migrate}"
api_bin="${API_BIN:-/usr/local/bin/api}"

case "${RUN_MIGRATIONS:-on}" in
  on | '')
    echo "docker-start: applying migrations"
    "$migrate_bin" up
    echo "docker-start: migrations complete, starting the API"
    ;;
  off)
    echo "docker-start: RUN_MIGRATIONS=off, starting the API without migrating"
    ;;
  *)
    echo "docker-start: RUN_MIGRATIONS must be on or off, and it is '${RUN_MIGRATIONS}'. Refusing to start: a value this script does not understand must not be read as permission to skip migrations." >&2
    exit 2
    ;;
esac

exec "$api_bin"
