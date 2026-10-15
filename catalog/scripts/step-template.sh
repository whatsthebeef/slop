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
#   --dry-run  run the pre-checks, print what would change and stop; changes nothing
# Pre-checks: before any change the script tries what it is about to do in a way that leaves nothing behind (IAM policy
#   under a temporary name, CloudFormation change set, buildspec and policy validation) and stops with a plain message
#   if one fails. Temporary resources are deleted on any exit. A step that cannot be pre-checked says so in its summary.
# Safe to re-run: every change below checks the current state first. Never print secrets.
set -euo pipefail

YES=0
DRY=0

fail() { echo "error: $*" >&2; exit 1; }   # inside $(...) this only leaves the subshell: check the result instead
need() { command -v "$1" >/dev/null 2>&1 || fail "$1 is not installed"; }

# --- Cleanup registry: a temporary resource registers the command that deletes it, and the trap runs them (newest
# first) on any exit: success, failure or Ctrl-C. Values are expanded when the command is registered (printf %q), never
# when the trap fires, so a later change to a variable can't make the cleanup delete something else.
CLEANUP=()
CLEANED=0
CLEANUP_LAST=0
cleanup_add() { # cleanup_add command [args...]; sets CLEANUP_LAST to the entry's index
  local entry
  entry=$(printf '%q ' "$@")
  CLEANUP[${#CLEANUP[@]}]="$entry"
  CLEANUP_LAST=$((${#CLEANUP[@]} - 1))
}
cleanup_done() { CLEANUP[$1]=""; }          # the resource is already gone: drop its entry
cleanup() {
  [[ "$CLEANED" == 1 ]] && return 0
  CLEANED=1
  local i=${#CLEANUP[@]} entry
  while [[ "$i" -gt 0 ]]; do
    i=$((i - 1))
    entry="${CLEANUP[$i]}"
    [[ -n "$entry" ]] || continue
    eval "$entry" >/dev/null 2>&1 || echo "warning: could not clean up: $entry" >&2
  done
  return 0
}

# --- Helpers for pre-checks. Each fails with a plain message and leaves nothing behind.

# lint_arn ARN: returns 0 for a well-formed ARN (wildcards allowed inside a segment), 1 otherwise. A bare "*" is not an ARN.
lint_arn() {
  local re='^arn:aws(-cn|-us-gov)?:[a-z0-9*-]+:[a-z0-9*-]*:([0-9]{12}|aws|\*)?:[^[:space:]]+$'
  [[ "${1:-}" =~ $re ]]
}

# precheck_policy_json FILE: valid JSON with Version and Statement, and every Resource an ARN (or "*").
precheck_policy_json() {
  local file="$1" arns arn
  [[ -f "$file" ]] || fail "policy file not found: $file"
  need python3
  arns=$(python3 - "$file" <<'PY' 2>&1
import json, sys
try:
    doc = json.load(open(sys.argv[1]))
except ValueError as e:
    sys.exit("not valid JSON: %s" % e)
if not isinstance(doc, dict) or "Version" not in doc or "Statement" not in doc:
    sys.exit("missing Version or Statement")
stmts = doc["Statement"] if isinstance(doc["Statement"], list) else [doc["Statement"]]
for s in stmts:
    r = s.get("Resource", [])
    for x in (r if isinstance(r, list) else [r]):
        print(x)
PY
  ) || fail "policy $file is not usable: $arns"
  while IFS= read -r arn; do
    [[ -z "$arn" || "$arn" == "*" ]] && continue
    lint_arn "$arn" || fail "policy $file has a malformed resource ARN: $arn"
  done <<EOF
$arns
EOF
}

# iam_temp_policy_create FILE: creates the policy under the temporary name slop-precheck-<pid>, sets TEMP_POLICY_ARN and
# registers its deletion. iam_temp_policy_delete deletes it now (a failed delete stays registered for the trap).
iam_temp_policy_create() {
  local out
  out=$(aws iam create-policy --policy-name "slop-precheck-$$" --policy-document "file://$1" \
    --query Policy.Arn --output text 2>&1) || fail "IAM rejected the policy $1 (nothing was created): $out"
  TEMP_POLICY_ARN="$out"
  cleanup_add aws iam delete-policy --policy-arn "$TEMP_POLICY_ARN"
  TEMP_POLICY_ENTRY=$CLEANUP_LAST
}
iam_temp_policy_delete() {
  if aws iam delete-policy --policy-arn "$TEMP_POLICY_ARN" >/dev/null 2>&1; then
    cleanup_done "$TEMP_POLICY_ENTRY"
  else
    echo "warning: could not delete the temporary policy $TEMP_POLICY_ARN yet; it will be retried on exit" >&2
  fi
}
# precheck_iam_policy FILE: lints the JSON and ARNs, lets IAM validate the policy by creating it, then deletes it.
precheck_iam_policy() {
  precheck_policy_json "$1"
  iam_temp_policy_create "$1"
  iam_temp_policy_delete
}

# delete_review_stack STACK: deletes the stack only if it is stuck in REVIEW_IN_PROGRESS (an empty stack a CREATE change
# set leaves behind). Register it with cleanup_add before creating a change set for a new stack.
delete_review_stack() {
  local status
  status=$(aws cloudformation describe-stacks --stack-name "$1" --query 'Stacks[0].StackStatus' --output text 2>/dev/null) || return 0
  [[ "$status" == REVIEW_IN_PROGRESS ]] || return 0
  aws cloudformation delete-stack --stack-name "$1"
}

# cfn_change_set_create STACK TEMPLATE_FILE [create-change-set args]: creates an UPDATE change set named
# slop-precheck-<pid>, registers its deletion and sets CHANGE_SET_ENTRY. Templates over 51,200 bytes need S3 (--template-url).
cfn_change_set_create() {
  local stack="$1" template="$2" out
  shift 2
  out=$(aws cloudformation create-change-set --stack-name "$stack" --change-set-name "slop-precheck-$$" \
    --change-set-type UPDATE --template-body "file://$template" ${@+"$@"} 2>&1) \
    || fail "CloudFormation refused the change set for $stack (nothing was changed): $out"
  cleanup_add aws cloudformation delete-change-set --stack-name "$stack" --change-set-name "slop-precheck-$$"
  CHANGE_SET_ENTRY=$CLEANUP_LAST
}
# precheck_cfn_change_set STACK TEMPLATE_FILE [create-change-set args, e.g. --parameters ... --capabilities ...]:
# existing stack: create a change set, wait, describe, delete it. New stack: validate-template only (no stack is made).
# "The submitted information didn't contain changes" is not a failure.
precheck_cfn_change_set() {
  local stack="$1" template="$2" status reason out
  [[ -f "$template" ]] || fail "template not found: $template"
  if ! aws cloudformation describe-stacks --stack-name "$stack" >/dev/null 2>&1; then
    out=$(aws cloudformation validate-template --template-body "file://$template" 2>&1) \
      || fail "CloudFormation says the template $template is invalid (nothing was changed): $out"
    return 0
  fi
  cfn_change_set_create "$@"
  if ! aws cloudformation wait change-set-create-complete --stack-name "$stack" --change-set-name "slop-precheck-$$" >/dev/null 2>&1; then
    out=$(aws cloudformation describe-change-set --stack-name "$stack" --change-set-name "slop-precheck-$$" \
      --query '[Status,StatusReason]' --output text 2>&1) || fail "could not read the change set for $stack: $out"
    status=${out%%$'\t'*}
    reason=${out#*$'\t'}
    case "$reason" in
      *"didn't contain changes"* | *"No updates"*) ;;
      *) fail "CloudFormation cannot apply the template to $stack (nothing was changed): $status $reason" ;;
    esac
  fi
  if aws cloudformation delete-change-set --stack-name "$stack" --change-set-name "slop-precheck-$$" >/dev/null 2>&1; then
    cleanup_done "$CHANGE_SET_ENTRY"
  fi
}

# precheck_buildspec FILE: exists, no tab indentation, has version and phases, and parses as YAML where PyYAML is installed.
precheck_buildspec() {
  local file="$1" tab
  tab=$(printf '\t')
  [[ -f "$file" ]] || fail "buildspec not found: $file"
  ! grep -q "^$tab" "$file" || fail "buildspec $file is indented with tabs (YAML needs spaces)"
  grep -q '^version:' "$file" || fail "buildspec $file has no top-level 'version:'"
  grep -q '^phases:' "$file" || fail "buildspec $file has no top-level 'phases:'"
  if command -v python3 >/dev/null 2>&1 && python3 -c 'import yaml' >/dev/null 2>&1; then
    python3 -c 'import sys, yaml; yaml.safe_load(open(sys.argv[1]))' "$file" >/dev/null 2>&1 || fail "buildspec $file is not valid YAML"
  fi
}

# --- 1. Preflight: check every permission and login up front, and stop with a plain message when one is missing.
preflight() {
  need gh
  gh auth status >/dev/null 2>&1 || fail "gh is not logged in: run 'gh auth login'"
  # GitHub admin rights on a repo:   [[ "$(gh api "repos/$REPO" --jq .permissions.admin)" == true ]] || fail "you need admin rights on $REPO"
  # AWS login, account and region:   need aws; [[ "$(aws sts get-caller-identity --query Account --output text)" == "$EXPECTED_ACCOUNT" ]] || fail "log in to AWS account $EXPECTED_ACCOUNT (aws sso login)"
  # slop board role:                 check the board role the step needs (slop whoami) and say which one is missing
}

# --- 2. Pre-checks: try what apply() will do without keeping any of it. Runs before the summary and the y/N question,
# and also under --dry-run. Anything it creates is registered for cleanup. Say in the summary which change cannot be
# tried this way (and why), so the person knows it is unchecked.
precheck() {
  echo "TODO pre-check each change; for example:"
  # precheck_iam_policy policy.json
  # precheck_cfn_change_set my-stack stacks/my-stack.yaml --parameters ParameterKey=Env,ParameterValue=staging --capabilities CAPABILITY_IAM
  # precheck_buildspec buildspec.yml
  # lint_arn "$ROLE_ARN" || fail "not a valid ARN: $ROLE_ARN"
}

# --- 3. What will change: read-only. Print the current state and what this run will do about it.
summary() {
  echo "This will:"
  echo "  - TODO describe each change, and say which ones are already done"
}

# --- 4. The changes: idempotent, so a second run finds nothing to do.
apply() {
  echo "TODO make the changes"
}

# --- 5. Final check: print what proves it worked (not a secret).
verify() {
  echo "TODO print the state that shows it worked"
}

main() {
  local arg answer
  for arg in "$@"; do
    case "$arg" in
      --yes) YES=1 ;;
      --dry-run) DRY=1 ;;
      -h | --help) sed -n '2,/^set -euo/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//'; exit 0 ;;
      *) echo "unknown argument: $arg (try --help)" >&2; exit 2 ;;
    esac
  done
  trap cleanup EXIT            # runs the registry on any exit, including a failed pre-check
  trap 'exit 130' INT          # a signal exits, which runs the EXIT trap
  trap 'exit 143' TERM
  preflight
  precheck
  summary
  if [[ "$DRY" == 1 ]]; then
    echo "(dry run: pre-checks passed, nothing changed)"
    exit 0
  fi
  if [[ "$YES" != 1 ]]; then
    read -r -p "Go ahead? [y/N] " answer
    [[ "$answer" =~ ^[Yy]$ ]] || { echo "Nothing changed."; exit 0; }
  fi
  apply
  verify
}

# A test sources this file to call the helpers; the guard keeps the main flow from running then.
if [[ "${STEP_TEMPLATE_SOURCE_ONLY:-}" == 1 ]]; then
  return 0 2>/dev/null || exit 0
fi
main "$@"
