#!/bin/bash
# Pre-push guard: catch "I changed drizzle/schema.ts but forgot to run
# db:generate". Compares the push range against the remote and fails if
# schema.ts is modified without at least one new drizzle/*.sql file.
#
# Pure git, no DB access. Runs on every machine that pushes.
#
# Edge cases handled:
#   - First push of a branch (no remote tracking yet) → compare against main.
#   - Branch deletion push → skip.

set -euo pipefail

# Read the line husky / git pipes via stdin: <local_ref> <local_sha> <remote_ref> <remote_sha>
while read -r LOCAL_REF LOCAL_SHA REMOTE_REF REMOTE_SHA; do
  # Skip branch deletion (local sha is all zeros).
  if [[ "$LOCAL_SHA" =~ ^0+$ ]]; then continue; fi

  # No remote yet (new branch) → diff against the merge base with main.
  if [[ "$REMOTE_SHA" =~ ^0+$ ]]; then
    BASE=$(git merge-base "$LOCAL_SHA" origin/main 2>/dev/null || echo "")
  else
    BASE="$REMOTE_SHA"
  fi

  if [[ -z "$BASE" ]]; then
    # No comparable base — can't decide; let the push through. CI will catch it.
    continue
  fi

  CHANGED=$(git diff --name-only "$BASE" "$LOCAL_SHA" || true)

  SCHEMA_TOUCHED=false
  NEW_MIGRATION=false

  while IFS= read -r FILE; do
    if [[ "$FILE" == "drizzle/schema.ts" ]]; then SCHEMA_TOUCHED=true; fi
    if [[ "$FILE" =~ ^drizzle/[0-9]+_.*\.sql$ ]]; then NEW_MIGRATION=true; fi
  done <<< "$CHANGED"

  if [[ "$SCHEMA_TOUCHED" == true && "$NEW_MIGRATION" == false ]]; then
    echo "✗ pre-push: drizzle/schema.ts changed but no new migration file in this push."
    echo "  Run \`pnpm db:generate\` locally, review the SQL, commit it, then push again."
    echo "  (Migrations are required so prod schema can catch up to the new code.)"
    exit 1
  fi
done

exit 0
