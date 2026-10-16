#!/usr/bin/env bash
# Prepares a GitHub repository for slop, using your gh login.
#   - merge settings: squash only, PR title as the squash commit title, delete merged branches
#   - optional --protect [<check>...]: a `slop` ruleset on the base branch (no force push or deletion, the required
#     checks, and the up-to-date requirement) with slop's App and repo admins on the bypass list (classic branch
#     protection can't exempt an App). slop merges one glob at a time (its merge line): the head of the line is updated
#     from the base, rechecked and squash merged, so the head is always up to date when it merges. Created or updated by
#     name, so re-running updates the rule; with no check names it requires `checks` (every PR's lint, type check and
#     tests), the check subs wait for
#   - checks slop's GitHub App is subscribed to the events slop needs and, for any it isn't, prints the
#     App's settings link (GitHub has no API to subscribe: a person ticks them in the UI)
#   - prints the links to install slop's GitHub App and the Claude GitHub App on the repo
#     (GitHub only allows that in the browser or with a classic personal access token)
# Usage: setup-repo.sh <owner/repo> --app <slop-app-slug> [--base main] [--protect [<check> ...]]
set -euo pipefail

# The ruleset body for the base branch: `slop`, active, no deletion or force push, the checks required, with slop's App
# and repository admins allowed to bypass, and the head required to be up to date. Usage: ruleset_json <app-id> <check>...
ruleset_json() {
  python3 - "$@" <<'PY'
import json, sys
app_id, checks = int(sys.argv[1]), sys.argv[2:]
rules = [
    {"type": "deletion"},
    {"type": "non_fast_forward"},
    {"type": "required_status_checks", "parameters": {
        "strict_required_status_checks_policy": True,
        "required_status_checks": [{"context": c} for c in checks]}},
]
print(json.dumps({
    "name": "slop", "target": "branch", "enforcement": "active",
    "conditions": {"ref_name": {"include": ["~DEFAULT_BRANCH"], "exclude": []}},
    "bypass_actors": [
        {"actor_id": app_id, "actor_type": "Integration", "bypass_mode": "always"},
        {"actor_id": 5, "actor_type": "RepositoryRole", "bypass_mode": "always"},
    ],
    "rules": rules,
}))
PY
}
# Sourced by the shell test (catalog/scripts/setup-repo.test.sh) to reach ruleset_json alone.
[[ "${SETUP_REPO_SOURCE_ONLY:-}" == 1 ]] && return 0

repo="${1:-}"; shift || true
app=""; base=""; checks=(); protect=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --app) app="$2"; shift ;;
    --base) base="$2"; shift ;;
    --protect) shift; protect=1; while [[ $# -gt 0 && "$1" != --* ]]; do checks+=("$1"); shift; done; continue ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
  shift
done
[[ -n "$repo" && -n "$app" ]] || { echo "Usage: $0 <owner/repo> --app <slop-app-slug> [--base main] [--protect [<check> ...]]" >&2; exit 1; }
base="${base:-$(gh api "repos/$repo" --jq .default_branch)}"

echo "Merge settings for $repo..."
gh api -X PATCH "repos/$repo" \
  -F allow_squash_merge=true -F allow_merge_commit=false -F allow_rebase_merge=false \
  -f squash_merge_commit_title=PR_TITLE -f squash_merge_commit_message=PR_BODY \
  -F delete_branch_on_merge=true --silent
echo "  squash only, PR title as commit title, merged branches deleted"

[[ $protect -eq 1 && ${#checks[@]} -eq 0 ]] && checks=(checks)
if [[ ${#checks[@]} -gt 0 ]]; then
  echo "Branch ruleset \`slop\` on $base (required: ${checks[*]})..."
  app_id=$(gh api "apps/$app" --jq .id)
  body=$(ruleset_json "$app_id" "${checks[@]}")
  ruleset_id=$(gh api "repos/$repo/rulesets" --jq '.[] | select(.name == "slop") | .id' | head -n1)
  if [[ -n "$ruleset_id" ]]; then
    printf '%s' "$body" | gh api -X PUT "repos/$repo/rulesets/$ruleset_id" --input - --silent
    echo "  updated ruleset $ruleset_id"
  else
    printf '%s' "$body" | gh api -X POST "repos/$repo/rulesets" --input - --silent
    echo "  created ruleset"
  fi
  echo "  required checks pass on an up-to-date head, no force pushes or deletion"
  echo "  slop's App ($app) and repo admins can bypass"
  echo "  Run the checks workflow on pushes to $base too."
  if gh api "repos/$repo/branches/$base/protection" --silent 2>/dev/null; then
    echo "  NOTE: $base also has classic branch protection, which can't exempt slop's App and would block its sub"
    echo "  merges alongside the ruleset. Remove it: gh api -X DELETE repos/$repo/branches/$base/protection"
  fi
  echo "Rules now applying to $base:"
  gh api "repos/$repo/rules/branches/$base" --jq '.[] | "  " + .type + " (ruleset " + (.ruleset_id|tostring) + ")"'
fi

# Keep in step with REQUIRED_APP_EVENTS in slop's apps/server/src/github/setup.ts. GitHub applies a manifest's events
# only when the App is created, so an App made before an event was added never receives it.
required_events=(push pull_request pull_request_review pull_request_review_comment pull_request_review_thread issue_comment check_run check_suite)
echo "GitHub App events for $app..."
if app_json=$(gh api "apps/$app" 2>&1); then
  subscribed=$(printf '%s' "$app_json" | python3 -c 'import json,sys; print("\n".join(json.load(sys.stdin).get("events", [])))')
  missing=()
  for event in "${required_events[@]}"; do
    grep -qx "$event" <<<"$subscribed" || missing+=("$event")
  done
  if [[ ${#missing[@]} -eq 0 ]]; then
    echo "  subscribed to every event slop needs"
  else
    owner_login=$(printf '%s' "$app_json" | python3 -c 'import json,sys; o=json.load(sys.stdin).get("owner") or {}; print(o.get("login","") if o.get("type")=="Organization" else "")')
    if [[ -n "$owner_login" ]]; then settings="https://github.com/organizations/$owner_login/settings/apps/$app/permissions"
    else settings="https://github.com/settings/apps/$app/permissions"; fi
    echo "  NOT subscribed to: ${missing[*]}"
    echo "  Tick them under Permissions & events > Subscribe to events: $settings"
    echo "  (the tick boxes are UI-only; GitHub has no API for them, and a manifest's events apply only when the App is created)"
  fi
else
  echo "  skipped: couldn't read the App's settings ($(printf '%s' "$app_json" | head -n1))"
fi

cat <<EOF2

Install the GitHub Apps on $repo (browser; choose "Only select repositories" and add it):
  slop:   https://github.com/apps/$app/installations/new
  Claude: https://github.com/apps/claude/installations/new   (routines and auto-fix)
EOF2
