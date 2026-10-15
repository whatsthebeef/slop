#!/bin/bash
# Decisions the deploy scripts make that need no AWS, kept as small functions so infra/test/deploy-guards.test.ts can run them.
# Sourced by deploy.sh (CodeBuild) and remote-deploy.sh (the instance); defines functions only.

# is_superseded <this-commit> <head-of-main>: true when main has moved past this build's commit.
# An empty head (the lookup failed) is not "superseded": the deploy goes ahead rather than being lost.
is_superseded() {
  [ -n "${2:-}" ] && [ "$1" != "$2" ]
}

# is_older_than_running <this-commit-time> <running-commit-time>: true when the release being deployed was committed
# before the one already running (epoch seconds). Unknown times (empty) never block a deploy.
is_older_than_running() {
  [ -n "${1:-}" ] && [ -n "${2:-}" ] && [ "$1" -lt "$2" ]
}

# data_disk_guard <data-dir>: fails, saying why, when <data-dir> is not the real data disk or holds no database,
# unless SLOP_FIRST_DEPLOY=1 (a new install). SLOP_SKIP_MOUNT_CHECK=1 is for tests only.
data_disk_guard() {
  local dir="$1"
  if [ "${SLOP_SKIP_MOUNT_CHECK:-}" != 1 ] && ! mountpoint -q "$dir"; then
    echo "ERROR: data disk not mounted at $dir; nothing was changed" >&2
    return 1
  fi
  if [ "${SLOP_FIRST_DEPLOY:-}" = 1 ]; then return 0; fi
  if [ ! -f "$dir/postgres/PG_VERSION" ] || [ ! -s "$dir/postgres-password" ]; then
    echo "ERROR: data disk has no database: re-attach the data volume, or set SLOP_FIRST_DEPLOY=1 for a new install" >&2
    return 1
  fi
}

# images_to_remove <keep-ref>...: reads image refs (repo:tag), one per line, on stdin and prints those not listed as
# arguments. Empty arguments are ignored, so an unknown previous release keeps nothing extra. The caller passes the
# release now running, the one before it (kept for rollback) and any image a running container uses.
images_to_remove() {
  local ref keep k
  while IFS= read -r ref; do
    [ -n "$ref" ] || continue
    keep=0
    for k in "$@"; do
      if [ -n "$k" ] && [ "$ref" = "$k" ]; then keep=1; break; fi
    done
    [ "$keep" = 1 ] || printf '%s\n' "$ref"
  done
}

# has_enough_disk <free-mb> <image-mb> <margin-mb>: true when the free space covers the image plus the margin.
# An unknown image size (empty) counts as 0, so only the margin is required.
has_enough_disk() {
  [ -n "${1:-}" ] && [ "$1" -ge $(( ${2:-0} + ${3:-0} )) ]
}

# disk_full_message <free-mb> <need-mb>: the failure text for a disk too full to pull the image.
disk_full_message() {
  echo "instance disk full: $(( $1 / 1024 )) GB free, need $(( ($2 + 1023) / 1024 )) GB; prune images or grow the root volume"
}
