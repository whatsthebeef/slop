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

# merge_projects <existing> <add> <remove>: comma-separated CodeBuild project names in, one comma-separated list out:
# the existing names in order, then the added ones, without duplicates and without the removed ones. An added name that
# is not a valid CodeBuild project name ([A-Za-z0-9][A-Za-z0-9_-]{1,254}) fails, saying which, and prints nothing.
merge_projects() {
  local name out=() removed=",${3:-},"
  local IFS=,
  for name in ${2:-}; do
    [[ "$name" =~ ^[A-Za-z0-9][A-Za-z0-9_-]{1,254}$ ]] || { echo "ERROR: not a CodeBuild project name: $name" >&2; return 1; }
  done
  for name in ${1:-} ${2:-}; do
    [ -n "$name" ] || continue
    case "$removed" in *",$name,"*) continue ;; esac
    case ",${out[*]:-}," in *",$name,"*) ;; *) out+=("$name") ;; esac
  done
  echo "${out[*]:-}"
}

# needs_volume_handover <stack's VolumeAttachment ids> <the data volume's attachment state to the instance>: true when the
# volume is attached to the instance (a state such as "attached") but the stack owns no VolumeAttachment, so deploying
# the stack would fail with "already attached" and roll back. Either empty means there is nothing to hand over.
needs_volume_handover() {
  [ -z "${1:-}" ] && [ -n "${2:-}" ]
}

# change_set_refusals <stage>: reads a change set's resources on stdin, one per line and tab-separated:
# Action, LogicalResourceId, ResourceType, Replacement, comma-separated names of the changed properties. Prints one line
# per reason the host stack must not be deployed as it is, and nothing when the change set is fine: an instance that is
# replaced (Replacement True or Conditional), or a volume added in prod (production's data volume is never created by the stack).
change_set_refusals() {
  local stage="$1" action id type repl props
  while IFS=$'\t' read -r action id type repl props; do
    if [ "$type" = AWS::EC2::Instance ]; then
      case "$repl" in
        True|Conditional) echo "the instance $id would be replaced (Replacement: $repl${props:+, changing $props})" ;;
      esac
    fi
    if [ "$stage" = prod ] && [ "$type" = AWS::EC2::Volume ] && [ "$action" = Add ]; then
      echo "a data volume $id would be created"
    fi
  done
}

# change_set_restarts: reads the same lines and prints one line when the instance is modified in place in a way that
# stops and starts it (a changed userData or instance type), and nothing otherwise. A replacement is for change_set_refusals.
change_set_restarts() {
  local action id type repl props
  while IFS=$'\t' read -r action id type repl props; do
    [ "$type" = AWS::EC2::Instance ] && [ "$action" = Modify ] || continue
    case "$repl" in True|Conditional) continue ;; esac
    case ",$props," in *,UserData,*|*,InstanceType,*) echo "the instance $id would be stopped and started (changing $props)" ;; esac
  done
}

# instance_restarted <id before> <launch time before> <id after> <launch time after>: true when the instance was replaced
# (another id) or stopped and started (a new launch time), so the app is no longer running on it. Unknown values (empty)
# before the deploy mean there was no instance to lose.
instance_restarted() {
  [ -n "${1:-}" ] && { [ "$1" != "${3:-}" ] || [ "${2:-}" != "${4:-}" ]; }
}
