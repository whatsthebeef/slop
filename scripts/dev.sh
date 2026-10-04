#!/usr/bin/env bash
# Runs the local slop stack in a tmux session "slop-dev": Postgres (Docker), a fresh board
# build, the server (Cognito mode when apps/server/.env.cognito exists, otherwise dev sign-in)
# and, if SLOP_TUNNEL_DOMAIN is set in .slop-dev, an ngrok tunnel for webhooks and connectors.
# .slop-dev may also set AWS_PROFILE (Bedrock for intake).
# Usage: scripts/dev.sh [start|stop|restart]   (default: start, then attach)
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
session=slop-dev
action="${1:-start}"

if [[ -f "$root/.slop-dev" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$root/.slop-dev"
  set +a
fi

stop() {
  tmux kill-session -t "$session" 2>/dev/null || true
  # A server started outside tmux would hold the port.
  lsof -ti tcp:3000 | xargs kill 2>/dev/null || true
}

start() {
  if tmux has-session -t "$session" 2>/dev/null; then
    echo "slop-dev is already running (scripts/dev.sh restart to restart)"
    return
  fi
  (cd "$root" && docker compose up -d --wait postgres)
  (cd "$root/apps/web" && node node_modules/vite/bin/vite.js build --logLevel warn)

  local env_file=""
  [[ -f "$root/apps/server/.env.cognito" ]] && env_file="--env-file=.env.cognito"
  # tmux sessions inherit the tmux server's environment, so pass what the server needs.
  local env_args=()
  [[ -n "${AWS_PROFILE:-}" ]] && env_args+=(-e "AWS_PROFILE=$AWS_PROFILE")
  tmux new-session -d -s "$session" ${env_args[@]+"${env_args[@]}"} -n server -c "$root/apps/server" \
    "node $env_file --env-file-if-exists=.env.local --conditions=development --import tsx src/main.ts; read"
  if [[ -n "${SLOP_TUNNEL_DOMAIN:-}" ]]; then
    tmux new-window -t "$session" -n tunnel "ngrok http --url=$SLOP_TUNNEL_DOMAIN 3000; read"
  fi
  echo "slop-dev started: http://localhost:3000${SLOP_TUNNEL_DOMAIN:+ and https://$SLOP_TUNNEL_DOMAIN}"
}

case "$action" in
  start) start ;;
  stop) stop ;;
  restart) stop; start ;;
  *) echo "Usage: $0 [start|stop|restart]" >&2; exit 1 ;;
esac

if [[ "$action" != stop && -z "${TMUX:-}" && -t 1 ]]; then
  tmux attach -t "$session"
fi
