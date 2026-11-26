#!/bin/sh
# Apply migrations, then start the standalone Next server.
#
# The Prisma CLI is NOT in the standalone bundle (it is a dev dependency and
# the server never imports it), so the image carries it in a self-contained
# tree of its own built by scripts/collect-prisma-cli.ts. Resolve it from
# there, not from ./node_modules: tests/docker/prisma-cli-closure.test.ts
# keeps this path, the Dockerfile and the collector in step (SHA-4378).
set -e

if [ -z "${DATABASE_URL}" ]; then
  echo "entrypoint: DATABASE_URL is not set — see .env.example" >&2
  exit 1
fi

# A `file:` database needs its directory to exist before migrate runs. Compose
# mounts a volume at /app/data; a platform deploy with no volume attached has
# no such directory and `migrate deploy` would fail on an opaque "Unable to
# open the database file" instead of booting (SHA-4378).
case "${DATABASE_URL}" in
  file:/*)
    db_path="${DATABASE_URL#file:}"
    db_path="${db_path%%\?*}"
    db_dir=$(dirname "${db_path}")
    if [ ! -d "${db_dir}" ]; then
      echo "entrypoint: creating ${db_dir} for the SQLite database."
      echo "entrypoint: NOTE this path is not a mounted volume — the database"
      echo "entrypoint: will be lost when this container is replaced."
      mkdir -p "${db_dir}"
    fi
    ;;
esac

node prisma-cli/node_modules/prisma/build/index.js migrate deploy \
  --schema ./prisma/schema.prisma
exec node server.js
