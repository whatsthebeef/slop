#!/usr/bin/env bash
# Prepares a GitHub repository for slop, using your gh login.
#   - merge settings: squash only, PR title as the squash commit title, delete merged branches
#   - optional --protect <check>...: branch protection on the base branch (required checks,
#     up to date before merging, no direct pushes); pass `checks` (every PR's lint, type check
#     and tests) and `sub-gate`
#   - checks slop's GitHub App is subscribed to the events slop needs and, for any it isn't, prints the
#     App's settings link (GitHub has no API to subscribe: a person ticks them in the UI)
#   - prints the links to install slop's GitHub App and the Claude GitHub App on the repo
#     (GitHub only allows that in the browser or with a classic personal access token)
# Usage: setup-repo.sh <owner/repo> --app <slop-app-slug> [--base main] [--protect <check> ...]
set -euo pipefail

repo="${1:-}"; shift || true
app=""; base=""; checks=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --app) app="$2"; shift ;;
    --base) base="$2"; shift ;;
    --protect) shift; while [[ $# -gt 0 && "$1" != --* ]]; do checks+=("$1"); shift; done; continue ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
  shift
done
[[ -n "$repo" && -n "$app" ]] || { echo "Usage: $0 <owner/repo> --app <slop-app-slug> [--base main] [--protect <check> ...]" >&2; exit 1; }
base="${base:-$(gh api "repos/$repo" --jq .default_branch)}"

echo "Merge settings for $repo..."
gh api -X PATCH "repos/$repo" \
  -F allow_squash_merge=true -F allow_merge_commit=false -F allow_rebase_merge=false \
  -f squash_merge_commit_title=PR_TITLE -f squash_merge_commit_message=PR_BODY \
  -F delete_branch_on_merge=true --silent
echo "  squash only, PR title as commit title, merged branches deleted"

if [[ ${#checks[@]} -gt 0 ]]; then
  echo "Branch protection on $base (required: ${checks[*]})..."
  contexts=$(printf '%s\n' "${checks[@]}" | python3 -c 'import json,sys; print(json.dumps([l.strip() for l in sys.stdin if l.strip()]))')
  gh api -X PUT "repos/$repo/branches/$base/protection" --input - --silent <<JSON
{"required_status_checks": {"strict": true, "contexts": $contexts},
 "enforce_admins": false, "required_pull_request_reviews": null, "restrictions": null,
 "allow_force_pushes": false, "allow_deletions": false}
JSON
  echo "  required checks pass on the current head, branch up to date, no force pushes"
  echo "  NOTE: subs merge as soon as they're ready, before their PR's checks finish, and slop reverts a sub whose"
  echo "  merge turns $base red. Add the slop GitHub App to a ruleset bypass list for $base (Settings > Rules)"
  echo "  or the required checks will refuse those merges. Run the checks workflow on pushes to $base too."
fi

# Keep in step with REQUIRED_APP_EVENTS in slop's apps/server/src/github/setup.ts. GitHub applies a manifest's events
# only when the App is created, so an App made before an event was added never receives it.
required_events=(push pull_request pull_request_review pull_request_review_comment issue_comment check_run check_suite)
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
