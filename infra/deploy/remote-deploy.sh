#!/bin/bash
# Runs on the instance (through SSM Run Command, from infra/deploy/deploy.sh): switches production to IMAGE.
# The new image is pulled before anything running is touched. If it doesn't answer its health check, the
# previous image is started again and the script fails, so CodeBuild goes red and the old release keeps serving.
#
# Environment: IMAGE (ECR URI with tag), MIN_FREE_MB (free disk required before the pull, default 4096), PUBLIC_URL (the public address), optionally PUBLIC_URL_ALIASES (other addresses that reach it), AWS_REGION, STAGE, BACKUP_BUCKET.
# Next to it, extracted from the same image by the SSM command: compose.yaml (compose.prod.yaml from the repo) and
# backup.sh (the nightly dump, scheduled below).
set -euo pipefail
: "${IMAGE:?}" "${PUBLIC_URL:?}" "${AWS_REGION:?}" "${STAGE:?}" "${BACKUP_BUCKET:?}"
cd /opt/slop

# One deploy at a time.
exec 9>/opt/slop/.deploy.lock
flock -w 300 9

# deploy-guards.sh arrives with the image, like this script.
. /opt/slop/deploy-guards.sh

PREVIOUS=""
if [ -f current-image ]; then PREVIOUS="$(cat current-image)"; fi

# Never replace a newer release with an older one (builds run in parallel and can finish out of order).
# COMMIT_TIME is the commit time of this build, from deploy.sh; current-commit-time is that of the running release.
if [ -f current-commit-time ] && is_older_than_running "${COMMIT_TIME:-}" "$(cat current-commit-time)"; then
  echo "Skipping $IMAGE: it is older than the running release $PREVIOUS"
  exit 0
fi

# An empty or missing data disk must fail the deploy; it must not start a new, empty database.
data_disk_guard /var/lib/slop

# Postgres' password is made once and lives on the data disk, so it survives a replaced instance.
PASSWORD_FILE=/var/lib/slop/postgres-password
if [ ! -s "$PASSWORD_FILE" ]; then
  (umask 077 && openssl rand -hex 24 > "$PASSWORD_FILE")
fi
POSTGRES_PASSWORD="$(cat "$PASSWORD_FILE")"

# The code view's clones live on the data disk; the image runs as `node` (uid 1000).
mkdir -p /var/lib/slop/code
chown 1000:1000 /var/lib/slop/code

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
  [ -z "${PUBLIC_URL_ALIASES:-}" ] || echo "PUBLIC_URL_ALIASES=${PUBLIC_URL_ALIASES}"
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

# Free MB on the filesystem holding Docker's images.
free_mb() { df -Pm /var/lib/docker | awk 'NR==2{print $4}'; }

# Keep the release now running ($IMAGE once deployed) and the one before it (for rollback); remove the other images
# of this repository, then dangling images and build cache. Images used by a running container are never removed
# (docker image rm is not forced). Best effort: a failure here is reported but never fails the deploy.
prune_images() {
  local repo="${IMAGE%:*}" before after running refs
  before="$(free_mb || echo 0)"
  running="$(docker ps --format '{{.Image}}' | sort -u | tr '\n' ' ')" || running=""
  refs="$(docker images --format '{{.Repository}}:{{.Tag}}' "$repo" | grep -v ':<none>$' || true)"
  # shellcheck disable=SC2086
  printf '%s\n' "$refs" | images_to_remove "$@" $running | while IFS= read -r ref; do
    docker image rm "$ref" >/dev/null 2>&1 || echo "Could not remove $ref"
  done || true
  docker image prune -f >/dev/null || true
  docker builder prune -f >/dev/null || true
  after="$(free_mb || echo 0)"
  echo "Pruned old images: $(( after - before )) MB freed, $after MB free"
}

# Room for the new image: MIN_FREE_MB (default 4096, about twice a release image) free on /var/lib/docker. If short,
# prune first; if still short, fail with a plain message instead of docker's bare "no space left on device".
MIN_FREE_MB="${MIN_FREE_MB:-4096}"
case "$MIN_FREE_MB" in '' | *[!0-9]*) echo "ERROR: MIN_FREE_MB must be a number of MB, got '$MIN_FREE_MB'" >&2; exit 1 ;; esac
if ! has_enough_disk "$(free_mb)" 0 "$MIN_FREE_MB"; then
  echo "Low disk: $(free_mb) MB free, need $MIN_FREE_MB MB; pruning old images before the pull"
  prune_images "$PREVIOUS" || true
  if ! has_enough_disk "$(free_mb)" 0 "$MIN_FREE_MB"; then
    echo "ERROR: $(disk_full_message "$(free_mb)" "$MIN_FREE_MB")" >&2
    exit 1
  fi
fi
docker pull "$IMAGE"

compose "$IMAGE" up -d --remove-orphans
if wait_healthy; then
  echo "$IMAGE" > current-image
  if [ -n "${COMMIT_TIME:-}" ]; then echo "$COMMIT_TIME" > current-commit-time; fi
  echo "Deployed $IMAGE"
  prune_images "$IMAGE" "$PREVIOUS" || echo "WARNING: pruning old images failed; the deploy itself succeeded" >&2
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
