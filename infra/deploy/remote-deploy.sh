#!/bin/bash
# Runs on the instance (through SSM Run Command, from infra/deploy/deploy.sh): switches production to IMAGE.
# The new image is pulled before anything running is touched. If it doesn't answer its health check, the
# previous image is started again and the script fails, so CodeBuild goes red and the old release keeps serving.
#
# Environment: IMAGE (ECR URI with tag), PUBLIC_URL (https://<id>.cloudfront.net), AWS_REGION, STAGE, BACKUP_BUCKET.
# Next to it, extracted from the same image by the SSM command: compose.yaml (compose.prod.yaml from the repo) and
# backup.sh (the nightly dump, scheduled below).
set -euo pipefail
: "${IMAGE:?}" "${PUBLIC_URL:?}" "${AWS_REGION:?}" "${STAGE:?}" "${BACKUP_BUCKET:?}"
cd /opt/slop

# One deploy at a time.
exec 9>/opt/slop/.deploy.lock
flock -w 300 9

PREVIOUS=""
if [ -f current-image ]; then PREVIOUS="$(cat current-image)"; fi

# Postgres' password is made once and lives on the data disk, so it survives a replaced instance.
PASSWORD_FILE=/var/lib/slop/postgres-password
if [ ! -s "$PASSWORD_FILE" ]; then
  (umask 077 && openssl rand -hex 24 > "$PASSWORD_FILE")
fi
POSTGRES_PASSWORD="$(cat "$PASSWORD_FILE")"

# Settings that aren't secrets and change by hand: s15f34 puts the Cognito pool and clients here.
# One KEY=VALUE per line in the SSM parameter /slop/<stage>/server-env; without it the server's sign-in is
# configured with placeholders and nobody can sign in (it never falls back to the dev sign-in).
EXTRA="$(aws ssm get-parameter --region "$AWS_REGION" --name "/slop/${STAGE}/server-env" --query Parameter.Value --output text 2>/dev/null || true)"
if [ -z "$EXTRA" ]; then
  echo "No /slop/${STAGE}/server-env parameter: sign-in is not configured yet"
  EXTRA="AUTH_MODE=cognito
COGNITO_USER_POOL_ID=${AWS_REGION}_unset
COGNITO_REGION=${AWS_REGION}
COGNITO_DOMAIN=unset.invalid
COGNITO_CLIENT_IDS=unset
COGNITO_BOARD_CLIENT_ID=unset"
fi

# Production always signs in through Cognito: whatever the parameter says about AUTH_MODE is dropped, and the
# server defaults to dev when it is absent, so it is set explicitly after the parameter's lines.
EXTRA="$(printf '%s\n' "$EXTRA" | grep -v '^[[:space:]]*AUTH_MODE=' || true)"

(umask 077 && {
  echo "PUBLIC_URL=${PUBLIC_URL}"
  echo "DATABASE_URL=postgres://slop:${POSTGRES_PASSWORD}@postgres:5432/slop"
  echo "SECRETS=aws"
  echo "SECRETS_PREFIX=slop/${STAGE}/"
  echo "SECRETS_REGION=${AWS_REGION}"
  echo "BEDROCK_REGION=${AWS_REGION}"
  echo "AWS_REGION=${AWS_REGION}"
  printf '%s\n' "$EXTRA"
  echo "AUTH_MODE=cognito"
} > app.env.new)
mv app.env.new app.env

# The nightly dump: backup.sh run by a systemd timer (03:17 UTC; Persistent, so a missed run happens at boot).
printf 'BACKUP_BUCKET=%s\nAWS_REGION=%s\n' "$BACKUP_BUCKET" "$AWS_REGION" > /opt/slop/backup.env
cat > /etc/systemd/system/slop-backup.service <<'UNIT'
[Unit]
Description=slop nightly Postgres dump to S3
After=docker.service
[Service]
Type=oneshot
EnvironmentFile=/opt/slop/backup.env
ExecStart=/bin/bash /opt/slop/backup.sh
UNIT
cat > /etc/systemd/system/slop-backup.timer <<'UNIT'
[Unit]
Description=slop nightly Postgres dump
[Timer]
OnCalendar=*-*-* 03:17:00 UTC
Persistent=true
[Install]
WantedBy=timers.target
UNIT
systemctl daemon-reload
systemctl enable --now slop-backup.timer

compose() { SLOP_IMAGE="$1" POSTGRES_PASSWORD="$POSTGRES_PASSWORD" docker compose -f /opt/slop/compose.yaml -p slop "${@:2}"; }

wait_healthy() {
  # /auth/config needs no sign-in; the server answers only after its migrations have run.
  # Each attempt is bounded, so an app that accepts the connection but never answers still ends the wait and rolls back.
  for _ in $(seq 1 60); do
    if curl -fsS --connect-timeout 2 --max-time 5 -o /dev/null http://localhost:3000/auth/config; then return 0; fi
    sleep 3
  done
  return 1
}

ECR_HOST="${IMAGE%%/*}"
aws ecr get-login-password --region "$AWS_REGION" | docker login --username AWS --password-stdin "$ECR_HOST"
docker pull "$IMAGE"

compose "$IMAGE" up -d --remove-orphans
if wait_healthy; then
  echo "$IMAGE" > current-image
  echo "Deployed $IMAGE"
  docker image prune -f >/dev/null || true
  exit 0
fi

echo "ERROR: $IMAGE did not become healthy; logs follow" >&2
compose "$IMAGE" logs --tail 60 app >&2 || true
if [ -n "$PREVIOUS" ]; then
  echo "Rolling back to $PREVIOUS" >&2
  compose "$PREVIOUS" up -d --remove-orphans
  if wait_healthy; then echo "Rolled back to $PREVIOUS" >&2; else echo "ERROR: the previous image is not healthy either" >&2; fi
else
  echo "No previous release to roll back to" >&2
fi
exit 1
