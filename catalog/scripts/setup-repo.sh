#!/usr/bin/env bash
# Prepares a GitHub repository for slop, using your gh login.
#   - merge settings: squash only, PR title as the squash commit title, delete merged branches
#   - optional --protect <check>...: branch protection on the base branch (required checks,
#     up to date before merging, no direct pushes); pass `checks` (every PR's lint, type check
#     and tests) and `sub-gate`
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

cat <<EOF2

Install the GitHub Apps on $repo (browser; choose "Only select repositories" and add it):
  slop:   https://github.com/apps/$app/installations/new
  Claude: https://github.com/apps/claude/installations/new   (routines and auto-fix)
EOF2
