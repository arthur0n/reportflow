#!/bin/bash
# db-sync.sh - Sync drizzle snapshot with current database state.
# Run before db:generate so the diff is computed against reality, not
# against a possibly-stale snapshot.

set -euo pipefail

echo "🔄 Syncing drizzle snapshot with database..."

cp drizzle/schema.ts drizzle/schema.ts.bak

# drizzle-kit pull writes drizzle/relations.ts and overwrites
# drizzle/schema.ts. We restore our hand-maintained schema below.
# Failure here is fatal — the script must not lie about success.
if ! npx drizzle-kit pull --config=drizzle.config.ts; then
  mv drizzle/schema.ts.bak drizzle/schema.ts
  echo "❌ db:sync failed — drizzle-kit pull could not introspect the database."
  echo "   Verify DATABASE_URL / DB_HOST connectivity, then retry."
  exit 1
fi

mv drizzle/schema.ts.bak drizzle/schema.ts

rm -f drizzle/relations.ts 2>/dev/null || true

echo "✅ Snapshot synced with database"
