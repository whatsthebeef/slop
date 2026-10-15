#!/usr/bin/env bash
# TEMPLATE for a rollout step's script: copy it to scripts/rollout/<glob-id>-<slug>.sh (or, for a repo-wide action any
# board needs, catalog/scripts/), replace the TODOs and keep the shape below. See the implementer's "Scripts for steps".
#
# What it does: TODO one sentence, e.g. "Creates the `slop` ruleset on main".
# What it changes: TODO exactly what, and where (repo, AWS account and region, board).
# Permissions and login it needs (the step's text repeats these as its "Permissions:" line):
#   - TODO e.g. gh logged in (gh auth login) as an admin of OWNER/REPO
#   - TODO e.g. AWS session in account 123456789012, region us-east-1 (aws sso login), allowed to use SSM and CodeBuild
# Usage: step-template.sh [--yes] [--dry-run]
#   --yes      skip the y/N question (for a person who has already read the summary)
#   --dry-run  print what would change and stop; changes nothing
# Safe to re-run: every change below checks the current state first. Never print secrets.
set -euo pipefail

YES=0
DRY=0
for arg in "$@"; do
  case "$arg" in
    --yes) YES=1 ;;
    --dry-run) DRY=1 ;;
    -h | --help) sed -n '2,/^set -euo/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown argument: $arg (try --help)" >&2; exit 2 ;;
  esac
done

fail() { echo "error: $*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || fail "$1 is not installed"; }

# --- 1. Preflight: check every permission and login up front, and stop with a plain message when one is missing.
preflight() {
  need gh
  gh auth status >/dev/null 2>&1 || fail "gh is not logged in: run 'gh auth login'"
  # GitHub admin rights on a repo:   [[ "$(gh api "repos/$REPO" --jq .permissions.admin)" == true ]] || fail "you need admin rights on $REPO"
  # AWS login, account and region:   need aws; [[ "$(aws sts get-caller-identity --query Account --output text)" == "$EXPECTED_ACCOUNT" ]] || fail "log in to AWS account $EXPECTED_ACCOUNT (aws sso login)"
  # slop board role:                 check the board role the step needs (slop whoami) and say which one is missing
}

# --- 2. What will change: read-only. Print the current state and what this run will do about it.
summary() {
  echo "This will:"
  echo "  - TODO describe each change, and say which ones are already done"
}

# --- 3. The changes: idempotent, so a second run finds nothing to do.
apply() {
  echo "TODO make the changes"
}

# --- 4. Final check: print what proves it worked (not a secret).
verify() {
  echo "TODO print the state that shows it worked"
}

preflight
summary
if [[ "$DRY" == 1 ]]; then
  echo "(dry run: nothing changed)"
  exit 0
fi
if [[ "$YES" != 1 ]]; then
  read -r -p "Go ahead? [y/N] " answer
  [[ "$answer" =~ ^[Yy]$ ]] || { echo "Nothing changed."; exit 0; }
fi
apply
verify
