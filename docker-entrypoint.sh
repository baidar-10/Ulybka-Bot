#!/bin/sh
set -e
echo "Running migrations..."
node packages/db/src/migrate.js
echo "Seeding catalog if empty..."
node packages/db/src/seed.js
echo "Starting bot..."
exec node apps/bot/dist/index.js
