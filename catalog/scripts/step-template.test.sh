#!/usr/bin/env bash
# Checks the pre-check phase of step-template.sh with a stubbed `aws` (no AWS call is ever made).
# Run: bash catalog/scripts/step-template.test.sh
set -uo pipefail
cd "$(dirname "$0")"
HERE=$(pwd)
T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT
FAILS=0
ok() { echo "ok   $1"; }
bad() { echo "FAIL $1"; FAILS=$((FAILS + 1)); }
check() { # check "name" command...
  local name="$1"
  shift
  if "$@"; then ok "$name"; else bad "$name"; fi
}
logged() { grep -q -- "$1" "$AWS_LOG"; }
not_logged() { ! grep -q -- "$1" "$AWS_LOG"; }

# --- Syntax and shellcheck
check "bash -n step-template.sh" bash -n ./step-template.sh
if command -v shellcheck >/dev/null 2>&1; then
  check "shellcheck step-template.sh" shellcheck -x -e SC2034 ./step-template.sh
else
  echo "skip shellcheck (not installed)"
fi

# --- Stub aws: logs every call to $AWS_LOG; STUB_* variables choose what it answers.
mkdir "$T/bin"
cat >"$T/bin/aws" <<'STUB'
#!/usr/bin/env bash
echo "$*" >>"$AWS_LOG"
case "$1 $2" in
  "iam create-policy")
    if [[ "${STUB_IAM_FAIL:-}" == 1 ]]; then echo "MalformedPolicyDocument: bad" >&2; exit 254; fi
    echo "arn:aws:iam::123456789012:policy/slop-precheck-stub" ;;
  "cloudformation describe-stacks")
    [[ "${STUB_STACK:-exists}" == missing ]] && { echo "does not exist" >&2; exit 255; }
    echo "${STUB_STACK_STATUS:-UPDATE_COMPLETE}" ;;
  "cloudformation wait") [[ "${STUB_WAIT_FAIL:-}" == 1 ]] && exit 255; exit 0 ;;
  "cloudformation describe-change-set") printf '%s\t%s\n' "${STUB_CS_STATUS:-FAILED}" "${STUB_CS_REASON:-}" ;;
  "cloudformation validate-template") [[ "${STUB_VALIDATE_FAIL:-}" == 1 ]] && { echo "Template format error" >&2; exit 254; }; exit 0 ;;
esac
exit 0
STUB
chmod +x "$T/bin/aws"
export PATH="$T/bin:$PATH"
export AWS_LOG="$T/aws.log"

printf '%s\n' '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":"s3:GetObject","Resource":"arn:aws:s3:::bucket/*"}]}' >"$T/good.json"
printf '%s\n' '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":"s3:GetObject","Resource":"bucket/*"}]}' >"$T/badarn.json"
printf '%s\n' 'not json' >"$T/notjson.json"
printf '%s\n' 'AWSTemplateFormatVersion: "2010-09-09"' >"$T/tpl.yaml"
printf '%s\n' 'version: 0.2' 'phases:' '  build:' '    commands:' '      - echo hi' >"$T/buildspec.yml"
printf '%s\n' 'version: 0.2' 'phases:' "$(printf '\tbuild:')" >"$T/buildspec-tab.yml"

# run_main "name" "overrides" args...: sources the template in a subshell, applies the overrides, runs main. Sets OUT and RC.
run_main() {
  local overrides="$1"
  shift
  : >"$AWS_LOG"
  rm -f "$T/applied"
  OUT=$(
    exec 2>&1
    export STEP_TEMPLATE_SOURCE_ONLY=1
    # shellcheck disable=SC1091
    source "$HERE/step-template.sh"
    preflight() { :; }
    apply() { touch "$T/applied"; }
    summary() { echo "summary"; }
    verify() { :; }
    eval "$overrides"
    main "$@"
  )
  RC=$?
}

# --- lint_arn
(
  export STEP_TEMPLATE_SOURCE_ONLY=1
  # shellcheck disable=SC1091
  source "$HERE/step-template.sh"
  for a in 'arn:aws:s3:::bucket/*' 'arn:aws:iam::123456789012:role/app-dev' 'arn:aws:logs:us-east-1:123456789012:log-group:/aws/lambda/x:*' \
    'arn:aws:iam::aws:policy/ReadOnlyAccess' 'arn:aws-us-gov:sns:*:123456789012:topic'; do
    lint_arn "$a" || { echo "should accept: $a" >&2; exit 1; }
  done
  for a in '' '*' 'bucket/*' 'arn:aws:s3' 'arn:aws::::x' 'arn:aws:iam::12345:role/x' 'arn:aws:iam::123456789012:' 'arn:aws:s3:::has space' 'arn:foo:s3:::b'; do
    ! lint_arn "$a" || { echo "should reject: [$a]" >&2; exit 1; }
  done
)
check "lint_arn accepts well-formed and rejects malformed ARNs" test $? -eq 0

# --- failed pre-check stops before apply, with a plain message
run_main 'precheck() { precheck_policy_json "$T/badarn.json"; }' --yes
check "bad ARN in policy: exit 1, message, apply not run" test "$RC" -eq 1 -a ! -e "$T/applied"
check "bad ARN message is plain" grep -q 'malformed resource ARN: bucket/\*' <<<"$OUT"
run_main 'precheck() { precheck_policy_json "$T/notjson.json"; }' --yes
check "invalid JSON stops before apply" test "$RC" -eq 1 -a ! -e "$T/applied"
STUB_IAM_FAIL=1 run_main 'precheck() { precheck_iam_policy "$T/good.json"; }' --yes
check "IAM rejection stops before apply" test "$RC" -eq 1 -a ! -e "$T/applied"
check "IAM rejection message carries the AWS reason" grep -q 'IAM rejected the policy.*MalformedPolicyDocument' <<<"$OUT"
run_main 'precheck() { precheck_buildspec "$T/buildspec-tab.yml"; }' --yes
check "buildspec with tabs stops before apply" test "$RC" -eq 1 -a ! -e "$T/applied"
run_main 'precheck() { precheck_buildspec "$T/buildspec.yml"; }' --yes
check "valid buildspec passes and apply runs" test "$RC" -eq 0 -a -e "$T/applied"

# --- the temporary policy is created under a temporary name and deleted
run_main 'precheck() { precheck_iam_policy "$T/good.json"; }' --yes
check "IAM pre-check passes, then apply runs" test "$RC" -eq 0 -a -e "$T/applied"
check "IAM temp policy is created under slop-precheck-<pid>" logged 'iam create-policy --policy-name slop-precheck-[0-9]'
check "IAM temp policy is deleted" logged 'iam delete-policy --policy-arn arn:aws:iam::123456789012:policy/slop-precheck-stub'

# --- the trap deletes temporary resources on a failure after they were created
run_main 'precheck() { iam_temp_policy_create "$T/good.json"; cfn_change_set_create my-stack "$T/tpl.yaml"; fail boom; }' --yes
check "failure after creating temp resources: exit 1, apply not run" test "$RC" -eq 1 -a ! -e "$T/applied"
check "trap deletes the temporary policy" logged 'iam delete-policy --policy-arn arn:aws:iam::123456789012:policy/slop-precheck-stub'
check "trap deletes the change set" logged 'cloudformation delete-change-set --stack-name my-stack --change-set-name slop-precheck-[0-9]'
run_main 'precheck() { iam_temp_policy_create "$T/good.json"; sh -c "kill -TERM \$PPID"; sleep 5; }' --yes
check "SIGTERM also runs the cleanup" logged 'iam delete-policy'
STUB_STACK_STATUS=REVIEW_IN_PROGRESS run_main 'precheck() { cleanup_add delete_review_stack new-stack; fail boom; }' --yes
check "trap deletes a stack left in REVIEW_IN_PROGRESS" logged 'cloudformation delete-stack --stack-name new-stack'
run_main 'precheck() { cleanup_add delete_review_stack new-stack; fail boom; }' --yes
check "a healthy stack is not deleted by the REVIEW_IN_PROGRESS cleanup" not_logged 'delete-stack'
run_main 'precheck() { :; }' --yes
check "nothing registered: clean exit, no aws calls" test "$RC" -eq 0 -a ! -s "$AWS_LOG"

# --- CloudFormation change set
run_main 'precheck() { precheck_cfn_change_set my-stack "$T/tpl.yaml" --capabilities CAPABILITY_IAM; }' --yes
check "existing stack: change set created, waited and deleted" test "$RC" -eq 0
check "existing stack: UPDATE change set with extra args" logged 'create-change-set --stack-name my-stack .*--change-set-type UPDATE .*--capabilities CAPABILITY_IAM'
check "existing stack: change set deleted" logged 'delete-change-set --stack-name my-stack'
check "existing stack: no validate-template" not_logged 'validate-template'
STUB_STACK=missing run_main 'precheck() { precheck_cfn_change_set new-stack "$T/tpl.yaml"; }' --yes
check "new stack: validate-template, no change set, no stack" test "$RC" -eq 0
check "new stack: validate-template called" logged 'validate-template'
check "new stack: no create-change-set" not_logged 'create-change-set'
STUB_STACK=missing STUB_VALIDATE_FAIL=1 run_main 'precheck() { precheck_cfn_change_set new-stack "$T/tpl.yaml"; }' --yes
check "new stack: invalid template stops before apply" test "$RC" -eq 1 -a ! -e "$T/applied"
STUB_WAIT_FAIL=1 STUB_CS_REASON="The submitted information didn't contain changes. Submit different information to create a change set." \
  run_main 'precheck() { precheck_cfn_change_set my-stack "$T/tpl.yaml"; }' --yes
check "no changes is not a failure" test "$RC" -eq 0 -a -e "$T/applied"
check "no changes: change set still deleted" logged 'delete-change-set'
STUB_WAIT_FAIL=1 STUB_CS_REASON="Parameters: [Env] must have values" run_main 'precheck() { precheck_cfn_change_set my-stack "$T/tpl.yaml"; }' --yes
check "a real change set failure stops before apply" test "$RC" -eq 1 -a ! -e "$T/applied"
check "a real failure shows CloudFormation's reason" grep -q 'Parameters: \[Env\] must have values' <<<"$OUT"
check "a real failure still deletes the change set (trap)" logged 'delete-change-set'

# --- --dry-run runs the pre-checks and changes nothing
run_main 'precheck() { echo precheck-ran; precheck_iam_policy "$T/good.json"; precheck_cfn_change_set my-stack "$T/tpl.yaml"; }' --dry-run
check "dry run: exit 0, pre-checks ran, apply not run" test "$RC" -eq 0 -a ! -e "$T/applied"
check "dry run: precheck output present" grep -q precheck-ran <<<"$OUT"
check "dry run: says nothing changed" grep -q 'nothing changed' <<<"$OUT"
check "dry run: temporary policy deleted again" logged 'iam delete-policy'
check "dry run: nothing but temporary resources touched" not_logged 'create-stack\|update-stack\|execute-change-set\|put-\|attach-'
run_main 'precheck() { precheck_policy_json "$T/badarn.json"; }' --dry-run
check "dry run: a failed pre-check fails the run" test "$RC" -eq 1

# --- the unmodified template runs through (no aws needed) and rejects unknown arguments
run_main ':' --bogus
check "unknown argument exits 2" test "$RC" -eq 2

echo
if [[ "$FAILS" -eq 0 ]]; then echo "all passed"; else echo "$FAILS failed"; exit 1; fi
