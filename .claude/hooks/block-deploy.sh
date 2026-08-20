#!/usr/bin/env bash
# .claude/hooks/block-deploy.sh
#
# PreToolUse hook (matcher: Bash): block manual deploy commands.
# Deploys must go through GitHub Actions per project conventions.
# See docs/project_conventions.md §4 "NEVER deploy manually" and auto-memory.
#
# This hook ONLY fires for Claude-initiated Bash commands. It does NOT
# protect against you running sam deploy directly in a terminal — that's
# what branch protection + the pre-push hook + CI validate.yml are for.

set -eo pipefail

input="$(cat)"
cmd="$(printf '%s' "$input" | jq -r '.tool_input.command // empty')"

# No command payload? Silent pass.
if [ -z "$cmd" ]; then
  exit 0
fi

blocked_reason=""

case "$cmd" in
  *"sam deploy"*)
    blocked_reason="sam deploy — push to main to trigger .github/workflows/deploy-api.yml"
    ;;
  *"sam sync"*)
    blocked_reason="sam sync — deploys go through deploy-api.yml, not local sync"
    ;;
  *"aws s3 sync"*"s3://reportflow-frontend"*)
    blocked_reason="aws s3 sync → reportflow-frontend — frontend deploys run via deploy-app.yml"
    ;;
  *"aws cloudfront create-invalidation"*)
    blocked_reason="cloudfront create-invalidation — runs automatically in deploy-app.yml"
    ;;
  *"aws lambda update-function-code"*)
    blocked_reason="aws lambda update-function-code — SAM manages Lambda code via deploy-api.yml"
    ;;
esac

if [ -n "$blocked_reason" ]; then
  cat >&2 <<EOF
[block-deploy] BLOCKED: $blocked_reason

Project convention (docs/project_conventions.md §4 + auto-memory rule):
all deploys MUST go through GitHub Actions, never manually from the laptop.

To deploy: commit → git push origin main. Pre-push runs pnpm validate;
CI validate.yml + deploy-api.yml/deploy-app.yml handle the rest.
EOF
  exit 1
fi

exit 0
