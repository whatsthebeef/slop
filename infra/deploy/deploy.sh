#!/bin/bash
# Runs in CodeBuild after the image is pushed: has the instance switch to the new image through SSM Run Command,
# then waits for the result. The instance takes the deploy files (compose.yaml, remote-deploy.sh, backup.sh) from
# the image it is deploying (/app/deploy), so no bucket carries them. Exits non-zero when the deploy failed.
#
# Environment (set by the CodeBuild project): AWS_REGION, STAGE, INSTANCE_ID, BACKUP_BUCKET, IMAGE, PUBLIC_URL.
set -euo pipefail
: "${AWS_REGION:?}" "${STAGE:?}" "${INSTANCE_ID:?}" "${BACKUP_BUCKET:?}" "${IMAGE:?}" "${PUBLIC_URL:?}"

# The instance's own commands; the values are ARNs, URLs and tags, with no characters the shell would treat specially.
cat > ssm-parameters.json <<JSON
{"commands": [
  "set -euo pipefail",
  "mkdir -p /opt/slop",
  "aws ecr get-login-password --region ${AWS_REGION} | docker login --username AWS --password-stdin ${IMAGE%%/*}",
  "docker pull ${IMAGE}",
  "CID=\$(docker create ${IMAGE})",
  "docker cp \$CID:/app/deploy/. /opt/slop/",
  "docker rm \$CID >/dev/null",
  "IMAGE=${IMAGE} BACKUP_BUCKET=${BACKUP_BUCKET} PUBLIC_URL=${PUBLIC_URL} AWS_REGION=${AWS_REGION} STAGE=${STAGE} bash /opt/slop/remote-deploy.sh"
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
