#!/bin/bash
# Read-only: prints the last N hours of the slop server container's logs, filtered to slow requests ({"slowRequest":true,...}
# lines from the request timing), request timeouts and errors, through SSM Run Command like deploy.sh. Run it with AWS
# credentials for the slop account (it changes nothing on the instance) and paste the output onto the glob that asked for it.
#
# Usage: INSTANCE_ID=i-... AWS_REGION=... infra/deploy/server-logs.sh [hours (default 6)] [extra grep pattern]
set -euo pipefail
: "${AWS_REGION:?}" "${INSTANCE_ID:?}"
HOURS="${1:-6}"
case "$HOURS" in '' | *[!0-9]*) echo "hours must be a whole number" >&2; exit 2 ;; esac
# The extra pattern goes through the instance's shell: keep it to plain words.
EXTRA="${2:-}"
case "$EXTRA" in *[!A-Za-z0-9_.:\ -]*) echo "the extra pattern may only hold letters, digits and _ . : - space" >&2; exit 2 ;; esac
PATTERN="slowRequest|timedOut|Error|error|ECONNRESET|unhandled${EXTRA:+|$EXTRA}"

COMMAND="docker logs --since ${HOURS}h \$(docker ps -q --filter name=app | head -n 1) 2>&1 | grep -E '${PATTERN}' | tail -n 2000"
COMMAND_ID="$(aws ssm send-command --region "$AWS_REGION" --instance-ids "$INSTANCE_ID" \
  --document-name AWS-RunShellScript --comment "slop server logs ${HOURS}h" --timeout-seconds 120 \
  --parameters "{\"commands\":[\"${COMMAND}\"]}" --query Command.CommandId --output text)"

STATUS=Pending
for _ in $(seq 1 30); do
  sleep 4
  STATUS="$(aws ssm get-command-invocation --region "$AWS_REGION" --command-id "$COMMAND_ID" --instance-id "$INSTANCE_ID" \
    --query Status --output text 2>/dev/null || echo Pending)"
  case "$STATUS" in Pending | InProgress | Delayed) ;; *) break ;; esac
done
# SSM cuts standard output at 24,000 characters: ask for fewer hours when the end of it is missing.
aws ssm get-command-invocation --region "$AWS_REGION" --command-id "$COMMAND_ID" --instance-id "$INSTANCE_ID" \
  --query StandardOutputContent --output text
[ "$STATUS" = "Success" ] || { echo "Command finished as ${STATUS}" >&2; exit 1; }
