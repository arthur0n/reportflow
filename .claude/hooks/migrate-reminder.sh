#!/usr/bin/env bash
# .claude/hooks/migrate-reminder.sh
#
# PostToolUse hook (matcher: Edit|Write): when drizzle/schema.ts or a generated
# drizzle/<NNNN>_*.sql file is touched, emit a reminder that pnpm db:migrate
# must run against the target environment before deploy. The Lambda will
# happily INSERT columns the DB doesn't have yet — that's where the silent
# "Failed query" stacks come from. Reminder-only; never blocks.
#
# Output is JSON on stdout:
#   - systemMessage: visible in the terminal so the human sees it.
#   - hookSpecificOutput.additionalContext: injected into the model context
#     so the assistant also remembers to surface it on the next turn.

set -eo pipefail

input="$(cat)"
file="$(printf '%s' "$input" | jq -r '.tool_input.file_path // empty')"

if [ -z "$file" ]; then
  exit 0
fi

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
project_root="$(cd "$script_dir/../.." && pwd)"

case "$file" in
  "$project_root"/drizzle/schema.ts) ;;
  "$project_root"/drizzle/[0-9]*.sql) ;;
  *) exit 0 ;;
esac

relpath="${file#"$project_root"/}"

jq -nc \
  --arg rel "$relpath" \
  '{
    systemMessage: ("⚠️ Schema touched (" + $rel + ") — run `pnpm db:migrate` against the target DB before deploying."),
    hookSpecificOutput: {
      hookEventName: "PostToolUse",
      additionalContext: ("Drizzle schema/migration file changed: " + $rel + ". Remember to run `pnpm db:migrate` against the target environment before any deploy that bundles this code — otherwise INSERTs will fail with column-does-not-exist on prod. The user runs migrate manually (per project policy: no infra automation).")
    }
  }'
