#!/usr/bin/env bash
# Stores a developer's routine fire URL and token for local slop (apps/server/.routines.json,
# gitignored, readable only by you). With SLOP_SECRETS_PREFIX set (e.g. slop/prod/) it writes to Secrets
# Manager at <prefix>routines/<email>/<boardId|default> through the aws CLI instead; the server picks it up
# within SECRETS_CACHE_SECONDS (30), no restart.
# Usage: scripts/set-routine.sh <email> [boardId]
set -euo pipefail

email="${1:-}"
if [[ -z "$email" ]]; then
  echo "Usage: $0 <email>" >&2
  exit 1
fi

board="${2:-}"
file="$(cd "$(dirname "$0")/.." && pwd)/apps/server/.routines.json"
read -rp "Routine fire URL: " SLOP_ROUTINE_URL
read -rsp "Routine token (hidden): " SLOP_ROUTINE_TOKEN
echo

if [[ -n "${SLOP_SECRETS_PREFIX:-}" ]]; then
  name="${SLOP_SECRETS_PREFIX}routines/$(printf '%s' "$email" | tr '[:upper:]' '[:lower:]')/${board:-default}"
  value="$(SLOP_ROUTINE_URL="$SLOP_ROUTINE_URL" SLOP_ROUTINE_TOKEN="$SLOP_ROUTINE_TOKEN" python3 -c \
    'import json, os; print(json.dumps({"url": os.environ["SLOP_ROUTINE_URL"], "token": os.environ["SLOP_ROUTINE_TOKEN"]}))')"
  if aws secretsmanager describe-secret --secret-id "$name" >/dev/null 2>&1; then
    aws secretsmanager put-secret-value --secret-id "$name" --secret-string "$value" >/dev/null
  else
    aws secretsmanager create-secret --name "$name" --secret-string "$value" >/dev/null
  fi
  unset SLOP_ROUTINE_URL SLOP_ROUTINE_TOKEN value
  echo "Saved $name"
  exit 0
fi

SLOP_ROUTINE_FILE="$file" SLOP_ROUTINE_EMAIL="$email" SLOP_ROUTINE_URL="$SLOP_ROUTINE_URL" \
  SLOP_ROUTINE_TOKEN="$SLOP_ROUTINE_TOKEN" python3 - <<'PY'
import json, os
path = os.environ['SLOP_ROUTINE_FILE']
routines = json.load(open(path)) if os.path.exists(path) else {}
routines[os.environ['SLOP_ROUTINE_EMAIL'].lower()] = {
    'url': os.environ['SLOP_ROUTINE_URL'],
    'token': os.environ['SLOP_ROUTINE_TOKEN'],
}
with open(path, 'w') as f:
    json.dump(routines, f, indent=2)
os.chmod(path, 0o600)
print('Saved routines for:', ', '.join(sorted(routines)))
PY
unset SLOP_ROUTINE_URL SLOP_ROUTINE_TOKEN
