#!/bin/sh
set -eu

if [ "$(id -u)" = "0" ]; then
  chown node:node /data
  exec gosu node "$@"
fi

exec "$@"
