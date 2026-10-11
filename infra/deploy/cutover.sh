#!/bin/bash
# Moves the boards' data from the laptop's Postgres to production (s15t51; the owner's checklist is CUTOVER.md).
# Runs on the laptop (macOS bash 3.2) with AWS credentials for production's account. The database work is
# cutover-remote.sh, run on the instance through SSM Run Command (uploaded with the dump to the backups bucket, which
# the instance role can read, and fetched by the SSM command) and locally against slop-postgres-1, so both sides count
# rows with the same code.
#
#   infra/deploy/cutover.sh prepare [--dry-run]          rehearsal, and step 1 of the real cutover: freeze, migration and
#                                                        disk-space checks, pg_dump, upload, restore into slop_restore on the instance,
#                                                        exact per-table row counts compared: PASS or FAIL. Nothing live is touched.
#   infra/deploy/cutover.sh swap <stamp> [--dry-run]     the cutover: after typed confirmation, make slop_restore production's
#                                                        live database (under the deploy lock; rolls back if the app doesn't come up)
#   infra/deploy/cutover.sh discard <stamp> [--dry-run]  after a rehearsal: drop slop_restore and the instance's copy of the files
#   infra/deploy/cutover.sh selftest [db]                local, no AWS: dump <db> (default slop), restore, compare counts, and
#                                                        swap and roll back between scratch databases
#
# Environment: STAGE (default prod), AWS_REGION (default us-east-1), AWS_PROFILE as usual, PG_CONTAINER (default
# slop-postgres-1). The instance, bucket and address are the outputs of the slop-<stage>-host stack.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
REMOTE="$HERE/cutover-remote.sh"
STAGE="${STAGE:-prod}"
AWS_REGION="${AWS_REGION:-us-east-1}"
PG_CONTAINER="${PG_CONTAINER:-slop-postgres-1}"
export PG_CONTAINER
RESTORE_DB=slop_restore
REMOTE_ROOT=/var/lib/slop/cutover
DRY_RUN=false

die() { echo "ERROR: $*" >&2; exit 1; }
mib() { echo "$(( $1 / 1048576 )) MiB"; }
usage() { sed -n '8,15p' "$0" | sed 's/^# \{0,1\}//' >&2; exit 2; }
valid_stamp() { [[ "$1" =~ ^[0-9]{14}$ ]] || die "the stamp is the 14 digits prepare printed, not $1"; }

# The production stack's outputs. A dry run without credentials prints placeholders instead.
discover() {
  local rows
  if rows="$(aws cloudformation describe-stacks --region "$AWS_REGION" --stack-name "slop-${STAGE}-host" \
    --query 'Stacks[0].Outputs[].[OutputKey,OutputValue]' --output text 2>/dev/null)"; then
    INSTANCE_ID="$(printf '%s\n' "$rows" | awk '$1 == "InstanceId" { print $2 }')"
    BACKUP_BUCKET="$(printf '%s\n' "$rows" | awk '$1 == "BackupBucket" { print $2 }')"
    PUBLIC_URL="$(printf '%s\n' "$rows" | awk '$1 == "PublicUrl" { print $2 }')"
  elif $DRY_RUN; then
    echo "(dry run: could not read the slop-${STAGE}-host outputs; showing placeholders)"
    INSTANCE_ID='<InstanceId>' BACKUP_BUCKET='<BackupBucket>' PUBLIC_URL='<PublicUrl>'
  else
    die "could not read the slop-${STAGE}-host stack's outputs in $AWS_REGION (credentials? region?)"
  fi
  [ -n "$INSTANCE_ID" ] && [ -n "$BACKUP_BUCKET" ] && [ -n "$PUBLIC_URL" ] || die "slop-${STAGE}-host is missing an output"
  echo "Stage ${STAGE}: instance ${INSTANCE_ID}, bucket ${BACKUP_BUCKET}, ${PUBLIC_URL}"
  if ! $DRY_RUN; then
    local ping
    ping="$(aws ssm describe-instance-information --region "$AWS_REGION" --filters "Key=InstanceIds,Values=${INSTANCE_ID}" \
      --query 'InstanceInformationList[0].PingStatus' --output text)"
    [ "$ping" = Online ] || die "the instance is not online in SSM (PingStatus ${ping})"
  fi
}

# Nothing may write to the local database while it is dumped: no dev.sh server or follow loop, no other connection.
# With `quiet` only the database's connections are checked (a scratch database for selftest).
freeze_problems() {
  local db="$1" scope="${2:-all}" n
  if [ "$scope" = all ]; then
    if command -v tmux >/dev/null 2>&1 && tmux has-session -t slop-dev 2>/dev/null; then echo "the dev.sh tmux session slop-dev is running"; fi
    if lsof -iTCP:3000 -sTCP:LISTEN -t >/dev/null 2>&1; then echo "something is listening on :3000"; fi
    if pgrep -f 'dev\.sh follow' >/dev/null 2>&1; then echo "dev.sh follow is running"; fi
  fi
  n="$(docker exec "$PG_CONTAINER" psql -U slop -d postgres -XAtc "select count(*) from pg_stat_activity where datname = '$db'")"
  if [ "$n" != 0 ]; then echo "$n connection(s) to the local $db database"; fi
}
check_freeze() {
  local problems
  problems="$(freeze_problems "$@")"
  [ -z "$problems" ] && return 0
  printf '%s\n' "$problems" | sed 's/^/  /' >&2
  if $DRY_RUN; then echo "(dry run: the real run refuses here)" >&2; return 0; fi
  die "the local slop is not frozen: Ctrl-C dev.sh follow, then scripts/dev.sh stop (sessions' servers use their own databases)"
}

upload() {
  if $DRY_RUN; then echo "would upload $(basename "$1") to $2"; return 0; fi
  aws s3 cp "$1" "$2" --region "$AWS_REGION" --only-show-errors
}

# How long the instance may run each step (the document's executionTimeout; SSM stops the script after it). The swap's
# worst case is the lock wait (300 s), the renames, the health wait (60 x (5 + 3) s) and the same again for a rollback.
MIGRATIONS_TIMEOUT=300
RESTORE_TIMEOUT=1800
SWAP_TIMEOUT=1800
DISCARD_TIMEOUT=300

# The instance's commands as AWS-RunShellScript parameters: ssm_json <file> <execution timeout> <command>... They are
# bucket names, paths and digits; anything a JSON string or the shell would treat specially is refused, not escaped.
ssm_json() {
  local file="$1" execution_timeout="$2" line sep=''
  shift 2
  [[ "$execution_timeout" =~ ^[0-9]+$ ]] || die "not a timeout in seconds: $execution_timeout"
  { printf '{"executionTimeout": ["%s"], "commands": [' "$execution_timeout"
    for line in "$@"; do
      case "$line" in *'"'* | *\\*) die "unexpected character in an SSM command: $line" ;; esac
      printf '%s\n  "%s"' "$sep" "$line"
      sep=','
    done
    printf '\n]}\n'
  } > "$file"
}

# ssm_run <comment> <json> <stdout file> <execution timeout> [hint]: sends the commands, waits as deploy.sh does, a
# little longer than the instance may run them, and leaves the instance's stdout in the file. Fails unless Success,
# after printing the hint.
ssm_run() {
  local comment="$1" json="$2" out="$3" timeout="$4" hint="${5:-}" command_id status=Pending
  if $DRY_RUN; then
    echo "--- would send to ${INSTANCE_ID} (${comment}):"
    cat "$json"
    : > "$out"
    return 0
  fi
  command_id="$(aws ssm send-command --region "$AWS_REGION" --instance-ids "$INSTANCE_ID" \
    --document-name AWS-RunShellScript --comment "$comment" --timeout-seconds 600 \
    --parameters "file://${json}" --query Command.CommandId --output text)"
  echo "SSM command ${command_id} (${comment})"
  for _ in $(seq 1 $((timeout / 5 + 24))); do
    sleep 5
    status="$(aws ssm get-command-invocation --region "$AWS_REGION" --command-id "$command_id" --instance-id "$INSTANCE_ID" \
      --query Status --output text 2>/dev/null || echo Pending)"
    case "$status" in Pending|InProgress|Delayed) ;; *) break ;; esac
  done
  aws ssm get-command-invocation --region "$AWS_REGION" --command-id "$command_id" --instance-id "$INSTANCE_ID" \
    --query StandardOutputContent --output text > "$out" || true
  aws ssm get-command-invocation --region "$AWS_REGION" --command-id "$command_id" --instance-id "$INSTANCE_ID" \
    --query StandardErrorContent --output text >&2 || true
  if [ "$status" != Success ]; then
    cat "$out"
    if [ -n "$hint" ]; then printf '%s\n' "$hint" >&2; fi
    die "the instance's ${comment} finished as ${status}"
  fi
}

# Prints the per-table comparison of two `counts` outputs and returns 0 only when every table matches. The second
# output must end with its COUNTS_END marker (SSM truncates long output).
compare_counts() {
  local expected="$1" actual="$2" listed
  listed="$(awk '$1 == "COUNTS_END" { print $2 }' "$actual")"
  [ -n "$listed" ] || { echo "the restore's output has no COUNTS_END line (failed or truncated):" >&2; cat "$actual" >&2; return 1; }
  [ "$(grep -c '^COUNT ' "$actual")" = "$listed" ] || { echo "the restore listed $listed tables but sent fewer" >&2; return 1; }
  awk 'FNR == NR { if ($1 == "COUNT") { e[$2] = $3; t[$2] = 1 } next }
       $1 == "COUNT" { a[$2] = $3; t[$2] = 1 }
       END { for (k in t) {
               same = (k in e) && (k in a) && e[k] == a[k]
               printf "%-44s %12s %12s  %s\n", k, ((k in e) ? e[k] : "-"), ((k in a) ? a[k] : "-"), (same ? "ok" : "DIFFERENT") } }' \
    "$expected" "$actual" | LC_ALL=C sort
  diff -q <(grep '^COUNT ' "$expected") <(grep '^COUNT ' "$actual") >/dev/null
}

prepare() {
  discover
  local stamp prefix dir s3 work local_level remote_level remote_free local_free db_bytes dump_bytes writes need
  stamp="$(date -u +%Y%m%d%H%M%S)"
  prefix="cutover/${stamp}"
  dir="${REMOTE_ROOT}/${stamp}"
  s3="s3://${BACKUP_BUCKET}/${prefix}"
  echo "Stamp ${stamp}; files go to ${s3}/"
  check_freeze slop
  work="$(mktemp -d "${TMPDIR:-/tmp}/slop-cutover.XXXXXX")"
  # The dump holds every board's data: it never outlives the script on the laptop.
  # shellcheck disable=SC2064  # expanded when set, on purpose: the locals are gone when the trap runs
  trap "rm -rf '$work'" EXIT

  # Production's image must be at exactly the laptop's migration level, or it would start on a database it doesn't
  # know (deploy current main, or bring the laptop to origin/main, then prepare again).
  local_level="$(bash "$REMOTE" migrations slop)"
  echo "Local:      ${local_level}"
  upload "$REMOTE" "${s3}/cutover-remote.sh"
  ssm_json "$work/migrations.json" "$MIGRATIONS_TIMEOUT" \
    "set -euo pipefail" \
    "install -d -m 700 ${REMOTE_ROOT} ${dir}" \
    "aws s3 cp ${s3}/cutover-remote.sh ${dir}/cutover-remote.sh --region ${AWS_REGION} --only-show-errors" \
    "bash ${dir}/cutover-remote.sh migrations slop" \
    "bash ${dir}/cutover-remote.sh diskfree /var/lib/slop"
  ssm_run "slop cutover ${stamp} migrations" "$work/migrations.json" "$work/migrations.out" "$MIGRATIONS_TIMEOUT"
  if ! $DRY_RUN; then
    remote_level="$(grep '^MIGRATIONS ' "$work/migrations.out" || true)"
    echo "Production: ${remote_level}"
    [ "$remote_level" = "$local_level" ] || die "migration levels differ: deploy current main to production or update the laptop, then prepare again"
  fi

  if $DRY_RUN; then
    echo "would check the free space here and on the instance, dump the local slop database (pg_dump -Fc), check it with"
    echo "pg_restore --list, and count its rows"
  else
    # A -Fc dump is smaller than the database, so the database's size is enough room for it here.
    db_bytes="$(bash "$REMOTE" size slop | awk '$1 == "SIZE" { print $2 }')"
    [ -n "$db_bytes" ] || die "could not read the local slop database's size"
    local_free="$(bash "$REMOTE" diskfree "$work" | awk '$1 == "DISKFREE" { print $2 }')"
    [ -n "$local_free" ] || die "could not read the free space in $work"
    [ "$local_free" -gt "$db_bytes" ] || die "$work has $(mib "$local_free") free, less than the database's $(mib "$db_bytes"); set TMPDIR to a disk with room"
    # Statistics before the dump: any insert, update or delete from here on changes the line swap compares, and so
    # does a restart, crash or stats reset of the local Postgres.
    writes="$(bash "$REMOTE" writes slop | grep '^WRITES ')"
    docker exec "$PG_CONTAINER" pg_dump -U slop -Fc slop > "$work/slop.dump"
    test -s "$work/slop.dump"
    docker exec -i "$PG_CONTAINER" pg_restore --list < "$work/slop.dump" > /dev/null
    (cd "$work" && shasum -a 256 slop.dump > slop.dump.sha256)
    # Counted after the dump: a write in between shows up as a FAIL below, never as a silent difference.
    bash "$REMOTE" counts slop > "$work/counts.txt"
    printf '%s\n' "$writes" >> "$work/counts.txt"
    dump_bytes="$(wc -c < "$work/slop.dump" | tr -d ' ')"
    echo "Dumped ${dump_bytes} bytes, $(grep -c '^COUNT ' "$work/counts.txt") tables"
    # The instance's data disk holds the live database, the dump while it is restored, and the restored copy (about
    # the laptop's database size); twice that leaves headroom for WAL, indexes and the live database's own growth.
    remote_free="$(awk '$1 == "DISKFREE" { print $2 }' "$work/migrations.out")"
    [ -n "$remote_free" ] || die "the instance did not report its free space"
    need=$(( (dump_bytes + db_bytes) * 2 ))
    echo "Instance data disk: $(mib "$remote_free") free, $(mib "$need") needed"
    [ "$remote_free" -gt "$need" ] || die "the instance's /var/lib/slop has $(mib "$remote_free") free, less than $(mib "$need") (twice the dump and the database); grow the data disk first. Clean up: infra/deploy/cutover.sh discard ${stamp}"
  fi
  upload "$work/slop.dump" "${s3}/slop.dump"
  upload "$work/slop.dump.sha256" "${s3}/slop.dump.sha256"
  upload "$work/counts.txt" "${s3}/counts.txt"

  # The dump is deleted from the instance's disk whatever the restore's outcome; slop_restore is all that stays.
  ssm_json "$work/restore.json" "$RESTORE_TIMEOUT" \
    "set -euo pipefail" \
    "for f in slop.dump slop.dump.sha256 counts.txt; do aws s3 cp ${s3}/\$f ${dir}/\$f --region ${AWS_REGION} --only-show-errors; done" \
    "cd ${dir}" \
    "sha256sum -c slop.dump.sha256" \
    "bash ${dir}/cutover-remote.sh restore ${dir}/slop.dump ${RESTORE_DB} || { rm -f ${dir}/slop.dump; exit 1; }" \
    "rm -f ${dir}/slop.dump"
  ssm_run "slop cutover ${stamp} restore" "$work/restore.json" "$work/restore.out" "$RESTORE_TIMEOUT"
  if $DRY_RUN; then echo "(dry run: nothing was dumped, uploaded or sent)"; return 0; fi

  printf '%-44s %12s %12s\n' table laptop production
  if compare_counts "$work/counts.txt" "$work/restore.out"; then
    echo "PASS: ${RESTORE_DB} on production matches the laptop's slop, table by table (stamp ${stamp})"
    echo "Rehearsal: infra/deploy/cutover.sh discard ${stamp}"
    echo "Cutover:   infra/deploy/cutover.sh swap ${stamp}   (keep the laptop frozen until then)"
  else
    echo "FAIL: the row counts differ; nothing live was touched. Look at the tables above, then prepare again." >&2
    echo "Clean up: infra/deploy/cutover.sh discard ${stamp}" >&2
    exit 1
  fi
}

swap() {
  local stamp="$1" dir s3 work answer writes_then writes_now
  valid_stamp "$stamp"
  discover
  dir="${REMOTE_ROOT}/${stamp}"
  s3="s3://${BACKUP_BUCKET}/cutover/${stamp}"
  check_freeze slop
  work="$(mktemp -d "${TMPDIR:-/tmp}/slop-cutover.XXXXXX")"
  # shellcheck disable=SC2064  # expanded when set, on purpose: the locals are gone when the trap runs
  trap "rm -rf '$work'" EXIT

  if ! $DRY_RUN; then
    # The laptop's data must not have moved since prepare, or production would lose what changed.
    aws s3 cp "${s3}/counts.txt" "$work/counts.txt" --region "$AWS_REGION" --only-show-errors
    bash "$REMOTE" counts slop > "$work/now.txt"
    diff <(grep '^COUNT ' "$work/counts.txt") <(grep '^COUNT ' "$work/now.txt") \
      || die "the local slop changed since prepare ${stamp}; prepare again"
    # Updates leave the counts alone; the statistics' running total of writes catches them. The total is only
    # comparable while the local Postgres runs on and its statistics aren't reset, so those two times must match too.
    writes_then="$(grep '^WRITES ' "$work/counts.txt" || true)"
    writes_now="$(bash "$REMOTE" writes slop | grep '^WRITES ')"
    [ -n "$writes_then" ] || die "prepare ${stamp} recorded no WRITES line (an older prepare?); prepare again"
    [ "$(echo "$writes_then" | wc -w | tr -d ' ')" = 4 ] || die "prepare ${stamp} recorded an older WRITES line (${writes_then}); prepare again"
    if [ "$writes_then" != "$writes_now" ]; then
      echo "  at prepare: rows written, Postgres started, stats reset: ${writes_then#WRITES }" >&2
      echo "  now:        rows written, Postgres started, stats reset: ${writes_now#WRITES }" >&2
      die "the local slop may have changed since prepare ${stamp}: it was written to, or the laptop's Postgres was restarted (or crashed, or its statistics were reset), so a write can't be ruled out. Run prepare again (a restart between prepare and swap always means preparing again)"
    fi
    echo "This replaces production's live database with ${RESTORE_DB} from ${stamp}; the current one is kept as slop_pre_cutover_${stamp}."
    read -r -p "Type the stage name (${STAGE}) to swap: " answer || die "no confirmation (stdin is not a terminal?); nothing changed"
    [ "$answer" = "$STAGE" ] || die "not confirmed; nothing changed"
  fi

  ssm_json "$work/swap.json" "$SWAP_TIMEOUT" \
    "set -euo pipefail" \
    "test -f ${dir}/cutover-remote.sh" \
    "bash ${dir}/cutover-remote.sh swap ${RESTORE_DB} ${dir}/counts.txt ${stamp}"
  ssm_run "slop cutover ${stamp} swap" "$work/swap.json" "$work/swap.out" "$SWAP_TIMEOUT" "$(swap_hint "$stamp")"
  cat "$work/swap.out"
  if $DRY_RUN; then echo "(dry run: nothing was sent)"; return 0; fi

  curl -fsS -o /dev/null "${PUBLIC_URL}/auth/config" || die "${PUBLIC_URL}/auth/config does not answer through CloudFront"
  bash "$HERE/verify.sh" "$PUBLIC_URL" || echo "verify.sh reported failures (above)" >&2
  echo "Swapped. Rollback while the laptop is unchanged: CUTOVER.md, 'Rolling back'. Then carry on with CUTOVER.md's Repoint section."
}

# What to do when the swap didn't end in Success: it may have rolled back, or stopped anywhere in between.
swap_hint() {
  cat <<HINT
The swap did not finish cleanly, and production's live database may be either one. Before anything else, look:
  aws ssm start-session --region ${AWS_REGION} --target ${INSTANCE_ID}   then: sudo -i
  docker exec slop-postgres-1 psql -U slop -d postgres -c '\l'
  slop_pre_cutover_${1} exists: the restored data is live as slop (the swap renamed and did not roll back).
  It doesn't, and ${RESTORE_DB} does: the old database is still slop (not swapped, or rolled back).
  curl -fsS --max-time 5 localhost:3000/auth/config   shows whether the app is up.
To go back by hand: CUTOVER.md, 'Rolling back' (the deploy lock, docker stop slop-app-1, the renames in one transaction).
HINT
}

discard() {
  local stamp="$1" work
  valid_stamp "$stamp"
  discover
  work="$(mktemp -d "${TMPDIR:-/tmp}/slop-cutover.XXXXXX")"
  # shellcheck disable=SC2064  # expanded when set, on purpose: the locals are gone when the trap runs
  trap "rm -rf '$work'" EXIT
  # The S3 copies can't be deleted by the instance; they expire with the bucket's 30-day rule like the backups.
  ssm_json "$work/discard.json" "$DISCARD_TIMEOUT" \
    "set -euo pipefail" \
    "test -f ${REMOTE_ROOT}/${stamp}/cutover-remote.sh" \
    "bash ${REMOTE_ROOT}/${stamp}/cutover-remote.sh drop ${RESTORE_DB}" \
    "rm -rf ${REMOTE_ROOT}/${stamp}"
  ssm_run "slop cutover ${stamp} discard" "$work/discard.json" "$work/discard.out" "$DISCARD_TIMEOUT"
  cat "$work/discard.out"
}

# The same restore, count and swap code as the real run, against scratch databases on the local Postgres.
selftest() {
  local source="${1:-slop}" scope=all work stamp previous
  local target=slop_cutover_selftest live=slop_cutover_selftest_live
  [[ "$source" =~ ^[a-z_][a-z0-9_]{0,62}$ ]] || die "not a plain database name: $source"
  case "$source" in slop_cutover_selftest*) die "pick a source other than the selftest's own databases" ;; esac
  [ "$source" = slop ] || scope=quiet
  check_freeze "$source" "$scope"
  stamp="$(date -u +%Y%m%d%H%M%S)"
  previous="${live}_pre_cutover_${stamp}"
  work="$(mktemp -d "${TMPDIR:-/tmp}/slop-cutover.XXXXXX")"
  # shellcheck disable=SC2064  # expanded when set, on purpose: the locals are gone when the trap runs
  trap "rm -rf '$work'; for d in $target $live $previous; do bash '$REMOTE' drop \$d >/dev/null 2>&1 || true; done" EXIT
  FAILED=0

  echo "Selftest: ${source} -> ${target} on ${PG_CONTAINER}"
  docker exec "$PG_CONTAINER" pg_dump -U slop -Fc "$source" > "$work/source.dump"
  test -s "$work/source.dump"
  docker exec -i "$PG_CONTAINER" pg_restore --list < "$work/source.dump" > /dev/null
  bash "$REMOTE" counts "$source" > "$work/expected.txt"

  bash "$REMOTE" restore "$work/source.dump" "$target" > "$work/restore.out"
  printf '%-44s %12s %12s\n' table source restored
  DESC="restore: every table's exact row count matches the source"
  if compare_counts "$work/expected.txt" "$work/restore.out"; then ok; else fail; fi

  DESC="restore and drop refuse the live database"
  check refuses_live "$work/source.dump" "$live"

  # A scratch "live" database stands in for production's slop: no app container, no lock, a file URL as the health check.
  bash "$REMOTE" restore "$work/source.dump" "$live" > /dev/null
  : > "$work/healthy"
  DESC="swap fails when the app never becomes healthy"
  check scratch_swap_fails "file://$work/missing" "$live" "$target" "$work/expected.txt" "$stamp"
  DESC="... and rolls back: both databases under their old names, no ${previous}"
  check databases "$target $live" "$previous"

  # The rollback leaves the target without sessions; restore it again, as the owner would prepare again.
  bash "$REMOTE" restore "$work/source.dump" "$target" > /dev/null
  DESC="swap succeeds when the app becomes healthy"
  check scratch_swap "file://$work/healthy" "$live" "$target" "$work/expected.txt" "$stamp"
  DESC="... the restored database is live and the old live one is kept as ${previous}"
  check databases "$live $previous" "$target"
  awk '$1 == "COUNT" && $2 == "public.sessions" { $3 = 0 } { print }' "$work/expected.txt" > "$work/expected-swapped.txt"
  bash "$REMOTE" counts "$live" > "$work/swapped.out"
  DESC="... with the source's rows, except sessions, which the swap clears"
  if compare_counts "$work/expected-swapped.txt" "$work/swapped.out" > /dev/null; then ok; else fail; fi

  DESC="writes: reads leave the total alone, an update that keeps the row counts moves it"
  check writes_moves "$live"
  DESC="writes: a stats reset followed by writes back to the same total still differs"
  check writes_reset_differs "$live"
  DESC="size and diskfree report byte counts"
  check reports_space "$live" "$work"

  if [ "$FAILED" != 0 ]; then echo "SELFTEST FAIL" >&2; exit 1; fi
  echo "SELFTEST PASS (the scratch databases are dropped on exit)"
}
ok() { echo "ok    $DESC"; }
fail() { echo "FAIL  $DESC"; FAILED=1; }
check() { if "$@" > /dev/null 2>&1; then ok; else fail; fi; }
has_db() { [ "$(docker exec "$PG_CONTAINER" psql -U slop -d postgres -XAtc "select count(*) from pg_database where datname = '$1'")" = 1 ]; }
# databases "<present ...>" "<absent ...>"
databases() {
  local d
  for d in $1; do has_db "$d" || return 1; done
  for d in $2; do if has_db "$d"; then return 1; fi; done
}
refuses_live() {
  if bash "$REMOTE" restore "$1" slop; then return 1; fi
  if bash "$REMOTE" drop slop; then return 1; fi
  if LIVE_DB="$2" bash "$REMOTE" drop "$2"; then return 1; fi
}
# scratch_swap <health url> <live db> <db> <expected counts> <stamp>
scratch_swap() {
  LIVE_DB="$2" APP_CONTAINER='' DEPLOY_LOCK=none HEALTH_ATTEMPTS=1 HEALTH_URL="$1" bash "$REMOTE" swap "$3" "$4" "$5"
}
scratch_swap_fails() { if scratch_swap "$@"; then return 1; fi; }
# writes_moves <scratch db>: what swap relies on to see an update-only change since prepare.
writes_moves() {
  local before after
  docker exec "$PG_CONTAINER" psql -U slop -d "$1" -v ON_ERROR_STOP=1 -XAtq \
    -c "create table cutover_selftest_probe (x int)" -c "insert into cutover_selftest_probe values (1)" || return 1
  before="$(bash "$REMOTE" writes "$1")" || return 1
  bash "$REMOTE" counts "$1" > /dev/null || return 1
  after="$(bash "$REMOTE" writes "$1")" || return 1
  [[ "$before" =~ ^WRITES\ [0-9]+\ [0-9T:.-]+Z\ ([0-9T:.-]+Z|-)$ ]] && [ "$before" = "$after" ] || return 1
  docker exec "$PG_CONTAINER" psql -U slop -d "$1" -v ON_ERROR_STOP=1 -XAtqc "update cutover_selftest_probe set x = 2" || return 1
  after="$(bash "$REMOTE" writes "$1")" || return 1
  [ "$before" != "$after" ]
}
# writes_reset_differs <scratch db>: reset the database's statistics, write one row, read the line; do the same again.
# The totals are equal (1 and 1), as after a reset and writes that climb back; the stats reset time tells them apart.
writes_reset_differs() {
  local first second
  first="$(reset_and_write_one "$1")" || return 1
  second="$(reset_and_write_one "$1")" || return 1
  [ "$(echo "$first" | cut -d' ' -f2)" = 1 ] && [ "$(echo "$second" | cut -d' ' -f2)" = 1 ] || return 1
  [ "$first" != "$second" ]
}
reset_and_write_one() {
  docker exec "$PG_CONTAINER" psql -U slop -d "$1" -v ON_ERROR_STOP=1 -XAtq \
    -c "select pg_stat_reset()" -c "update cutover_selftest_probe set x = x + 1" > /dev/null || return 1
  bash "$REMOTE" writes "$1"
}
reports_space() {
  [[ "$(bash "$REMOTE" size "$1")" =~ ^SIZE\ [1-9][0-9]*$ ]] && [[ "$(bash "$REMOTE" diskfree "$2")" =~ ^DISKFREE\ [1-9][0-9]*$ ]]
}

[ $# -ge 1 ] || usage
COMMAND="$1"
shift
ARG=""
NARGS=0
for arg in "$@"; do
  if [ "$arg" = --dry-run ]; then DRY_RUN=true; else ARG="$arg"; NARGS=$((NARGS + 1)); fi
done
case "$COMMAND" in
  prepare) [ "$NARGS" -eq 0 ] || usage; prepare ;;
  swap) [ "$NARGS" -eq 1 ] || usage; swap "$ARG" ;;
  discard) [ "$NARGS" -eq 1 ] || usage; discard "$ARG" ;;
  selftest)
    if $DRY_RUN; then die "selftest is local and has no --dry-run"; fi
    [ "$NARGS" -le 1 ] || usage
    selftest "${ARG:-slop}"
    ;;
  *) usage ;;
esac
