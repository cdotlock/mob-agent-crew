#!/bin/sh
set -eu

if [ "$(id -u)" = "0" ]; then
  chown -R node:node /data
  exec gosu node "$@"
fi

exec "$@"
