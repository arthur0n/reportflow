#!/usr/bin/env bash
# .claude/hooks/lint-changed.sh
#
# PostToolUse hook: run ESLint (--max-warnings 0) on the single file that
# Claude just edited or wrote. Silent pass-through for non-TS files or files
# outside this project. Non-zero exit on lint errors → Claude sees the
# failure in the tool result and is forced to fix before moving on.
#
# Solo-dev safety net: catches violations the instant they're introduced,
# not 20 minutes later when `pnpm validate` would have caught them.

set -eo pipefail

# Read the hook event JSON from stdin
input="$(cat)"

# Extract the file path Claude just modified (absolute path from the tool input)
file="$(printf '%s' "$input" | jq -r '.tool_input.file_path // empty')"

# No file path? Nothing to lint.
if [ -z "$file" ]; then
  exit 0
fi

# Only lint TypeScript source files
case "$file" in
  *.ts|*.tsx) ;;
  *) exit 0 ;;
esac

# Resolve the reportflow project root relative to this script
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
project_root="$(cd "$script_dir/../.." && pwd)"

# Only lint files that live inside this project (don't run on neighbor repos)
case "$file" in
  "$project_root"/*) ;;
  *) exit 0 ;;
esac

# Skip files ESLint already excludes to avoid config-not-found noise
case "$file" in
  *"/node_modules/"*|*"/dist/"*|*"/.aws-sam/"*|*"/drizzle/meta/"*|*"/app/src/components/ui/"*)
    exit 0
    ;;
esac

cd "$project_root"
exec pnpm exec eslint --max-warnings 0 "$file" 1>&2
