#!/bin/bash
# Deploys the slop-<stage>-host stack (default stage: prod) with its cdk context read from the live stack, so nothing
# account-specific lives in the repo. A person runs this: it changes paid infrastructure and IAM (see README.md).
#
#   infra/deploy/host-deploy.sh [--stage prod] [--add-project <name>]... [--remove-project <name>]... [--yes]
#                               [--data-volume <vol-id>] [--hand-over-volume] [--allow-replace]
#
# Read-only lookups (needs an AWS session for the account): the deploy connection, the CloudFront domain and certificate,
# the alert email, the CodeBuild projects the instance role may start (--add-project / --remove-project change that
# list; names come from the command line only), and (for the stack's pinned AMI and data disk) the
# running instance's AMI and /dev/sdf volume. It prints the context, runs `cdk diff`, and asks before `cdk deploy`.
# Without --yes it refuses to run when stdin is not a terminal.
#
# --data-volume names the data volume when nothing is on /dev/sdf (it is detached). If the volume is attached to the
# instance but the stack has no VolumeAttachment (it was attached by hand), CloudFormation would fail with "already
# attached", so the script stops and prints the handover (infra/deploy/HOST.md). --hand-over-volume runs it: after the
# diff and your confirmation it snapshots the volume, stops the app and Postgres, unmounts and detaches the volume,
# deploys, then lets the stack attach it, mounts it and starts everything again; a failed deploy re-attaches it at /dev/sdf.
#
# The script creates the CloudFormation change set itself (cdk deploy --no-execute), reads it, and executes that same
# change set after your confirmation. It refuses a change set that replaces the instance or adds a data volume in prod;
# --allow-replace overrides that for the "Changing the AMI" procedure in HOST.md (detach the volume first). It asks again
# when the change stops and starts the instance. After a deploy that replaced or restarted the instance it starts the
# deploy project, waits for it and checks <PublicUrl>/auth/config, so slop is back without a manual step.
set -euo pipefail

STAGE=prod
YES=0
DATA_VOLUME=""
HAND_OVER=0
ALLOW_REPLACE=0
ADD_PROJECTS=""
REMOVE_PROJECTS=""
while [ $# -gt 0 ]; do
  case "$1" in
    --stage) STAGE="${2:?--stage needs a value}"; shift 2 ;;
    --add-project) ADD_PROJECTS="${ADD_PROJECTS:+$ADD_PROJECTS,}${2:?--add-project needs a name}"; shift 2 ;;
    --remove-project) REMOVE_PROJECTS="${REMOVE_PROJECTS:+$REMOVE_PROJECTS,}${2:?--remove-project needs a name}"; shift 2 ;;
    --data-volume) DATA_VOLUME="${2:?--data-volume needs a volume id}"; shift 2 ;;
    --hand-over-volume) HAND_OVER=1; shift ;;
    --allow-replace) ALLOW_REPLACE=1; shift ;;
    --yes) YES=1; shift ;;
    -h|--help) sed -n '2,28p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

export AWS_REGION="${AWS_REGION:-us-east-1}"
STACK="slop-${STAGE}-host"
INFRA_DIR="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=deploy-guards.sh
. "$(dirname "$0")/deploy-guards.sh"

out() { aws cloudformation describe-stacks --stack-name "$STACK" --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue | [0]" --output text; }
res() { aws cloudformation describe-stack-resources --stack-name "$STACK" --query "StackResources[?ResourceType=='$1'].PhysicalResourceId" --output text | tr '\t' '\n'; }
ssm_json_file=""
# on_instance <comment> <execution timeout> <command>...: runs the commands on the instance over SSM and fails unless they
# succeed. Commands are fixed text: a double quote or backslash in one is refused, not escaped.
on_instance() {
  local comment="$1" timeout="$2" line sep='' id status=Pending
  shift 2
  ssm_json_file="${ssm_json_file:-$(mktemp "${TMPDIR:-/tmp}/host-deploy-ssm.XXXXXX")}"
  { printf '{"executionTimeout": ["%s"], "commands": [' "$timeout"
    for line in "$@"; do
      case "$line" in *'"'* | *\\*) echo "ERROR: unexpected character in an SSM command: $line" >&2; return 1 ;; esac
      printf '%s\n  "%s"' "$sep" "$line"; sep=','
    done
    printf '\n]}\n'
  } > "$ssm_json_file"
  id="$(aws ssm send-command --instance-ids "$INSTANCE" --document-name AWS-RunShellScript --comment "$comment" \
    --timeout-seconds 600 --parameters "file://${ssm_json_file}" --query Command.CommandId --output text)"
  echo "SSM command $id ($comment)"
  for _ in $(seq 1 $((timeout / 5 + 24))); do
    sleep "${HANDOVER_POLL_SECONDS:-5}"
    status="$(aws ssm get-command-invocation --command-id "$id" --instance-id "$INSTANCE" --query Status --output text 2>/dev/null || echo Pending)"
    case "$status" in Pending|InProgress|Delayed) ;; *) break ;; esac
  done
  aws ssm get-command-invocation --command-id "$id" --instance-id "$INSTANCE" --query StandardOutputContent --output text || true
  [ "$status" = Success ] || { echo "ERROR: the instance's $comment finished as $status" >&2; return 1; }
}

# aws prints "None" for a missing value
set_or_empty() { case "$1" in None|null) echo "" ;; *) echo "$1" ;; esac; }

PROJECT="$(set_or_empty "$(out DeployProject)")"
INSTANCE="$(set_or_empty "$(out InstanceId)")"
[ -n "$PROJECT" ] || { echo "ERROR: no DeployProject output on $STACK; is the stage right and the stack deployed?" >&2; exit 1; }

CONNECTION="$(set_or_empty "$(aws codebuild batch-get-projects --names "$PROJECT" --query 'projects[0].source.auth.resource' --output text)")"
[ -n "$CONNECTION" ] || { echo "ERROR: deploy project $PROJECT has no source connection" >&2; exit 1; }

ARGS=(-c "stage=$STAGE" -c "deployConnectionArn=$CONNECTION")

DIST="$(res AWS::CloudFront::Distribution | head -1)"
if [ -n "$DIST" ]; then
  DOMAIN="$(set_or_empty "$(aws cloudfront get-distribution-config --id "$DIST" --query 'DistributionConfig.Aliases.Items[0]' --output text)")"
  CERT="$(set_or_empty "$(aws cloudfront get-distribution-config --id "$DIST" --query 'DistributionConfig.ViewerCertificate.ACMCertificateArn' --output text)")"
  if [ -n "$DOMAIN" ] && [ -n "$CERT" ]; then ARGS+=(-c "domainName=$DOMAIN" -c "certificateArn=$CERT"); fi
fi

EMAIL=""
while IFS= read -r TOPIC; do
  [ -n "$TOPIC" ] || continue
  EMAIL="$(set_or_empty "$(aws sns list-subscriptions-by-topic --topic-arn "$TOPIC" --query "Subscriptions[?Protocol=='email'].Endpoint | [0]" --output text)")"
  [ -z "$EMAIL" ] || break
done < <(res AWS::SNS::Topic)
if [ -n "$EMAIL" ]; then ARGS+=(-c "alertEmail=$EMAIL"); fi

# deployProjects: every CodeBuild project any of the stack's roles may start (the grant is on the instance role).
PROJECTS=()
while IFS= read -r ROLE; do
  [ -n "$ROLE" ] || continue
  for POLICY in $(aws iam list-role-policies --role-name "$ROLE" --query 'PolicyNames' --output text); do
    GRANTS="$(aws iam get-role-policy --role-name "$ROLE" --policy-name "$POLICY" \
      --query "PolicyDocument.Statement[?contains(to_string(Action), 'codebuild:StartBuild')].Resource" --output text | tr '\t' '\n')"
    while IFS= read -r ARN; do
      NAME="${ARN##*:project/}"
      [ "$NAME" != "$ARN" ] && [ -n "$NAME" ] || continue
      case " ${PROJECTS[*]:-} " in *" $NAME "*) ;; *) PROJECTS+=("$NAME") ;; esac
    done <<<"$GRANTS"
  done
done < <(res AWS::IAM::Role)
EXISTING="$(IFS=,; echo "${PROJECTS[*]:-}")"
MERGED="$(merge_projects "$EXISTING" "$ADD_PROJECTS" "$REMOVE_PROJECTS")" || exit 2
if [ -n "$MERGED" ]; then ARGS+=(-c "deployProjects=$MERGED"); fi

# The stack pins the instance's AMI and data volume (infra/deploy/HOST.md): read both from the running instance.
if [ -n "$INSTANCE" ]; then
  AMI="$(set_or_empty "$(aws ec2 describe-instances --instance-ids "$INSTANCE" --query 'Reservations[0].Instances[0].ImageId' --output text)")"
  VOLUME="$DATA_VOLUME"
  if [ -z "$VOLUME" ]; then
    VOLUME="$(set_or_empty "$(aws ec2 describe-instances --instance-ids "$INSTANCE" --query "Reservations[0].Instances[0].BlockDeviceMappings[?DeviceName=='/dev/sdf'].Ebs.VolumeId | [0]" --output text)")"
  fi
  if [ -n "$AMI" ]; then ARGS+=(-c "hostAmiId=$AMI"); fi
  if [ -n "$VOLUME" ]; then ARGS+=(-c "hostDataVolumeId=$VOLUME"); fi
fi

# Prod never synthesises without its data volume; say how to name it rather than letting cdk fail.
if [ "$STAGE" = prod ] && [ -z "${VOLUME:-}" ]; then
  echo "ERROR: no data volume on /dev/sdf of ${INSTANCE:-the instance}: it is detached. Pass --data-volume <vol-id> (infra/deploy/HOST.md)" >&2
  exit 2
fi

# A volume attached by hand, with no VolumeAttachment in the stack: the deploy would fail with "already attached".
UNMANAGED=0
if [ -n "${VOLUME:-}" ] && [ -n "$INSTANCE" ]; then
  ATTACHMENTS="$(res AWS::EC2::VolumeAttachment | head -1)"
  STATE="$(set_or_empty "$(aws ec2 describe-volumes --volume-ids "$VOLUME" --query "Volumes[0].Attachments[?InstanceId=='$INSTANCE'].State | [0]" --output text)")"
  if needs_volume_handover "$ATTACHMENTS" "$STATE"; then UNMANAGED=1; fi
fi
if [ "$UNMANAGED" = 1 ] && [ "$HAND_OVER" != 1 ]; then
  cat >&2 <<MSG
ERROR: $VOLUME is attached to $INSTANCE, but $STACK has no AWS::EC2::VolumeAttachment (it was attached by hand).
CloudFormation would try to create one and fail with "already attached", then roll back. Nothing was changed.

The stack can only attach the volume while it is detached. Either run this script again with --hand-over-volume, which
does the steps below after the diff and your confirmation, or do them by hand (infra/deploy/HOST.md, "Handing over a
volume attached by hand"):
  1. snapshot $VOLUME and wait for it to complete;
  2. take /opt/slop/.deploy.lock on the instance, stop slop-app-1 and slop-postgres-1, sync, umount /var/lib/slop;
  3. aws ec2 detach-volume --volume-id $VOLUME, and wait for "available";
  4. host-deploy.sh --data-volume $VOLUME (the stack attaches it at /dev/sdf);
  5. wait for "in-use", mount -a, start slop-postgres-1 then slop-app-1, check localhost:3000/auth/config;
  if the deploy fails or you stop, attach it again at /dev/sdf and start both containers.
MSG
  exit 3
fi
if [ "$HAND_OVER" = 1 ] && [ "$UNMANAGED" != 1 ]; then
  echo "Nothing to hand over: ${VOLUME:-no volume} is not attached outside $STACK. Deploying as usual."
  HAND_OVER=0
fi

echo "cdk context for $STACK:"
printf '  %s\n' "${ARGS[@]}"

cd "$INFRA_DIR"
if command -v cdk >/dev/null 2>&1; then
  CDK=(cdk)
else
  corepack pnpm install --frozen-lockfile -s
  CDK=(corepack pnpm -s cdk)
fi

"${CDK[@]}" diff "$STACK" "${ARGS[@]}" || true
echo

# The change set is what gets executed: read it here rather than trusting a person to read the diff.
CHANGE_SET="host-deploy-$(date -u +%Y%m%dT%H%M%SZ)"
"${CDK[@]}" deploy "$STACK" "${ARGS[@]}" --no-execute --change-set-name "$CHANGE_SET" --require-approval never
CHANGES="$(aws cloudformation describe-change-set --stack-name "$STACK" --change-set-name "$CHANGE_SET" \
  --query 'Changes[].ResourceChange.[Action,LogicalResourceId,ResourceType,Replacement,join(`,`,not_null(Details[].Target.Name,`[]`))]' --output text 2>/dev/null || true)"
CHANGES="$(set_or_empty "$CHANGES")"
if [ -z "$CHANGES" ]; then
  echo "No changes to deploy."
  exit 0
fi
REFUSALS="$(change_set_refusals "$STAGE" <<<"$CHANGES")"
if [ -n "$REFUSALS" ] && [ "$ALLOW_REPLACE" != 1 ]; then
  {
    echo "ERROR: change set $CHANGE_SET of $STAGE must not be executed:"
    sed 's/^/  - /' <<<"$REFUSALS"
    echo "A replaced instance comes up with no containers and, if the volume is still attached to the old one, no data."
    echo "Nothing was deployed. If this is the deliberate replacement, follow \"Changing the AMI\" in infra/deploy/HOST.md"
    echo "(snapshot, stop, detach the data volume first) and run this script again with --allow-replace."
  } >&2
  exit 4
fi
if [ -n "$REFUSALS" ]; then
  echo "WARNING: --allow-replace: executing a change set that" >&2
  sed 's/^/  - /' <<<"$REFUSALS" >&2
  echo "The data volume must be detached (infra/deploy/HOST.md, \"Changing the AMI\")." >&2
fi
RESTARTS="$(change_set_restarts <<<"$CHANGES")"

if [ "$YES" != 1 ]; then
  if [ ! -t 0 ]; then
    echo "ERROR: not a terminal; refusing to deploy without --yes" >&2
    exit 2
  fi
  read -rp "Deploy $STACK? [y/N] " OK
  [ "$OK" = y ] || { echo "Not deployed."; exit 1; }
  if [ -n "$RESTARTS" ] && [ -z "$REFUSALS" ]; then
    echo "WARNING: $RESTARTS. slop is down until it is redeployed; this script does that afterwards (about 10 minutes)."
    read -rp "Stop and start the instance? [y/N] " OK
    [ "$OK" = y ] || { echo "Not deployed."; exit 1; }
  fi
fi

BEFORE_ID=""
BEFORE_LAUNCH=""
if [ -n "$INSTANCE" ]; then
  BEFORE_ID="$INSTANCE"
  BEFORE_LAUNCH="$(set_or_empty "$(aws ec2 describe-instances --instance-ids "$INSTANCE" --query 'Reservations[0].Instances[0].LaunchTime' --output text)")"
fi

# execute_change_set: runs the reviewed change set (no re-planning) and waits for the stack.
execute_change_set() {
  aws cloudformation execute-change-set --stack-name "$STACK" --change-set-name "$CHANGE_SET"
  aws cloudformation wait stack-update-complete --stack-name "$STACK"
}

# redeploy_if_restarted: after the deploy, if the instance was replaced or restarted, starts the deploy project (the app
# is not running on it), waits for the build and checks the public URL.
redeploy_if_restarted() {
  local id launch build status waited=0 url group stream
  id="$(set_or_empty "$(out InstanceId)")"
  [ -n "$id" ] || return 0
  launch="$(set_or_empty "$(aws ec2 describe-instances --instance-ids "$id" --query 'Reservations[0].Instances[0].LaunchTime' --output text)")"
  if ! instance_restarted "$BEFORE_ID" "$BEFORE_LAUNCH" "$id" "$launch"; then return 0; fi
  echo "The instance was replaced or restarted ($BEFORE_ID $BEFORE_LAUNCH -> $id $launch): redeploying slop with $PROJECT"
  INSTANCE="$id"
  aws ec2 wait instance-status-ok --instance-ids "$id"
  build="$(aws codebuild start-build --project-name "$PROJECT" --query build.id --output text)"
  echo "Started build $build; waiting"
  while :; do
    status="$(aws codebuild batch-get-builds --ids "$build" --query 'builds[0].buildStatus' --output text)"
    [ "$status" != IN_PROGRESS ] && break
    [ "$waited" -lt "${HOST_DEPLOY_WAIT_SECONDS:-2400}" ] || { echo "ERROR: build $build still running; gave up waiting" >&2; return 1; }
    sleep "${HOST_DEPLOY_POLL_SECONDS:-15}"
    waited=$((waited + ${HOST_DEPLOY_POLL_SECONDS:-15}))
  done
  echo "Build $build: $status"
  if [ "$status" != SUCCEEDED ]; then
    group="$(aws codebuild batch-get-builds --ids "$build" --query 'builds[0].logs.groupName' --output text || true)"
    stream="$(aws codebuild batch-get-builds --ids "$build" --query 'builds[0].logs.streamName' --output text || true)"
    echo "Last log lines of the build:" >&2
    aws logs get-log-events --log-group-name "$group" --log-stream-name "$stream" --limit 30 --query 'events[].message' --output text >&2 || true
    return 1
  fi
  url="$(set_or_empty "$(out PublicUrl)")"
  for _ in $(seq 1 30); do
    if curl -fsS -m 10 "${url%/}/auth/config" >/dev/null; then echo "$url answers"; return 0; fi
    sleep "${HOST_DEPLOY_POLL_SECONDS:-15}"
  done
  echo "ERROR: ${url%/}/auth/config does not answer after the redeploy" >&2
  return 1
}

if [ "$HAND_OVER" != 1 ]; then
  execute_change_set
  redeploy_if_restarted
  exit 0
fi

RELEASE_LOCK='if [ -f /run/slop-handover.pid ]; then kill $(cat /run/slop-handover.pid) 2>/dev/null || true; rm -f /run/slop-handover.pid; fi'
START_APP='docker start slop-postgres-1 && sleep 10 && docker start slop-app-1'
CHECK_APP='for i in $(seq 1 60); do curl -fsS -m 5 http://localhost:3000/auth/config >/dev/null && exit 0; sleep 3; done; echo app did not answer; exit 1'
HANDOVER_STARTED=0
volume_state() { aws ec2 describe-volumes --volume-ids "$VOLUME" --query 'Volumes[0].State' --output text; }
wait_volume() { # <state>
  for _ in $(seq 1 60); do [ "$(volume_state)" = "$1" ] && return 0; sleep "${HANDOVER_POLL_SECONDS:-5}"; done
  echo "ERROR: $VOLUME did not reach $1" >&2; return 1
}
# Puts the volume back where it was and restarts, after a failure: an attachment the stack's rollback may still be
# removing is waited for first.
restore_volume() {
  trap - ERR EXIT
  echo "Handover failed: re-attaching $VOLUME at /dev/sdf and restarting the app" >&2
  if [ "$(volume_state)" = in-use ]; then wait_volume available || true; fi
  if [ "$(volume_state)" = available ]; then
    aws ec2 attach-volume --volume-id "$VOLUME" --instance-id "$INSTANCE" --device /dev/sdf >/dev/null
  fi
  wait_volume in-use
  on_instance "handover: restore" 300 "mount -a" "$START_APP" "$RELEASE_LOCK" "$CHECK_APP"
}
on_failure() { local code=$?; if [ "$HANDOVER_STARTED" = 1 ]; then restore_volume || echo "ERROR: could not restore; see HOST.md" >&2; fi; exit "$code"; }

SNAPSHOT="$(aws ec2 create-snapshot --volume-id "$VOLUME" --description "slop host handover $(date -u +%Y%m%dT%H%M%SZ)" --query SnapshotId --output text)"
echo "Snapshot $SNAPSHOT of $VOLUME: waiting for it to complete"
aws ec2 wait snapshot-completed --snapshot-ids "$SNAPSHOT"

trap on_failure ERR EXIT
HANDOVER_STARTED=1
on_instance "handover: stop and unmount" 600 \
  "$RELEASE_LOCK" \
  'nohup flock -n /opt/slop/.deploy.lock sleep 7200 >/dev/null 2>&1 & echo $! > /run/slop-handover.pid; sleep 2; kill -0 $(cat /run/slop-handover.pid) || { echo a deploy is running; exit 1; }' \
  "docker stop slop-app-1" "docker stop -t 60 slop-postgres-1" "sync" "umount /var/lib/slop"
aws ec2 detach-volume --volume-id "$VOLUME" >/dev/null
wait_volume available

execute_change_set

wait_volume in-use
on_instance "handover: mount and start" 600 "mount -a" "$START_APP" "$RELEASE_LOCK" "$CHECK_APP"
HANDOVER_STARTED=0
trap - ERR EXIT
redeploy_if_restarted
echo "Handover complete: $VOLUME is attached by $STACK. Check the next weekly snapshot, and see HOST.md."
