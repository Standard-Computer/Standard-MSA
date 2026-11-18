#!/bin/sh
# Apply migrations, then start the standalone Next server.
set -e
node node_modules/prisma/build/index.js migrate deploy
exec node server.js
