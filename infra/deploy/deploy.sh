#!/bin/bash
# Runs in CodeBuild after the image is pushed: copies the deploy files to S3 and has the instance switch to the
# new image through SSM Run Command, then waits for the result. Exits non-zero when the deploy failed.
#
# Environment (set by the CodeBuild project): AWS_REGION, STAGE, INSTANCE_ID, BUCKET, IMAGE, PUBLIC_URL.
set -euo pipefail
: "${AWS_REGION:?}" "${STAGE:?}" "${INSTANCE_ID:?}" "${BUCKET:?}" "${IMAGE:?}" "${PUBLIC_URL:?}"

PREFIX="releases/${CODEBUILD_RESOLVED_SOURCE_VERSION:-manual}"
aws s3 cp compose.prod.yaml "s3://${BUCKET}/${PREFIX}/compose.yaml" --only-show-errors
aws s3 cp infra/deploy/remote-deploy.sh "s3://${BUCKET}/${PREFIX}/remote-deploy.sh" --only-show-errors

# The instance's own commands; the values are ARNs, URLs and tags, with no characters the shell would treat specially.
cat > ssm-parameters.json <<JSON
{"commands": [
  "set -euo pipefail",
  "mkdir -p /opt/slop",
  "aws s3 cp s3://${BUCKET}/${PREFIX}/compose.yaml /opt/slop/compose.yaml --region ${AWS_REGION} --only-show-errors",
  "aws s3 cp s3://${BUCKET}/${PREFIX}/remote-deploy.sh /opt/slop/remote-deploy.sh --region ${AWS_REGION} --only-show-errors",
  "IMAGE=${IMAGE} PUBLIC_URL=${PUBLIC_URL} AWS_REGION=${AWS_REGION} STAGE=${STAGE} bash /opt/slop/remote-deploy.sh"
]}
JSON

COMMAND_ID="$(aws ssm send-command --region "$AWS_REGION" --instance-ids "$INSTANCE_ID" \
  --document-name AWS-RunShellScript --comment "slop deploy ${IMAGE##*:}" --timeout-seconds 900 \
  --parameters file://ssm-parameters.json --query Command.CommandId --output text)"
echo "SSM command ${COMMAND_ID}"

STATUS=Pending
for _ in $(seq 1 200); do
  sleep 5
  STATUS="$(aws ssm get-command-invocation --region "$AWS_REGION" --command-id "$COMMAND_ID" --instance-id "$INSTANCE_ID" \
    --query Status --output text 2>/dev/null || echo Pending)"
  case "$STATUS" in Pending|InProgress|Delayed) ;; *) break ;; esac
done

aws ssm get-command-invocation --region "$AWS_REGION" --command-id "$COMMAND_ID" --instance-id "$INSTANCE_ID" \
  --query '[StandardOutputContent, StandardErrorContent]' --output text || true
if [ "$STATUS" != "Success" ]; then
  echo "Deploy ${IMAGE} finished as ${STATUS}; the previous release keeps serving if it was rolled back" >&2
  exit 1
fi
echo "Deployed ${IMAGE}"
