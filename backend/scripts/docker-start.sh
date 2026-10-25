#!/bin/sh
# What the container runs on a platform that has no separate migration step.
#
# Locally, docker-compose runs `migrate up` as its own one-shot service and starts
# the API only after that service exits successfully. A hosting platform's free
# tier has no equivalent: a pre-deploy command is a paid feature there, so the
# deployment either migrates at boot or does not migrate at all.
#
# So this script migrates first, then hands the process over to the API.
#
#   RUN_MIGRATIONS=on   migrate, then start the API. If the migration fails the
#                       script exits non-zero and the API never starts, so the
#                       platform keeps the previous deploy serving rather than
#                       running new code against an old schema.
#   anything else       start the API only, which is what the image did before
#                       and what a second instance of a multi-instance deployment
#                       should do once migrations have already run.
#
# `exec` matters: the API becomes PID 1, so the platform's SIGTERM reaches it and
# the server drains instead of being killed.
set -eu

if [ "${RUN_MIGRATIONS:-off}" = "on" ]; then
  echo "docker-start: applying migrations"
  /usr/local/bin/migrate up
  echo "docker-start: migrations complete, starting the API"
fi

exec /usr/local/bin/api
