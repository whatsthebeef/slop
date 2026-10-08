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
