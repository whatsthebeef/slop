#!/bin/bash
# Nightly Postgres dump to S3 (run by slop-backup.timer on the instance; installed by remote-deploy.sh).
# pg_dump -Fc inside the Postgres container, to a temp file on the data disk, then one upload to
# s3://<bucket>/postgres/YYYY/MM/DD/slop-<timestamp>.dump. A bucket lifecycle rule expires objects after 30 days.
# Each run reports DumpSucceeded (1 or 0) to CloudWatch (namespace Slop/Backup); the alarm in host-stack.ts fires
# when no success has been reported for 25 hours.
#
# Environment (from /opt/slop/backup.env): BACKUP_BUCKET, AWS_REGION.
set -euo pipefail
: "${BACKUP_BUCKET:?}" "${AWS_REGION:?}"

report() {
  aws cloudwatch put-metric-data --region "$AWS_REGION" --namespace Slop/Backup \
    --metric-name DumpSucceeded --value "$1" --unit Count || echo "could not report the backup result" >&2
}
TMP_DIR=/var/lib/slop/backup-tmp
FILE="$TMP_DIR/slop.dump"
cleanup() { rm -f "$FILE"; }
failed() { report 0; echo "ERROR: backup failed" >&2; }
trap cleanup EXIT
trap failed ERR

mkdir -p "$TMP_DIR"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
KEY="postgres/$(date -u +%Y/%m/%d)/slop-${STAMP}.dump"

docker exec -i slop-postgres-1 pg_dump -U slop -Fc slop > "$FILE"
# A dump that is not a readable archive is a failed backup.
test -s "$FILE"
docker exec -i slop-postgres-1 pg_restore --list < "$FILE" > /dev/null

aws s3 cp "$FILE" "s3://${BACKUP_BUCKET}/${KEY}" --region "$AWS_REGION" --only-show-errors
report 1
echo "Backed up to s3://${BACKUP_BUCKET}/${KEY} ($(stat -c %s "$FILE") bytes)"
