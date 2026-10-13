#!/bin/bash
# Edits the server's settings in the SSM parameter /slop/<stage>/server-env (KEY=VALUE per line), touching only the named
# keys, and optionally redeploys so the instance picks them up. A person runs this: it changes production settings
# (see README.md).
#
#   infra/deploy/server-env.sh [--stage prod] set KEY=VALUE... [--unset KEY]... [--redeploy] [--dry-run]
#
# Every other line stays byte-for-byte as it was. Values are never printed. --redeploy starts the stack's deploy project
# and waits for the build (exit 1 unless it succeeds). --dry-run reports the changes and writes nothing.
set -euo pipefail

STAGE=prod
REDEPLOY=0
DRY=0
SETS=()
UNSETS=()
[ "${1:-}" != --stage ] || { STAGE="${2:?--stage needs a value}"; shift 2; }
[ "${1:-}" = set ] || { sed -n '2,11p' "$0" >&2; exit 2; }
shift
while [ $# -gt 0 ]; do
  case "$1" in
    --stage) STAGE="${2:?--stage needs a value}"; shift 2 ;;
    --unset) UNSETS+=("${2:?--unset needs a key}"); shift 2 ;;
    --redeploy) REDEPLOY=1; shift ;;
    --dry-run) DRY=1; shift ;;
    -*) echo "unknown argument: $1" >&2; exit 2 ;;
    *=*) SETS+=("$1"); shift ;;
    *) echo "expected KEY=VALUE, got: ${1%%=*}" >&2; exit 2 ;;
  esac
done
[ $((${#SETS[@]} + ${#UNSETS[@]})) -gt 0 ] || [ "$REDEPLOY" = 1 ] || { echo "nothing to do" >&2; exit 2; }

KEY_RE='^[A-Za-z_][A-Za-z0-9_]*$'
for KV in ${SETS[@]+"${SETS[@]}"}; do [[ "${KV%%=*}" =~ $KEY_RE ]] || { echo "bad key: ${KV%%=*}" >&2; exit 2; }; done
for K in ${UNSETS[@]+"${UNSETS[@]}"}; do [[ "$K" =~ $KEY_RE ]] || { echo "bad key: $K" >&2; exit 2; }; done

export AWS_REGION="${AWS_REGION:-us-east-1}"
PARAM="/slop/${STAGE}/server-env"

changed=0
if [ $((${#SETS[@]} + ${#UNSETS[@]})) -gt 0 ]; then
  # The sentinel keeps $(...) from stripping trailing newlines; text output adds exactly one.
  CURRENT="$(aws ssm get-parameter --name "$PARAM" --query Parameter.Value --output text; printf x)"
  CURRENT="${CURRENT%x}"
  CURRENT="${CURRENT%$'\n'}"

  LINES=()
  TRAILING_NL=0
  case "$CURRENT" in *$'\n') TRAILING_NL=1; CURRENT="${CURRENT%$'\n'}" ;; esac
  if [ -n "$CURRENT" ] || [ "$TRAILING_NL" = 1 ]; then
    while IFS= read -r LINE || [ -n "$LINE" ]; do LINES+=("$LINE"); done <<<"$CURRENT"
  fi

  # Rewrites the lines of KEY (set: first one replaced, extras dropped; unset: all dropped) and appends a new key.
  apply() { # apply <key> <replacement line, or empty to remove>
    local key="$1" repl="$2" out=() seen=0 line
    for line in ${LINES[@]+"${LINES[@]}"}; do
      if [ "${line%%=*}" = "$key" ] && [[ "$line" == *=* ]]; then
        if [ -n "$repl" ] && [ "$seen" = 0 ]; then out+=("$repl"); fi
        seen=1
      else
        out+=("$line")
      fi
    done
    if [ -n "$repl" ] && [ "$seen" = 0 ]; then out+=("$repl"); fi
    if [ "$(printf '%s\n' ${out[@]+"${out[@]}"})" != "$(printf '%s\n' ${LINES[@]+"${LINES[@]}"})" ]; then
      changed=1
      if [ -n "$repl" ]; then echo "  set $key"; else echo "  unset $key"; fi
    else
      echo "  unchanged $key"
    fi
    LINES=(${out[@]+"${out[@]}"})
  }
  echo "Changes to $PARAM (values not shown):"
  for KV in ${SETS[@]+"${SETS[@]}"}; do apply "${KV%%=*}" "$KV"; done
  for K in ${UNSETS[@]+"${UNSETS[@]}"}; do apply "$K" ""; done

  if [ "$changed" = 1 ] && [ "$DRY" != 1 ]; then
    NEW="$(printf '%s\n' ${LINES[@]+"${LINES[@]}"}; printf x)"
    NEW="${NEW%x}"
    # Keep the parameter's original ending: no newline after the last line unless it had one.
    if [ "$TRAILING_NL" = 0 ]; then NEW="${NEW%$'\n'}"; fi
    aws ssm put-parameter --name "$PARAM" --type String --overwrite --value "$NEW" >/dev/null
    echo "Updated $PARAM"
  fi
fi

if [ "$REDEPLOY" = 1 ]; then
  if [ "$DRY" = 1 ]; then echo "dry run: would redeploy"; exit 0; fi
  STACK="slop-${STAGE}-host"
  PROJECT="$(aws cloudformation describe-stacks --stack-name "$STACK" --query "Stacks[0].Outputs[?OutputKey=='DeployProject'].OutputValue | [0]" --output text)"
  [ -n "$PROJECT" ] && [ "$PROJECT" != None ] || { echo "ERROR: no DeployProject output on $STACK" >&2; exit 1; }
  BUILD="$(aws codebuild start-build --project-name "$PROJECT" --query build.id --output text)"
  echo "Started build $BUILD; waiting"
  WAITED=0
  while :; do
    STATUS="$(aws codebuild batch-get-builds --ids "$BUILD" --query 'builds[0].buildStatus' --output text)"
    [ "$STATUS" != IN_PROGRESS ] && break
    [ "$WAITED" -lt "${SERVER_ENV_WAIT_SECONDS:-2400}" ] || { echo "ERROR: build $BUILD still running; gave up waiting" >&2; exit 1; }
    sleep "${SERVER_ENV_POLL_SECONDS:-15}"
    WAITED=$((WAITED + ${SERVER_ENV_POLL_SECONDS:-15}))
  done
  echo "Build $BUILD: $STATUS"
  [ "$STATUS" = SUCCEEDED ]
fi
