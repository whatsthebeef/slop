#!/bin/bash
# Deploys the slop-<stage>-host stack (default stage: prod) with its cdk context read from the live stack, so nothing
# account-specific lives in the repo. A person runs this: it changes paid infrastructure and IAM (see README.md).
#
#   infra/deploy/host-deploy.sh [--stage prod] [--add-project <name>]... [--remove-project <name>]... [--yes]
#
# Read-only lookups (needs an AWS session for the account): the deploy connection, the CloudFront domain and certificate,
# the alert email, the CodeBuild projects the instance role may start (--add-project / --remove-project change that
# list; names come from the command line only), and (for the stack's pinned AMI and data disk) the
# running instance's AMI and /dev/sdf volume. It prints the context, runs `cdk diff`, and asks before `cdk deploy`.
# Without --yes it refuses to run when stdin is not a terminal.
set -euo pipefail

STAGE=prod
YES=0
ADD_PROJECTS=""
REMOVE_PROJECTS=""
while [ $# -gt 0 ]; do
  case "$1" in
    --stage) STAGE="${2:?--stage needs a value}"; shift 2 ;;
    --add-project) ADD_PROJECTS="${ADD_PROJECTS:+$ADD_PROJECTS,}${2:?--add-project needs a name}"; shift 2 ;;
    --remove-project) REMOVE_PROJECTS="${REMOVE_PROJECTS:+$REMOVE_PROJECTS,}${2:?--remove-project needs a name}"; shift 2 ;;
    --yes) YES=1; shift ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
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
  VOLUME="$(set_or_empty "$(aws ec2 describe-instances --instance-ids "$INSTANCE" --query "Reservations[0].Instances[0].BlockDeviceMappings[?DeviceName=='/dev/sdf'].Ebs.VolumeId | [0]" --output text)")"
  if [ -n "$AMI" ]; then ARGS+=(-c "hostAmiId=$AMI"); fi
  if [ -n "$VOLUME" ]; then ARGS+=(-c "hostDataVolumeId=$VOLUME"); fi
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
echo "Check the diff: the Host instance must not be replaced and no data volume added (infra/deploy/HOST.md)."

if [ "$YES" != 1 ]; then
  if [ ! -t 0 ]; then
    echo "ERROR: not a terminal; refusing to deploy without --yes" >&2
    exit 2
  fi
  read -rp "Deploy $STACK? [y/N] " OK
  [ "$OK" = y ] || { echo "Not deployed."; exit 1; }
fi

"${CDK[@]}" deploy "$STACK" "${ARGS[@]}" --require-approval never
