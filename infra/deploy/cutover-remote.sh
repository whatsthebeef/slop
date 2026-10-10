#!/bin/bash
# The database half of the cutover from the laptop to production (infra/deploy/cutover.sh; checklist in CUTOVER.md).
# Runs on the instance as root through SSM Run Command, fetched from the backups bucket, and on the laptop against the
# local Postgres (source counts, selftest), so what is counted and restored is the same code on both sides.
#
#   cutover-remote.sh migrations <db>                        MIGRATIONS <count> <newest created_at> <newest hash>
#   cutover-remote.sh counts <db>                            exact count(*) per base table in public and drizzle
#   cutover-remote.sh restore <dumpfile> <db>                pg_restore into a fresh <db> (never the live database)
#   cutover-remote.sh swap <db> <expected-counts-file> <stamp>  make <db> the live database (instance; under the deploy lock)
#   cutover-remote.sh drop <db>                              drop a rehearsal database (never the live database)
#   cutover-remote.sh writes <db>                            WRITES <rows inserted + updated + deleted> <postmaster start> <stats reset or ->
#   cutover-remote.sh size <db>                              SIZE <bytes on disk>
#   cutover-remote.sh diskfree <dir>                         DISKFREE <bytes free on the filesystem holding dir>
#
# Environment: PG_CONTAINER (default slop-postgres-1). Only `swap` touches the live database; selftest points these at
# scratch names: LIVE_DB (slop), APP_CONTAINER (slop-app-1; empty: no app to stop and start), DEPLOY_LOCK
# (/opt/slop/.deploy.lock; `none`: no lock), HEALTH_URL (http://localhost:3000/auth/config), HEALTH_ATTEMPTS (60, 3 s apart, each at most 5 s).
set -euo pipefail
PG_CONTAINER="${PG_CONTAINER:-slop-postgres-1}"
LIVE_DB="${LIVE_DB:-slop}"
APP_CONTAINER="${APP_CONTAINER-slop-app-1}"
DEPLOY_LOCK="${DEPLOY_LOCK:-/opt/slop/.deploy.lock}"
HEALTH_URL="${HEALTH_URL:-http://localhost:3000/auth/config}"
HEALTH_ATTEMPTS="${HEALTH_ATTEMPTS:-60}"

die() { echo "ERROR: $*" >&2; exit 1; }
# Database names go into SQL unquoted, so only plain lowercase identifiers are accepted.
valid_name() { [[ "$1" =~ ^[a-z_][a-z0-9_]{0,62}$ ]] || die "not a plain database name: $1"; }
# Neither restore nor drop ever targets the live database (nor `slop` itself, whatever LIVE_DB says).
not_live() { valid_name "$1"; if [ "$1" = slop ] || [ "$1" = "$LIVE_DB" ]; then die "refusing to touch the live database $1"; fi; }
# Only psql_stdin passes stdin through (-i): the -c calls must not read the caller's stdin, or the laptop's commands
# before swap's confirmation prompt would swallow what is typed or piped into it.
psql_in() { local db="$1"; shift; docker exec "$PG_CONTAINER" psql -U slop -d "$db" -v ON_ERROR_STOP=1 -XAtq "$@"; }
psql_stdin() { local db="$1"; shift; docker exec -i "$PG_CONTAINER" psql -U slop -d "$db" -v ON_ERROR_STOP=1 -XAtq "$@"; }
exists() { [ "$(psql_in postgres -c "select count(*) from pg_database where datname = '$1'")" = 1 ]; }
connections() { psql_in postgres -c "select count(*) from pg_stat_activity where datname = '$1'"; }

migrations() {
  valid_name "$1"
  psql_in "$1" -F ' ' -c "select 'MIGRATIONS', count(*), coalesce(max(created_at)::text, '-'),
    coalesce((select hash from drizzle.__drizzle_migrations order by created_at desc, id desc limit 1), '-')
    from drizzle.__drizzle_migrations"
}

# Exact counts (not pg_stat estimates) in one repeatable-read snapshot, one COUNT line per table, then an end marker so
# a reader can tell a complete list from a truncated one (SSM keeps only the first 24,000 characters of output).
counts() {
  valid_name "$1"
  local out
  out="$(psql_stdin "$1" -F ' ' <<'SQL'
begin transaction isolation level repeatable read read only;
select 'COUNT', format('%I.%I', table_schema, table_name),
  (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from %I.%I', table_schema, table_name), false, true, '')))[1]::text::bigint
from information_schema.tables
where table_schema in ('public', 'drizzle') and table_type = 'BASE TABLE';
commit;
SQL
)"
  [ -n "$out" ] || die "no tables in $1"
  printf '%s\n' "$out" | LC_ALL=C sort
  echo "COUNTS_END $(printf '%s\n' "$out" | wc -l | tr -d ' ')"
}

restore() {
  local file="$1" db="$2"
  not_live "$db"
  [ -s "$file" ] || die "no dump at $file"
  if exists "$db" && [ "$(connections "$db")" != 0 ]; then die "$db has open connections"; fi
  # A failed restore drops what it made, so a partial database is never counted or swapped.
  (
    set -e
    docker exec "$PG_CONTAINER" dropdb -U slop --if-exists "$db"
    docker exec "$PG_CONTAINER" createdb -U slop "$db"
    docker exec -i "$PG_CONTAINER" pg_restore -U slop -d "$db" --no-owner --exit-on-error < "$file"
  ) &
  if ! wait $!; then
    docker exec "$PG_CONTAINER" dropdb -U slop --if-exists "$db" || true
    die "restoring $file into $db failed"
  fi
  echo "Restored into $db"
  counts "$db"
}

drop() {
  not_live "$1"
  if exists "$1" && [ "$(connections "$1")" != 0 ]; then die "$1 has open connections"; fi
  docker exec "$PG_CONTAINER" dropdb -U slop --if-exists "$1"
  echo "Dropped $1"
}

# Every row inserted, updated or deleted in the database since its statistics were reset. Reads don't move it, so the
# laptop compares it between prepare and swap to catch an update that leaves the row counts as they were. A backend
# flushes its statistics when it disconnects, and both checks run with no connection to the database left. The total
# alone could come back to the same value (a crash zeroes it, as does pg_stat_reset, and later writes can climb back),
# so the server's start time (a crash or restart changes it) and the database's stats reset time (pg_stat_reset changes
# it) go with it, all three compared. Timestamps are UTC with no spaces, so the line splits on spaces.
writes() {
  valid_name "$1"
  psql_in "$1" -F ' ' -c "select 'WRITES',
    (select coalesce(sum(n_tup_ins + n_tup_upd + n_tup_del), 0) from pg_stat_user_tables),
    to_char(pg_postmaster_start_time() at time zone 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"'),
    coalesce((select to_char(stats_reset at time zone 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"')
      from pg_stat_database where datname = current_database()), '-')"
}

size() {
  valid_name "$1"
  psql_in postgres -F ' ' -c "select 'SIZE', pg_database_size('$1')"
}

# df -P prints one line per filesystem: name, 1024-blocks, used, available, capacity (n%), mount point. The name and the
# mount point may contain spaces, so the fields are found from the capacity: the first n% with three numbers before it.
diskfree() {
  local kib
  [ -d "$1" ] || die "no directory $1"
  kib="$(df -Pk "$1" | awk 'NR == 2 { for (i = 4; i <= NF; i++) if ($i ~ /^[0-9]+%$/ && $(i-1) ~ /^[0-9]+$/ && $(i-2) ~ /^[0-9]+$/ && $(i-3) ~ /^[0-9]+$/) { print $(i-1); exit } }')"
  [[ "$kib" =~ ^[0-9]+$ ]] || die "could not read the free space of $1 from df -Pk"
  echo "DISKFREE $(( kib * 1024 ))"
}

wait_healthy() {
  # The deploy's check: /auth/config needs no sign-in and answers only after the migrations have run. Each attempt is
  # bounded, so an app that accepts the connection and never answers still reaches the rollback.
  for _ in $(seq 1 "$HEALTH_ATTEMPTS"); do
    if curl -fsS --max-time 5 -o /dev/null "$HEALTH_URL" 2>/dev/null; then return 0; fi
    sleep 3
  done
  return 1
}
app_stop() { if [ -n "$APP_CONTAINER" ]; then docker stop "$APP_CONTAINER" >/dev/null; fi; }
app_start() { if [ -n "$APP_CONTAINER" ]; then docker start "$APP_CONTAINER" >/dev/null; fi; }

# Renames run from the postgres database once nothing else is connected to either side. Both renames are one
# transaction. pg_terminate_backend waits up to 5 s per connection; a reconnect in between (a health probe) is retried.
rename_pair() {
  local from1="$1" to1="$2" from2="$3" to2="$4" sql
  sql="select pg_terminate_backend(pid, 5000) from pg_stat_activity where datname in ('$from1', '$from2') and pid <> pg_backend_pid();"
  for attempt in 1 2 3 4 5; do
    psql_in postgres -c "$sql" >/dev/null || true
    if psql_in postgres -1 -c "alter database $from1 rename to $to1" -c "alter database $from2 rename to $to2"; then return 0; fi
    echo "rename attempt $attempt failed; retrying" >&2
    sleep 2
  done
  return 1
}

swap() {
  local db="$1" expected="$2" stamp="$3"
  not_live "$db"
  valid_name "$LIVE_DB"
  [[ "$stamp" =~ ^[0-9]{14}$ ]] || die "stamp must be 14 digits (YYYYMMDDHHMMSS), not $stamp"
  [ -s "$expected" ] || die "no expected counts at $expected"
  local previous="${LIVE_DB}_pre_cutover_${stamp}"
  valid_name "$previous"

  # One deploy or swap at a time: a push to main must not restart the app halfway through.
  if [ "$DEPLOY_LOCK" != none ]; then
    exec 9>"$DEPLOY_LOCK"
    flock -w 300 9 || die "could not take $DEPLOY_LOCK (a deploy is running)"
  fi

  exists "$db" || die "$db does not exist (run cutover.sh prepare first)"
  exists "$LIVE_DB" || die "the live database $LIVE_DB does not exist"
  if exists "$previous"; then die "$previous already exists"; fi
  [ "$(connections "$db")" = 0 ] || die "$db has open connections"

  # The restored database must still be exactly what the laptop sent, at the live database's migration level (a
  # deploy since `prepare` may have migrated the live one; then prepare again).
  local now
  now="$(mktemp "${TMPDIR:-/tmp}/cutover-counts.XXXXXX")"
  counts "$db" > "$now"
  if ! diff <(grep '^COUNT ' "$expected") <(grep '^COUNT ' "$now"); then
    rm -f "$now"
    die "$db's row counts differ from $expected; not swapping"
  fi
  rm -f "$now"
  local restored_level live_level
  restored_level="$(migrations "$db")"
  live_level="$(migrations "$LIVE_DB")"
  if [ "$restored_level" != "$live_level" ]; then
    echo "restored: $restored_level" >&2
    echo "live:     $live_level" >&2
    die "migration levels differ; run cutover.sh prepare again"
  fi

  echo "Stopping ${APP_CONTAINER:-the app (none)}"
  app_stop
  (
    set -e
    rename_pair "$LIVE_DB" "$previous" "$db" "$LIVE_DB"
    # Laptop cookies are no use on production; no stale session secret stays live.
    psql_in "$LIVE_DB" -c "delete from sessions"
    app_start
    wait_healthy
  ) &
  if wait $!; then
    echo "Swapped: $db is now $LIVE_DB; the previous live database is $previous"
    return 0
  fi

  echo "ERROR: the swap failed or the app did not become healthy; rolling back" >&2
  if [ -n "$APP_CONTAINER" ]; then docker logs --tail 60 "$APP_CONTAINER" >&2 || true; fi
  app_stop || true
  local present
  if ! present="$(psql_in postgres -c "select count(*) from pg_database where datname = '$previous'")"; then
    echo "ERROR: could not tell whether $previous exists (is Postgres up?), so nothing was renamed back and the state is" >&2
    echo "unknown: list the databases by hand and roll back as in CUTOVER.md, 'Rolling back'" >&2
  elif [ "$present" = 1 ]; then
    rename_pair "$LIVE_DB" "$db" "$previous" "$LIVE_DB" || die "ROLLBACK FAILED: rename $LIVE_DB to $db and $previous to $LIVE_DB by hand (CUTOVER.md)"
    # The sessions are gone from $db now, so its counts no longer match: a second attempt starts from prepare.
    echo "Renamed back: $previous is $LIVE_DB again, the restored database is $db" >&2
  fi
  app_start || true
  if wait_healthy; then echo "Rolled back: $LIVE_DB is the previous live database again" >&2
  else echo "ERROR: the app is not healthy after the rollback either" >&2; fi
  exit 1
}

case "${1:-}" in
  migrations) migrations "${2:?usage: migrations <db>}" ;;
  counts) counts "${2:?usage: counts <db>}" ;;
  restore) restore "${2:?usage: restore <dumpfile> <db>}" "${3:?usage: restore <dumpfile> <db>}" ;;
  swap) swap "${2:?usage: swap <db> <expected-counts-file> <stamp>}" "${3:?usage: swap <db> <expected-counts-file> <stamp>}" "${4:?usage: swap <db> <expected-counts-file> <stamp>}" ;;
  drop) drop "${2:?usage: drop <db>}" ;;
  writes) writes "${2:?usage: writes <db>}" ;;
  size) size "${2:?usage: size <db>}" ;;
  diskfree) diskfree "${2:?usage: diskfree <dir>}" ;;
  *) echo "usage: cutover-remote.sh migrations|counts|restore|swap|drop|writes|size|diskfree ..." >&2; exit 2 ;;
esac
