#!/usr/bin/env bash
# .sstor/deploy.sh <environment>: this repository's single deploy entry point. slop never runs it
# itself; it starts the board's deploy job (a CodeBuild project with buildspec-deploy.yml, or a
# GitHub Actions workflow), which checks out exactly the pushed commit and runs this script.
#
# The job passes:
#   SLOP_ENVIRONMENT   the target environment (also $1)
#   SLOP_GLOB          the glob being deployed (e.g. s1f4)
#   SLOP_SHA           the commit being deployed
#   SLOP_DEPLOY_ID     slop's ID for this deploy
#   SLOP_CALLBACK_URL  a signed URL for reporting the result (optional for CodeBuild, whose
#                      result also reaches slop through EventBridge)
#
# Replace the body of deploy() with this repository's deploy. Exit non-zero on failure.
set -euo pipefail

env="${1:-${SLOP_ENVIRONMENT:-}}"
[[ -n "$env" ]] || { echo "Usage: .sstor/deploy.sh <environment>" >&2; exit 2; }

# Reports the result to slop when a callback URL was given. Never fails the deploy itself.
report() {
  local status="$1" message="$2"
  [[ -n "${SLOP_CALLBACK_URL:-}" ]] || return 0
  # Keep the message JSON-safe: drop quotes, backslashes and control characters.
  message="$(printf '%s' "$message" | tr -d '"\\' | tr -s '[:cntrl:]' ' ' | cut -c1-500)"
  curl -fsS --max-time 20 -X POST -H 'content-type: application/json' \
    --data "{\"status\":\"$status\",\"message\":\"$message\"}" "$SLOP_CALLBACK_URL" >/dev/null ||
    echo "Couldn't report the deploy result to slop" >&2
}
trap 'report failed "deploy.sh failed (line $LINENO)"' ERR

deploy() {
  echo "Deploying ${SLOP_GLOB:-this branch} at ${SLOP_SHA:-$(git rev-parse HEAD)} to $env"
  # e.g. npm ci && npm run build && aws s3 sync dist "s3://my-app-$env"
  echo "Replace deploy() in .sstor/deploy.sh with this repository's deploy" >&2
  return 1
}

deploy
report succeeded "Deployed to $env"
