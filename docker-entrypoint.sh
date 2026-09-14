#!/bin/sh
set -eu

# Synology starts this script as root so bind mounts can be repaired on each start.
# The image's default non-root user skips setup when permissions are already managed.
if [ "$(id -u)" = '0' ]; then
    if [ ! -f /app/.env ]; then
        echo 'Create .env as a file in the project folder before starting.' >&2
        exit 1
    fi

    mkdir -p /app/data /app/output
    chown -hR 1000:1000 /app/data /app/output /app/.env
    chmod -R u+rwX /app/data /app/output
    chmod u+rw /app/.env

    # Replace the shell and drop privileges before loading any application code.
    exec gosu node:node node /app/dist/cli.js "$@"
fi

exec node /app/dist/cli.js "$@"
