#!/usr/bin/env bash
# .sstor/report-deploy.sh <environment> [succeeded|failed]: tells slop that this pipeline deployed a commit
# to a release or integration environment (one with a role in the board's settings). slop then works out
# which globs that commit contains and shows the environment on their cards.
#
# Call it from the pipeline that deploys the base branch or a release ref, after the deploy, e.g. in a
# CodeBuild buildspec:
#
#   post_build:
#     commands:
#       - bash .sstor/report-deploy.sh staging
#
# It puts a `slop.ci` "Slop Environment Deployed" event on the account's default EventBridge bus; the
# board's deploy-target stack forwards those to slop. The pipeline's role needs events:PutEvents on the
# default bus. The status defaults to the CodeBuild build's own (CODEBUILD_BUILD_SUCCEEDING).
#
# What it sends, and where it comes from (set the SLOP_* variables to override):
#   repo         SLOP_REPO, else the source repository URL (owner/name)
#   sha          SLOP_SHA, else CODEBUILD_RESOLVED_SOURCE_VERSION, else git rev-parse HEAD
#   ref          SLOP_REF (optional: the branch or tag deployed)
#   url          CODEBUILD_BUILD_URL (optional: a link to this run)
#
# A failed report never fails the pipeline.
set -euo pipefail

env="${1:-${SLOP_ENVIRONMENT:-}}"
[[ -n "$env" ]] || { echo "Usage: .sstor/report-deploy.sh <environment> [succeeded|failed]" >&2; exit 2; }

status="${2:-}"
if [[ -z "$status" ]]; then
  if [[ "${CODEBUILD_BUILD_SUCCEEDING:-1}" == "1" ]]; then status=succeeded; else status=failed; fi
fi
[[ "$status" == succeeded || "$status" == failed ]] || { echo "status must be succeeded or failed, not $status" >&2; exit 2; }

repo_of() {
  # https://github.com/owner/name(.git) or git@github.com:owner/name(.git) -> owner/name
  printf '%s' "$1" | sed -E 's#^(https://[^/]+/|git@[^:]+:)##; s#\.git$##'
}
repo="${SLOP_REPO:-}"
[[ -n "$repo" ]] || repo="$(repo_of "${CODEBUILD_SOURCE_REPO_URL:-$(git remote get-url origin 2>/dev/null || true)}")"
sha="${SLOP_SHA:-${CODEBUILD_RESOLVED_SOURCE_VERSION:-$(git rev-parse HEAD 2>/dev/null || true)}}"

if [[ -z "$repo" || -z "$sha" ]]; then
  echo "report-deploy: couldn't tell the repo or commit; set SLOP_REPO and SLOP_SHA. Not reported." >&2
  exit 0
fi

entries="$(mktemp)"
trap 'rm -f "$entries"' EXIT
# python3 builds the JSON, so no value needs shell quoting.
REPORT_ENV="$env" REPORT_STATUS="$status" REPORT_REPO="$repo" REPORT_SHA="$sha" python3 - >"$entries" <<'PY'
import json, os
detail = {
    "repo": os.environ["REPORT_REPO"],
    "environment": os.environ["REPORT_ENV"],
    "sha": os.environ["REPORT_SHA"],
    "status": os.environ["REPORT_STATUS"],
}
if os.environ.get("SLOP_REF"):
    detail["ref"] = os.environ["SLOP_REF"]
if os.environ.get("CODEBUILD_BUILD_URL", "").startswith("https://"):
    detail["url"] = os.environ["CODEBUILD_BUILD_URL"]
print(json.dumps([{"Source": "slop.ci", "DetailType": "Slop Environment Deployed", "Detail": json.dumps(detail)}]))
PY

if aws events put-events --entries "file://$entries" --query 'FailedEntryCount' --output text | grep -qx 0; then
  echo "Reported to slop: $repo at $sha $status in $env"
else
  echo "report-deploy: EventBridge didn't take the event; slop won't show this deploy" >&2
fi
