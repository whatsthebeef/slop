#!/bin/bash
# Runs in CodeBuild after the image is pushed: has the instance switch to the new image through SSM Run Command,
# then waits for the result. The instance takes the deploy files (compose.yaml, remote-deploy.sh, backup.sh) from
# the image it is deploying (/app/deploy), so no bucket carries them. Exits non-zero when the deploy failed.
#
# Environment (set by the CodeBuild project): AWS_REGION, STAGE, INSTANCE_ID, BACKUP_BUCKET, IMAGE, PUBLIC_URL; optionally PUBLIC_URL_ALIASES.
set -euo pipefail
: "${AWS_REGION:?}" "${STAGE:?}" "${INSTANCE_ID:?}" "${BACKUP_BUCKET:?}" "${IMAGE:?}" "${PUBLIC_URL:?}"

. "$(dirname "$0")/deploy-guards.sh"

# Every push to main starts its own build, and each deploy restarts the app (a short outage). Wait for a burst of merges
# to settle, then deploy only if this build's commit is still the head of main; the newest build deploys, the others succeed
# without touching the instance. If the head can't be read the deploy goes ahead.
COMMIT="${IMAGE##*:}"
sleep "${DEPLOY_DEBOUNCE_SECONDS:-60}"
HEAD_SHA="$(git ls-remote "${DEPLOY_REPO_URL:-${CODEBUILD_SOURCE_REPO_URL:-origin}}" refs/heads/main 2>/dev/null | cut -f1 || true)"
if is_superseded "$COMMIT" "$HEAD_SHA"; then
  echo "Skipping deploy of ${COMMIT}: superseded by ${HEAD_SHA}"
  exit 0
fi
COMMIT_TIME="$(git show -s --format=%ct "$COMMIT" 2>/dev/null || true)"

# The instance's own commands; executionTimeout (20 min) covers the pull and a health wait (up to 8 min) plus a rollback's, so a stuck command can't run for SSM's 1-hour default; the values are ARNs, URLs and tags, with no characters the shell would treat specially.
cat > ssm-parameters.json <<JSON
{"executionTimeout": ["1200"], "commands": [
  "set -euo pipefail",
  "mkdir -p /opt/slop",
  "aws ecr get-login-password --region ${AWS_REGION} | docker login --username AWS --password-stdin ${IMAGE%%/*}",
  "docker pull ${IMAGE}",
  "CID=\$(docker create ${IMAGE})",
  "docker cp \$CID:/app/deploy/. /opt/slop/",
  "docker rm \$CID >/dev/null",
  "IMAGE=${IMAGE} COMMIT_TIME=${COMMIT_TIME} SLOP_FIRST_DEPLOY=${SLOP_FIRST_DEPLOY:-} BACKUP_BUCKET=${BACKUP_BUCKET} PUBLIC_URL=${PUBLIC_URL} PUBLIC_URL_ALIASES=${PUBLIC_URL_ALIASES:-} AWS_REGION=${AWS_REGION} STAGE=${STAGE} bash /opt/slop/remote-deploy.sh"
]}
JSON

COMMAND_ID="$(aws ssm send-command --region "$AWS_REGION" --instance-ids "$INSTANCE_ID" \
  --document-name AWS-RunShellScript --comment "slop deploy ${IMAGE##*:}" --timeout-seconds 900 \
  --parameters file://ssm-parameters.json --query Command.CommandId --output text)"
echo "SSM command ${COMMAND_ID}"

STATUS=Pending
for _ in $(seq 1 250); do
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
