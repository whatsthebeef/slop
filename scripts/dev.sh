#!/usr/bin/env bash
# Runs the local slop stack: Postgres (Docker), a fresh board build, the server on :3000
# (Cognito mode when apps/server/.env.cognito exists, otherwise dev sign-in) and, if
# SLOP_TUNNEL_DOMAIN is set in .slop-dev, an ngrok tunnel for webhooks and connectors.
# .slop-dev may also set AWS_PROFILE (Bedrock for intake).
#
# One server at a time, shared by every checkout: running dev.sh in a worktree switches :3000
# to that worktree's code (stopping whichever copy was running), and every checkout uses the
# same Postgres database. Before starting code whose migrations the database hasn't run, the
# database is snapshotted, so `restore` can roll it back when you switch to older code.
usage() {
  cat <<'EOF'
Usage: scripts/dev.sh [command]

  start        Start slop from this checkout in tmux session "slop-dev" and attach (the default).
               If another checkout's server is running, it is stopped first.
  watch        Like start, but reload on change: the server restarts when apps/server/src,
               packages/core/src or catalog/ change (snapshotting first if a new migration
               arrived), and the board rebuilds on change (reload the tab to see it).
  restart      Stop and start again, from this checkout, keeping watch mode if it was on.
  stop         Stop the server and the tunnel. Postgres keeps running.
  foreground   Run the server in this terminal (sstor's server window), stopping any other copy.
               `foreground watch` watches as `watch` does.
  snapshots    List database snapshots, newest first.
  restore [f]  Stop the server and restore the database from a snapshot (default: the newest).
  renumber-migrations [base]
               After merging main: renumber this branch's Drizzle migrations to follow main's
               (files, journal, snapshots, test references), then check drizzle-kit sees no
               drift. base defaults to origin/HEAD (else origin/main).
  session      A session's own stack (sstor's local-run launch): a database for the glob cloned
               from the shared one (reused if it exists), the server in watch mode on a free port
               with dev sign-in, and Vite in front of it; :3000 is left alone. Writes the board URL
               to $SLOP_URL_FILE (default .sstor/.url). SLOP_SESSION_JOBS picks the server's background
               jobs (SLOP_SESSION_JOBS: default none; e.g. kb). `session reset` re-clones the database.
  session-drop Drop this glob's session database.
  follow       Main checkout only: keep :3000 on origin/main. Polls origin/main (every
               SLOP_FOLLOW_INTERVAL seconds, default 60); on a move it fast-forwards, installs if
               the lockfile changed, snapshots and migrates, and restarts the server. It holds and
               says why when the tree is dirty, the history isn't a fast-forward or the database is
               ahead of main. The board shows each update or hold as a banner (.slop-dev-follow.json).
  help         Show this help.

Snapshots are taken automatically before code with new migrations starts, and kept (newest
10) in .slop-dev-snapshots/ in the main checkout.
EOF
}
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
# One Compose project for every checkout (main or worktree), so they share Postgres and its data.
export COMPOSE_PROJECT_NAME=slop
session=slop-dev
action="${1:-start}"
watch_mode=false
[[ "$action" == watch ]] && { action=start; watch_mode=true; }
[[ "$action" == foreground && "${2:-}" == watch ]] && watch_mode=true

# In a worktree, use the main checkout's gitignored local files (secrets, tunnel settings).
main_root="$(cd "$(git -C "$root" rev-parse --git-common-dir)/.." && pwd)"
if [[ "$main_root" != "$root" ]]; then
  for file in .slop-dev apps/server/.env.cognito apps/server/.github-app.json apps/server/.routines.json; do
    if [[ ! -e "$root/$file" && -e "$main_root/$file" ]]; then
      ln -s "$main_root/$file" "$root/$file"
      echo "Linked $file from $main_root"
    fi
  done
fi

if [[ -f "$root/.slop-dev" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$root/.slop-dev"
  set +a
fi

# The database is shared, so its snapshots are too.
snapshots="$main_root/.slop-dev-snapshots"
keep_snapshots=10

psql_slop() {
  (cd "$root" && docker compose exec -T postgres psql -U slop -v ON_ERROR_STOP=1 "$@")
}

postgres_up() {
  (cd "$root" && docker compose up -d --wait postgres)
}

# The checkout the running tmux server came from, if any.
running_root() {
  tmux show-environment -t "$session" SLOP_DEV_ROOT 2>/dev/null | sed -n 's/^SLOP_DEV_ROOT=//p'
}

# Whether the running tmux session was started in watch mode.
running_watch() {
  [[ "$(tmux show-environment -t "$session" SLOP_DEV_WATCH 2>/dev/null | sed -n 's/^SLOP_DEV_WATCH=//p')" == true ]]
}

stop() {
  tmux kill-session -t "$session" 2>/dev/null || true
  # A server started outside tmux (sstor's foreground window) would hold the port.
  lsof -ti tcp:3000 | xargs kill 2>/dev/null || true
  # A tunnel left over from an earlier run keeps the endpoint, and a new one can't start.
  if [[ -n "${SLOP_TUNNEL_DOMAIN:-}" ]]; then
    pkill -f "ngrok http --url=$SLOP_TUNNEL_DOMAIN" 2>/dev/null || true
  fi
}

snapshot() {
  local label="$1"
  mkdir -p "$snapshots"
  local file
  file="$snapshots/$(date -u +%Y%m%dT%H%M%SZ)-${label//[^A-Za-z0-9._-]/_}.dump"
  (cd "$root" && docker compose exec -T postgres pg_dump -U slop -d slop --format=custom) >"$file"
  echo "Database snapshot: $file (scripts/dev.sh restore rolls back to it)"
  # Keep the newest few.
  ls -1t "$snapshots"/*.dump | tail -n +$((keep_snapshots + 1)) | while read -r old; do rm -f "$old"; done
}

# Drizzle runs every migration in the journal newer than the newest one the database has run;
# compare the two before the server migrates on start.
check_migrations() {
  local applied
  applied="$(psql_slop -d slop -Atc \
    "select coalesce(max(created_at), 0) from drizzle.__drizzle_migrations" 2>/dev/null || echo 0)"
  local counts
  counts="$(node -e '
    const entries = require(process.argv[1]).entries;
    const applied = Number(process.argv[2]);
    const newer = entries.filter((e) => e.when > applied).map((e) => e.tag);
    const newest = Math.max(0, ...entries.map((e) => e.when));
    console.log(`${newer.length} ${applied > newest ? "ahead" : "ok"} ${newer.join(",")}`);
  ' "$root/apps/server/drizzle/meta/_journal.json" "$applied")"
  local pending state tags
  read -r pending state tags <<<"$counts"
  if [[ "$applied" != 0 && "$pending" -gt 0 ]]; then
    echo "This checkout has migrations the database hasn't run: ${tags//,/, }"
    snapshot "$(git -C "$root" rev-parse --abbrev-ref HEAD)"
  fi
  if [[ "$state" == ahead ]]; then
    echo "Warning: the database has run migrations this checkout doesn't have. If the server fails,"
    echo "roll the database back with scripts/dev.sh restore (scripts/dev.sh snapshots lists them)."
  fi
}

build_board() {
  (cd "$root/apps/web" && node node_modules/vite/bin/vite.js build --logLevel warn)
}

build_board_watch() {
  (cd "$root/apps/web" && node node_modules/vite/bin/vite.js build --watch --logLevel warn)
}

# The server command's node arguments, shared by every mode.
# Runs in apps/server; the env file is optional.
server_cmd() {
  local env_file=""
  [[ -f "$root/apps/server/.env.cognito" ]] && env_file="--env-file=.env.cognito"
  echo "node $env_file --env-file-if-exists=.env.local --conditions=development --import tsx src/main.ts"
}

# The server under the watcher; --before re-checks migrations (and snapshots) on each restart.
watched_server_cmd() {
  echo "node $root/scripts/dev-watch.mjs --before '$root/scripts/dev.sh check-migrations' $root/apps/server/src,$root/packages/core/src,$root/catalog -- $(server_cmd)"
}

# ngrok reports a failed tunnel only in its own window; say so here, since webhooks need it.
check_tunnel() {
  [[ -n "${SLOP_TUNNEL_DOMAIN:-}" ]] || return 0
  for _ in 1 2 3 4 5 6; do
    sleep 1
    if curl -s --max-time 2 http://127.0.0.1:4040/api/tunnels | grep -q "$SLOP_TUNNEL_DOMAIN"; then
      return 0
    fi
  done
  echo "Warning: the ngrok tunnel to https://$SLOP_TUNNEL_DOMAIN isn't up, so GitHub webhooks won't"
  echo "arrive. Is another ngrok holding the endpoint (ERR_NGROK_334)? Stop it and restart."
}

start() {
  if tmux has-session -t "$session" 2>/dev/null; then
    local other
    other="$(running_root)"
    if [[ "$other" == "$root" ]]; then
      echo "slop-dev is already running from this checkout (scripts/dev.sh restart to restart)"
      return
    fi
    echo "Switching :3000 from ${other:-another checkout} to $root"
  elif lsof -ti tcp:3000 >/dev/null 2>&1; then
    echo "Stopping the slop server already on :3000 (one server at a time)"
  fi
  stop
  postgres_up
  check_migrations
  build_board
  # tmux sessions inherit the tmux server's environment, so pass what the server needs.
  # LOCAL_SIGN_IN_WITHOUT_COOKIE: Chrome drops the sign-in state cookie on plain-http localhost.
  local env_args=(-e "LOCAL_SIGN_IN_WITHOUT_COOKIE=true")
  [[ -n "${AWS_PROFILE:-}" ]] && env_args+=(-e "AWS_PROFILE=$AWS_PROFILE")
  # The server watches the tunnel (through ngrok's local API) and shows a banner when it drops.
  [[ -n "${SLOP_TUNNEL_DOMAIN:-}" ]] && env_args+=(-e "SLOP_TUNNEL_DOMAIN=$SLOP_TUNNEL_DOMAIN")
  # Under dev.sh follow: the server shows follow's updates and holds, and records them as local deploys.
  [[ -n "${SLOP_FOLLOW_FILE:-}" ]] && env_args+=(-e "SLOP_FOLLOW_FILE=$SLOP_FOLLOW_FILE")
  tmux new-session -d -s "$session" ${env_args[@]+"${env_args[@]}"} -n server -c "$root/apps/server" \
    "$($watch_mode && watched_server_cmd || server_cmd); read"
  tmux set-environment -t "$session" SLOP_DEV_ROOT "$root"
  tmux set-environment -t "$session" SLOP_DEV_WATCH "$watch_mode"
  if $watch_mode; then
    tmux new-window -t "$session" -n board -c "$root" "$root/scripts/dev.sh board-watch; read"
  fi
  if [[ -n "${SLOP_TUNNEL_DOMAIN:-}" ]]; then
    tmux new-window -t "$session" -n tunnel "ngrok http --url=$SLOP_TUNNEL_DOMAIN 3000; read"
  fi
  echo "slop-dev started from $root: http://localhost:3000${SLOP_TUNNEL_DOMAIN:+ and https://$SLOP_TUNNEL_DOMAIN}"
  check_tunnel
}

foreground() {
  stop
  postgres_up
  check_migrations
  build_board
  if [[ -n "${SLOP_TUNNEL_DOMAIN:-}" ]]; then
    ngrok http --url="$SLOP_TUNNEL_DOMAIN" 3000 --log=false >/dev/null &
    tunnel_pid=$!
    trap 'kill "$tunnel_pid" 2>/dev/null || true' EXIT
    echo "Tunnel: https://$SLOP_TUNNEL_DOMAIN"
    check_tunnel
  fi
  local env_file=()
  [[ -f "$root/apps/server/.env.cognito" ]] && env_file=(--env-file=.env.cognito)
  cd "$root/apps/server"
  if $watch_mode; then
    build_board_watch &
    board_pid=$!
    trap 'kill "$board_pid" ${tunnel_pid:-} 2>/dev/null || true' EXIT
    LOCAL_SIGN_IN_WITHOUT_COOKIE=true node "$root/scripts/dev-watch.mjs" \
      --before "$root/scripts/dev.sh check-migrations" \
      "$root/apps/server/src,$root/packages/core/src,$root/catalog" -- \
      node ${env_file[@]+"${env_file[@]}"} --env-file-if-exists=.env.local --conditions=development --import tsx src/main.ts
    return
  fi
  LOCAL_SIGN_IN_WITHOUT_COOKIE=true node ${env_file[@]+"${env_file[@]}"} --env-file-if-exists=.env.local --conditions=development --import tsx src/main.ts
}

# A free TCP port from $1 upwards.
free_port() {
  local port="$1"
  while lsof -iTCP:"$port" -sTCP:LISTEN -t >/dev/null 2>&1; do port=$((port + 1)); done
  echo "$port"
}

# The session database's name: the glob (sstor's SLOP_GLOB, else the branch) as an identifier.
session_db() {
  local glob="${SLOP_GLOB:-$(git -C "$root" branch --show-current)}"
  glob="$(tr '[:upper:]' '[:lower:]' <<<"$glob" | tr -c 'a-z0-9_\n' '_')"
  [[ -n "$glob" && "$glob" != main ]] || { echo "dev.sh session: no glob (set SLOP_GLOB or check out a glob's branch)" >&2; exit 1; }
  echo "slop_$glob"
}

# A session's own stack, so a branch's migrations and code never reach the shared database or :3000.
session() {
  local db
  db="$(session_db)"
  postgres_up
  if [[ "${1:-}" == reset ]]; then
    psql_slop -d postgres -qc "drop database if exists \"$db\" with (force)"
  fi
  if [[ -z "$(psql_slop -d postgres -Atc "select 1 from pg_database where datname = '$db'")" ]]; then
    # pg_dump rather than CREATE DATABASE ... TEMPLATE: a template can't have connections, and
    # main's server is always connected. Cloned under a temporary name and renamed when complete,
    # so an interrupted clone is never reused.
    local cloning="${db}__cloning"
    echo "Cloning the shared database into $db"
    psql_slop -d postgres -qc "drop database if exists \"$cloning\" with (force)" -c "create database \"$cloning\" owner slop"
    if ! (cd "$root" && docker compose exec -T postgres bash -o pipefail -c \
      "pg_dump -U slop -d slop --format=custom | pg_restore -U slop -d '$cloning' --no-owner --exit-on-error"); then
      psql_slop -d postgres -qc "drop database if exists \"$cloning\" with (force)"
      echo "dev.sh session: cloning the shared database failed" >&2
      exit 1
    fi
    # The outbox rows queued before the clone are main's: an outbox switched on here would run them again.
    psql_slop -d "$cloning" -qc "update outbox set state = 'dropped', last_error = 'cloned into a session' where state = 'pending'"
    psql_slop -d postgres -qc "alter database \"$cloning\" rename to \"$db\""
  fi
  # SLOP_SESSION_JOBS, not SLOP_JOBS: a SLOP_JOBS meant for main's server (e.g. in .slop-dev) mustn't
  # switch jobs on in every session.
  local jobs="${SLOP_SESSION_JOBS:-none}"
  jobs="${jobs//[[:space:]]/}"
  jobs="${jobs:-none}"
  local api web offset
  # Each glob starts its search somewhere else, so sessions starting together rarely pick the same port.
  offset=$(( $(cksum <<<"$db" | cut -d' ' -f1) % 50 ))
  api="$(free_port $((3200 + offset)))"
  web="$(free_port $((5180 + offset)))"
  local env_file=()
  [[ -f "$root/apps/server/.env.cognito" ]] && env_file=(--env-file=.env.cognito)
  # The tunnel and webhooks stay with main's server.
  unset SLOP_TUNNEL_DOMAIN SLOP_FOLLOW_FILE
  (
    cd "$root/apps/server"
    # Set here, so the env files (which never override the environment) can't switch them back.
    export PORT="$api" DATABASE_URL="postgres://slop:slop@localhost:5432/$db" \
      PUBLIC_URL="http://localhost:$web" AUTH_MODE=dev SLOP_JOBS="$jobs"
    exec node "$root/scripts/dev-watch.mjs" "$root/apps/server/src,$root/packages/core/src,$root/catalog" -- \
      node ${env_file[@]+"${env_file[@]}"} --env-file-if-exists=.env.local --conditions=development --import tsx src/main.ts
  ) &
  local api_pid=$!
  (
    cd "$root/apps/web"
    SLOP_API_URL="http://localhost:$api" SLOP_WEB_PORT="$web" exec node node_modules/vite/bin/vite.js --strictPort
  ) &
  local web_pid=$!
  # Expanded now: the trap runs after this function's locals are gone. The ports as well as the pids,
  # because a server outlives its watcher if the watcher dies first.
  # shellcheck disable=SC2064
  trap "kill $api_pid $web_pid 2>/dev/null || true; lsof -t -i tcp:$api -i tcp:$web -sTCP:LISTEN | xargs kill 2>/dev/null || true" EXIT INT TERM HUP
  local url_file="${SLOP_URL_FILE:-$root/.sstor/.url}"
  mkdir -p "$(dirname "$url_file")"
  echo "http://localhost:$web" >"$url_file"
  echo "Session $db: board http://localhost:$web, API http://localhost:$api (jobs: $jobs)"
  wait || true
}

session_drop() {
  local db
  db="$(session_db)"
  psql_slop -d postgres -qc "drop database if exists \"$db\" with (force)"
  echo "Dropped $db"
}

# The follow loop's status, read by the server (SLOP_FOLLOW_FILE) for its banner and local deploys.
follow_file="$main_root/.slop-dev-follow.json"

follow_status() {
  # state, then key=value pairs; python3 writes the JSON so nothing needs shell quoting.
  local state="$1"; shift
  FOLLOW_STATE="$state" FOLLOW_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)" python3 - "$follow_file" "$@" <<'PY'
import json, os, sys
path, pairs = sys.argv[1], sys.argv[2:]
status = {"state": os.environ["FOLLOW_STATE"], "at": os.environ["FOLLOW_AT"]}
for pair in pairs:
    key, _, value = pair.partition("=")
    status[key] = value
tmp = path + ".tmp"
with open(tmp, "w") as f:
    json.dump(status, f)
os.replace(tmp, path)
PY
}

# Whether the shared database has run a migration that `ref`'s journal doesn't have.
database_ahead_of() {
  local applied
  applied="$(psql_slop -d slop -Atc \
    "select coalesce(max(created_at), 0) from drizzle.__drizzle_migrations" 2>/dev/null || echo 0)"
  git -C "$root" show "$1:apps/server/drizzle/meta/_journal.json" | node -e '
    let text = ""; process.stdin.on("data", (d) => (text += d)).on("end", () => {
      const newest = Math.max(0, ...JSON.parse(text).entries.map((e) => e.when));
      process.exit(Number(process.argv[1]) > newest ? 0 : 1);
    });' "$applied"
}

follow() {
  local base="${SLOP_FOLLOW_BASE:-main}"
  [[ "$root" == "$main_root" ]] || { echo "dev.sh follow runs only in the main checkout ($main_root)" >&2; exit 1; }
  [[ "$(git -C "$root" branch --show-current)" == "$base" ]] || { echo "dev.sh follow: check out $base first" >&2; exit 1; }
  local repo
  repo="$(git -C "$root" remote get-url origin | sed -E 's#^(https://[^/]+/|ssh://[^/]+/|git@[^:]+:)##; s#\.git$##')"
  export SLOP_FOLLOW_FILE="$follow_file"
  # The commit the server runs: an update is done only once the server restarted on it, so a
  # failed install or restart is retried on the next poll.
  local running
  running="$(git -C "$root" rev-parse HEAD)"
  follow_status following "sha=$running" "repo=$repo"
  # The server reads SLOP_FOLLOW_FILE, so (re)start it under follow.
  stop; start
  echo "Following origin/$base (every ${SLOP_FOLLOW_INTERVAL:-60}s). Ctrl-C stops following; the server keeps running."
  local held=false
  hold() {
    held=true
    follow_status held "sha=$running" "repo=$repo" "behind=$(git -C "$root" rev-list --count "$running..origin/$base")" \
      "reason=$1" "fix=$2"
    echo "follow: held: $1"
  }
  while true; do
    sleep "${SLOP_FOLLOW_INTERVAL:-60}"
    git -C "$root" fetch -q origin "$base" 2>/dev/null || { echo "follow: fetch failed; trying again"; continue; }
    local head target
    head="$(git -C "$root" rev-parse HEAD)"
    target="$(git -C "$root" rev-parse "origin/$base")"
    if [[ "$running" == "$target" && "$head" == "$target" ]]; then
      # Whatever held us was fixed without anything new to run.
      if $held; then held=false; follow_status following "sha=$running" "repo=$repo"; fi
      continue
    fi
    if [[ -n "$(git -C "$root" status --porcelain --untracked-files=no)" ]]; then
      hold "the main checkout has uncommitted changes" "Commit or discard them in $root; follow carries on by itself"
      continue
    fi
    if ! git -C "$root" merge-base --is-ancestor HEAD "origin/$base"; then
      hold "the main checkout has commits origin/$base doesn't" "Move them to a branch and reset $base to origin/$base"
      continue
    fi
    if database_ahead_of "origin/$base"; then
      hold "the database has run a migration main doesn't have (a branch's draft)" \
        "scripts/dev.sh restore to the snapshot from before it (scripts/dev.sh snapshots lists them)"
      continue
    fi
    if [[ "$head" != "$target" ]] && ! git -C "$root" merge -q --ff-only "origin/$base"; then
      hold "fast-forwarding to ${target:0:7} failed (an untracked file in the way?)" "See git status in $root"
      continue
    fi
    local changed subjects
    changed="$(git -C "$root" diff --name-only "$running" "$target")"
    subjects="$(git -C "$root" log -n 5 --format=%s "$running..$target" | paste -sd ';' -)"
    if grep -qx 'pnpm-lock.yaml' <<<"$changed" && ! (cd "$root" && corepack pnpm install --frozen-lockfile --silent); then
      hold "pnpm install failed for ${target:0:7}" "Run corepack pnpm install in $root and look at the error; follow tries again"
      continue
    fi
    local migrations log snapshot
    migrations="$(grep -o 'apps/server/drizzle/[0-9][^/]*\.sql' <<<"$changed" | xargs -n1 basename 2>/dev/null | sed 's/\.sql$//' | paste -sd ',' - || true)"
    # In the background and waited for: errexit holds inside the restart (a failed build or snapshot
    # stops it), which it wouldn't in a tested command or a command substitution.
    log="$(mktemp)"
    ( set -e; stop; start ) >"$log" 2>&1 &
    if ! wait $!; then
      cat "$log"; rm -f "$log"
      hold "restarting on ${target:0:7} failed" "See the follow window; follow tries again"
      continue
    fi
    cat "$log"
    # start snapshots the database itself when the new code brings migrations.
    snapshot="$(sed -n 's/^Database snapshot: \([^ ]*\).*/\1/p' "$log")"
    rm -f "$log"
    follow_status updated "sha=$target" "from=$running" "repo=$repo" "subjects=$subjects" \
      "migrations=$migrations" "snapshot=$snapshot"
    echo "follow: updated to ${target:0:7}${migrations:+ (migrations: $migrations)}"
    running="$target"
    held=false
  done
}

list_snapshots() {
  if ! ls -1t "$snapshots"/*.dump 2>/dev/null; then
    echo "No snapshots in $snapshots"
  fi
}

restore() {
  local file="${1:-}"
  if [[ -z "$file" ]]; then
    file="$(ls -1t "$snapshots"/*.dump 2>/dev/null | head -n 1 || true)"
    [[ -n "$file" ]] || { echo "No snapshots in $snapshots" >&2; exit 1; }
  fi
  [[ -f "$file" ]] || { echo "No such snapshot: $file" >&2; exit 1; }
  if [[ -t 0 ]]; then
    read -r -p "Replace the local slop database with $(basename "$file")? [y/N] " answer
    [[ "$answer" == y || "$answer" == Y ]] || exit 1
  fi
  stop
  postgres_up
  psql_slop -d postgres -qc 'drop database if exists slop with (force)' -c 'create database slop owner slop'
  (cd "$root" && docker compose exec -T postgres pg_restore -U slop -d slop --no-owner) <"$file"
  echo "Restored $(basename "$file"). Start the checkout that matches it with scripts/dev.sh start."
}

case "$action" in
  foreground) foreground; exit 0 ;;
  start) start ;;
  stop) stop ;;
  restart) running_watch && watch_mode=true; stop; start ;;
  check-migrations) check_migrations; exit 0 ;;
  session) session "${2:-}"; exit 0 ;;
  session-drop) session_drop; exit 0 ;;
  follow) follow; exit 0 ;;
  board-watch) build_board_watch; exit 0 ;;
  snapshots) list_snapshots; exit 0 ;;
  restore) restore "${2:-}"; exit 0 ;;
  renumber-migrations) exec node "$root/scripts/renumber-migrations.mjs" ${2:+"$2"} ;;
  help|-h|--help) usage; exit 0 ;;
  *) usage >&2; exit 1 ;;
esac

if [[ "$action" != stop && -z "${TMUX:-}" && -t 1 ]]; then
  tmux attach -t "$session"
fi
