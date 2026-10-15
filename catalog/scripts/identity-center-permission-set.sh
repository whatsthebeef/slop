#!/usr/bin/env bash
# Creates or updates an IAM Identity Center permission set from an inline policy file, attaches managed policies,
# assigns it to a group or user in one account, provisions it, and proves the policy does what you expect with a
# simulation table (iam simulate-custom-policy, before applying against the file and after against the stored policy).
#
# What it changes: the permission set NAME in the Identity Center instance (its description, session duration, inline
#   policy, attached managed policies), one account assignment (permission set + principal + account) and a
#   provisioning of that permission set to the account. It never deletes anything and never detaches a managed policy.
# Permissions and login it needs (the step's text repeats these as its "Permissions:" line):
#   - an AWS session (aws sso login, or any credentials) in the Identity Center management account OR its delegated
#     administrator account; either works
#   - sso-admin: ListInstances, ListPermissionSets, DescribePermissionSet, CreatePermissionSet, UpdatePermissionSet,
#     GetInlinePolicyForPermissionSet, PutInlinePolicyToPermissionSet, ListManagedPoliciesInPermissionSet,
#     AttachManagedPolicyToPermissionSet, ListAccountAssignments, CreateAccountAssignment,
#     DescribeAccountAssignmentCreationStatus, ProvisionPermissionSet, DescribePermissionSetProvisioningStatus,
#     ListAccountsForProvisionedPermissionSet
#   - identitystore: GetGroupId or GetUserId
#   - iam:SimulateCustomPolicy and access-analyzer:ValidatePolicy (the only calls --check makes)
# Usage: identity-center-permission-set.sh --policy FILE [--expectations FILE] [--check] [apply options] [--yes] [--dry-run]
#   --check                    validate and change nothing: policy size, Access Analyzer findings, simulation table.
#                              Needs only --policy (and --expectations); no Identity Center access.
#   --policy FILE              the inline policy JSON (required)
#   --expectations FILE        rows of "allow|deny|xdeny <action> <resource-arn>"; "#" starts a comment.
#                                allow  the action must be allowed on the resource
#                                deny   it must not be allowed (implicit or explicit deny)
#                                xdeny  it must match an explicit Deny statement, so a backstop is proven and not just
#                                       the absence of an Allow
#                              Use the action's real resource type: logs:GetLogEvents is authorised on the log group,
#                              not the log stream, and actions with no resource scoping (for example
#                              cognito-identity:GetCredentialsForIdentity) are an implicit deny against a resource ARN
#                              even when the policy says Resource "*".
#   --name NAME                permission set name (required to apply)
#   --description TEXT         description (default: the name)
#   --session-duration ISO     session duration, ISO 8601 (default PT1H)
#   --managed-policy ARN       managed policy to attach (repeatable)
#   --account ID               account to assign and provision to (required to apply)
#   --group NAME | --user NAME principal to assign (required to apply; one of the two)
#   --region REGION            Identity Center home region (default: AWS_REGION, AWS_DEFAULT_REGION or the CLI's)
#   --instance-arn ARN         Identity Center instance (default: the only organization instance the caller can list;
#                              account instances are skipped because they reject list-permission-sets)
#   --yes                      skip the y/N question (for a person who has already read the summary)
#   --dry-run                  print what would change and stop; changes nothing
# Safe to re-run: every change checks the current state first (the inline policy is put only when it differs, compared
# with jq -S). Never prints a secret.
#
# Example expectations file:
#   # read-only access to the non-prod log groups, nothing on prod
#   allow logs:FilterLogEvents arn:aws:logs:us-east-1:111111111111:log-group:/aws/lambda/app-dev:*
#   deny  logs:PutLogEvents    arn:aws:logs:us-east-1:111111111111:log-group:/aws/lambda/app-dev:*
#   xdeny logs:FilterLogEvents arn:aws:logs:us-east-1:111111111111:log-group:/aws/lambda/app-prod:*
set -euo pipefail

POLICY="" EXPECT="" NAME="" DESCRIPTION="" DURATION="PT1H" ACCOUNT="" GROUP="" USER_NAME="" INSTANCE_ARN=""
REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-}}"
MANAGED=()
CHECK=0 YES=0 DRY=0
MAX_POLICY_CHARS=10240

usage() { sed -n '2,/^set -euo/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//'; }
fail() { echo "error: $*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || fail "$1 is not installed"; }

parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --check) CHECK=1 ;;
      --yes) YES=1 ;;
      --dry-run) DRY=1 ;;
      -h | --help) usage; exit 0 ;;
      --policy | --expectations | --name | --description | --session-duration | --managed-policy | --account | --region | \
        --instance-arn | --group | --user)
        [[ $# -ge 2 ]] || fail "$1 needs a value (try --help)"
        case "$1" in
          --policy) POLICY="$2" ;;
          --expectations) EXPECT="$2" ;;
          --name) NAME="$2" ;;
          --description) DESCRIPTION="$2" ;;
          --session-duration) DURATION="$2" ;;
          --managed-policy) MANAGED+=("$2") ;;
          --account) ACCOUNT="$2" ;;
          --region) REGION="$2" ;;
          --instance-arn) INSTANCE_ARN="$2" ;;
          --group) GROUP="$2" ;;
          --user) USER_NAME="$2" ;;
        esac
        shift
        ;;
      *) echo "unknown argument: $1 (try --help)" >&2; exit 2 ;;
    esac
    shift
  done
}

# aws with the region flag when one was given.
awsr() { if [[ -n "$REGION" ]]; then aws --region "$REGION" "$@"; else aws "$@"; fi; }

# --- 1. Preflight: check every input, permission and login up front, and stop with a plain message when one is missing.
preflight() {
  need aws
  need jq
  [[ -n "$POLICY" ]] || fail "--policy FILE is required (try --help)"
  [[ -r "$POLICY" ]] || fail "cannot read policy file $POLICY"
  jq -e . "$POLICY" >/dev/null 2>&1 || fail "$POLICY is not valid JSON"
  [[ -z "$EXPECT" || -r "$EXPECT" ]] || fail "cannot read expectations file $EXPECT"
  if [[ "$CHECK" != 1 ]]; then
    [[ -n "$NAME" ]] || fail "--name is required to apply (use --check to only validate)"
    [[ -n "$ACCOUNT" ]] || fail "--account is required to apply"
    [[ "$ACCOUNT" =~ ^[0-9]{12}$ ]] || fail "--account must be a 12-digit account id"
    [[ -n "$GROUP" || -n "$USER_NAME" ]] || fail "give the principal to assign with --group NAME or --user NAME"
    [[ -z "$GROUP" || -z "$USER_NAME" ]] || fail "give only one of --group and --user"
    [[ -n "$DESCRIPTION" ]] || DESCRIPTION="$NAME"
  fi
  CALLER="$(aws sts get-caller-identity --query Account --output text 2>/dev/null)" ||
    fail "no AWS login: run 'aws sso login' (management account or Identity Center delegated administrator)"
  echo "AWS account: $CALLER"
}

# Characters that count against the inline policy limit: everything but whitespace.
policy_chars() { tr -d '[:space:]' <"$POLICY" | wc -c | tr -d ' '; }

check_size() {
  local n
  n="$(policy_chars)"
  echo "Policy size: $n of $MAX_POLICY_CHARS non-whitespace characters"
  [[ "$n" -le "$MAX_POLICY_CHARS" ]] ||
    fail "the inline policy has $n non-whitespace characters; Identity Center allows $MAX_POLICY_CHARS"
}

# Access Analyzer rejects bare resource patterns such as "*Prod*" (MISSING_ARN_FIELD): write "arn:aws:*:*:*:*Prod*".
check_analyzer() {
  local findings errors
  findings="$(awsr accessanalyzer validate-policy --policy-type IDENTITY_POLICY --policy-document "file://$POLICY" \
    --query 'findings[].[findingType,issueCode,findingDetails]' --output json)" ||
    fail "access-analyzer validate-policy failed (does the login allow access-analyzer:ValidatePolicy?)"
  errors="$(jq -r '[.[] | select(.[0] == "ERROR")] | length' <<<"$findings")"
  jq -r '.[] | select(.[0] != "ERROR") | "Access Analyzer \(.[0]) \(.[1]): \(.[2])"' <<<"$findings" >&2
  if [[ "$errors" != 0 ]]; then
    jq -r '.[] | select(.[0] == "ERROR") | "  ERROR \(.[1]): \(.[2])"' <<<"$findings" >&2
    fail "Access Analyzer reports $errors error(s) in $POLICY"
  fi
  echo "Access Analyzer: no errors"
}

# --- 2. The simulation table. simulate FILE-OR-JSON-POLICY LABEL: one row per expectation, fails when any row differs.
simulate() {
  local policy_json="$1" label="$2" kind action resource want request decision got verdict bad=0 total=0
  [[ -n "$EXPECT" ]] || { echo "No expectations file: simulation skipped ($label)"; return 0; }
  echo
  echo "Simulation against $label"
  printf '%-7s %-14s %-9s %s\n' EXPECT GOT RESULT "ACTION  RESOURCE"
  while read -r kind action resource _ || [[ -n "$kind" ]]; do
    [[ -z "$kind" || "$kind" == \#* ]] && continue
    case "$kind" in allow | deny | xdeny) ;; *) fail "bad expectation row (want allow|deny|xdeny <action> <resource-arn>): $kind $action $resource" ;; esac
    [[ -n "$action" && -n "$resource" ]] || fail "bad expectation row (action and resource-arn are required): $kind $action $resource"
    request="$(jq -n --arg p "$policy_json" --arg a "$action" --arg r "$resource" \
      '{PolicyInputList: [$p], ActionNames: [$a], ResourceArns: [$r]}')"
    decision="$(awsr iam simulate-custom-policy --cli-input-json "$request" \
      --query 'EvaluationResults[0].EvalDecision' --output text </dev/null)" ||
      fail "simulate-custom-policy failed for $action $resource (does the login allow iam:SimulateCustomPolicy?)"
    got="$decision"
    case "$kind" in
      allow) [[ "$got" == allowed ]] && verdict=ok || verdict=FAIL ;;
      deny) [[ "$got" == implicitDeny || "$got" == explicitDeny ]] && verdict=ok || verdict=FAIL ;;
      xdeny) [[ "$got" == explicitDeny ]] && verdict=ok || verdict=FAIL ;;
    esac
    total=$((total + 1))
    [[ "$verdict" == ok ]] || bad=$((bad + 1))
    printf '%-7s %-14s %-9s %s  %s\n' "$kind" "$got" "$verdict" "$action" "$resource"
  done <"$EXPECT"
  echo "$((total - bad)) of $total expectations hold"
  [[ "$bad" == 0 ]] || return 1
}

# --- 3. Identity Center lookups (read-only).
find_instance() {
  local arns arn ok=()
  if [[ -n "$INSTANCE_ARN" ]]; then return 0; fi
  arns="$(awsr sso-admin list-instances --query 'Instances[].InstanceArn' --output text)" ||
    fail "cannot list Identity Center instances (is the login the management or delegated administrator account?)"
  for arn in $arns; do
    # Account instances reject list-permission-sets, so only organization instances pass.
    if awsr sso-admin list-permission-sets --instance-arn "$arn" --max-items 1 >/dev/null 2>&1; then ok+=("$arn"); fi
  done
  [[ "${#ok[@]}" -ge 1 ]] || fail "no organization Identity Center instance is visible to this login; pass --instance-arn"
  [[ "${#ok[@]}" -eq 1 ]] || fail "several Identity Center instances are visible (${ok[*]}); pass --instance-arn"
  INSTANCE_ARN="${ok[0]}"
}

find_permission_set() {
  local arn found
  PS_ARN=""
  for arn in $(awsr sso-admin list-permission-sets --instance-arn "$INSTANCE_ARN" --query 'PermissionSets[]' --output text); do
    found="$(awsr sso-admin describe-permission-set --instance-arn "$INSTANCE_ARN" --permission-set-arn "$arn" \
      --query 'PermissionSet.[Name,Description,SessionDuration]' --output json)"
    if [[ "$(jq -r '.[0]' <<<"$found")" == "$NAME" ]]; then
      PS_ARN="$arn"
      PS_DESC="$(jq -r '.[1] // ""' <<<"$found")"
      PS_DURATION="$(jq -r '.[2] // ""' <<<"$found")"
      return 0
    fi
  done
}

stored_policy() {
  awsr sso-admin get-inline-policy-for-permission-set --instance-arn "$INSTANCE_ARN" --permission-set-arn "$PS_ARN" \
    --query 'InlinePolicy' --output text | sed 's/^None$//'
}

# identitystore get-group-id needs JSON for --alternate-identifier: the CLI's shorthand can't express AttributeValue.
resolve_principal() {
  local store attr value
  store="$(awsr sso-admin list-instances --query "Instances[?InstanceArn=='$INSTANCE_ARN'].IdentityStoreId | [0]" --output text)"
  [[ -n "$store" && "$store" != None ]] || fail "cannot find the identity store of $INSTANCE_ARN"
  if [[ -n "$GROUP" ]]; then
    PRINCIPAL_TYPE=GROUP
    value="$GROUP"
    PRINCIPAL_ID="$(awsr identitystore get-group-id --identity-store-id "$store" \
      --alternate-identifier "$(jq -nc --arg v "$value" '{UniqueAttribute: {AttributePath: "displayName", AttributeValue: $v}}')" \
      --query GroupId --output text)" || fail "group '$value' not found in the identity store"
  else
    PRINCIPAL_TYPE=USER
    value="$USER_NAME"
    PRINCIPAL_ID="$(awsr identitystore get-user-id --identity-store-id "$store" \
      --alternate-identifier "$(jq -nc --arg v "$value" '{UniqueAttribute: {AttributePath: "userName", AttributeValue: $v}}')" \
      --query UserId --output text)" || fail "user '$value' not found in the identity store"
  fi
  attr="$PRINCIPAL_TYPE $value"
  echo "Principal: $attr ($PRINCIPAL_ID)"
}

# --- 4. What will change: read-only. Sets the NEED_* flags that apply() follows.
summary() {
  local current attached stale p
  NEED_CREATE=0 NEED_UPDATE=0 NEED_POLICY=0 NEED_ASSIGN=0 NEED_PROVISION=0
  NEED_MANAGED=()
  find_permission_set
  resolve_principal
  echo
  echo "This will:"
  if [[ -z "$PS_ARN" ]]; then
    NEED_CREATE=1 NEED_POLICY=1 NEED_ASSIGN=1 NEED_PROVISION=1
    for p in ${MANAGED[@]+"${MANAGED[@]}"}; do NEED_MANAGED+=("$p"); done
    echo "  - create permission set $NAME (session duration $DURATION)"
    echo "  - put the inline policy from $POLICY"
    for p in ${MANAGED[@]+"${MANAGED[@]}"}; do echo "  - attach managed policy $p"; done
    echo "  - assign it to ${GROUP:+group $GROUP}${USER_NAME:+user $USER_NAME} in account $ACCOUNT"
    echo "  - provision it to account $ACCOUNT"
    return 0
  fi
  echo "  - permission set $NAME exists ($PS_ARN)"
  if [[ "$PS_DESC" != "$DESCRIPTION" || "$PS_DURATION" != "$DURATION" ]]; then
    NEED_UPDATE=1 NEED_PROVISION=1
    echo "  - update its description/session duration (now: '$PS_DESC', $PS_DURATION)"
  fi
  current="$(stored_policy)"
  if [[ -n "$current" && "$(jq -S . <<<"$current")" == "$(jq -S . "$POLICY")" ]]; then
    echo "  - inline policy already matches $POLICY: nothing to put"
  else
    NEED_POLICY=1 NEED_PROVISION=1
    echo "  - put the inline policy from $POLICY (it differs from the stored one)"
  fi
  attached="$(awsr sso-admin list-managed-policies-in-permission-set --instance-arn "$INSTANCE_ARN" \
    --permission-set-arn "$PS_ARN" --query 'AttachedManagedPolicies[].Arn' --output text)"
  for p in ${MANAGED[@]+"${MANAGED[@]}"}; do
    if [[ " $attached " == *" $p "* ]]; then
      echo "  - managed policy $p already attached"
    else
      NEED_MANAGED+=("$p") NEED_PROVISION=1
      echo "  - attach managed policy $p"
    fi
  done
  if [[ "$(awsr sso-admin list-account-assignments --instance-arn "$INSTANCE_ARN" --account-id "$ACCOUNT" \
    --permission-set-arn "$PS_ARN" --query "AccountAssignments[?PrincipalId=='$PRINCIPAL_ID'] | length(@)" --output text)" == 0 ]]; then
    NEED_ASSIGN=1
    echo "  - assign it to ${GROUP:+group $GROUP}${USER_NAME:+user $USER_NAME} in account $ACCOUNT"
  else
    echo "  - already assigned to ${GROUP:+group $GROUP}${USER_NAME:+user $USER_NAME} in account $ACCOUNT"
  fi
  stale="$(awsr sso-admin list-accounts-for-provisioned-permission-set --instance-arn "$INSTANCE_ARN" --permission-set-arn "$PS_ARN" \
    --provisioning-status LATEST_PERMISSION_SET_NOT_PROVISIONED --query 'AccountIds' --output text)"
  if [[ " $stale " == *"$ACCOUNT"* ]]; then NEED_PROVISION=1; fi
  if [[ "$NEED_PROVISION" == 1 ]]; then echo "  - provision it to account $ACCOUNT"; else echo "  - already provisioned to account $ACCOUNT"; fi
}

# Wait for an asynchronous request: wait_status "<describe command...>" <jq-free query for Status>.
wait_status() {
  local what="$1" status i
  shift
  for i in $(seq 1 60); do
    status="$("$@")"
    case "$status" in
      SUCCEEDED) echo "  $what: SUCCEEDED"; return 0 ;;
      FAILED) fail "$what failed (see the Identity Center console for the reason)" ;;
    esac
    sleep 5
  done
  fail "$what did not finish in 5 minutes"
}

# --- 5. The changes: idempotent, so a second run finds nothing to do.
apply() {
  local p req
  if [[ "$NEED_CREATE" == 1 ]]; then
    PS_ARN="$(awsr sso-admin create-permission-set --instance-arn "$INSTANCE_ARN" --name "$NAME" --description "$DESCRIPTION" \
      --session-duration "$DURATION" --query 'PermissionSet.PermissionSetArn' --output text)"
    echo "Created permission set $NAME"
  elif [[ "$NEED_UPDATE" == 1 ]]; then
    awsr sso-admin update-permission-set --instance-arn "$INSTANCE_ARN" --permission-set-arn "$PS_ARN" \
      --description "$DESCRIPTION" --session-duration "$DURATION"
    echo "Updated description and session duration"
  fi
  if [[ "$NEED_POLICY" == 1 ]]; then
    awsr sso-admin put-inline-policy-to-permission-set --instance-arn "$INSTANCE_ARN" --permission-set-arn "$PS_ARN" \
      --inline-policy "$(jq -c . "$POLICY")"
    echo "Put the inline policy"
  fi
  for p in ${NEED_MANAGED[@]+"${NEED_MANAGED[@]}"}; do
    awsr sso-admin attach-managed-policy-to-permission-set --instance-arn "$INSTANCE_ARN" --permission-set-arn "$PS_ARN" \
      --managed-policy-arn "$p"
    echo "Attached $p"
  done
  if [[ "$NEED_ASSIGN" == 1 ]]; then
      req="$(awsr sso-admin create-account-assignment --instance-arn "$INSTANCE_ARN" --permission-set-arn "$PS_ARN" \
      --principal-type "$PRINCIPAL_TYPE" --principal-id "$PRINCIPAL_ID" --target-type AWS_ACCOUNT --target-id "$ACCOUNT" \
      --query 'AccountAssignmentCreationStatus.RequestId' --output text)"
    wait_status "assignment" awsr sso-admin describe-account-assignment-creation-status --instance-arn "$INSTANCE_ARN" \
      --account-assignment-creation-request-id "$req" --query 'AccountAssignmentCreationStatus.Status' --output text
  fi
  if [[ "$NEED_PROVISION" == 1 ]]; then
    req="$(awsr sso-admin provision-permission-set --instance-arn "$INSTANCE_ARN" --permission-set-arn "$PS_ARN" \
      --target-type AWS_ACCOUNT --target-id "$ACCOUNT" --query 'PermissionSetProvisioningStatus.RequestId' --output text)"
    wait_status "provisioning" awsr sso-admin describe-permission-set-provisioning-status --instance-arn "$INSTANCE_ARN" \
      --provision-permission-set-request-id "$req" --query 'PermissionSetProvisioningStatus.Status' --output text
  fi
}

# --- 6. Final check: the same expectations, now against the policy stored in the set.
verify() {
  local stored
  stored="$(stored_policy)"
  [[ -n "$stored" ]] || fail "the permission set has no inline policy after the change"
  if [[ "$(jq -S . <<<"$stored")" == "$(jq -S . "$POLICY")" ]]; then
    echo "Stored inline policy matches $POLICY"
  else
    fail "the stored inline policy differs from $POLICY after the change"
  fi
  simulate "$stored" "the policy stored in $NAME" || fail "the stored policy does not meet the expectations"
  echo "Permission set $NAME ($PS_ARN) is in place for account $ACCOUNT"
}

parse_args "$@"
preflight
check_size
check_analyzer
policy_json="$(jq -c . "$POLICY")"
simulate "$policy_json" "$POLICY" || fail "the policy file does not meet the expectations; nothing was changed"
if [[ "$CHECK" == 1 ]]; then
  echo "(check only: nothing changed)"
  exit 0
fi
find_instance
echo "Identity Center instance: $INSTANCE_ARN"
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
