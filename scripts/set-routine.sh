#!/usr/bin/env bash
# Stores a developer's routine fire URL and token for local slop (apps/server/.routines.json,
# gitignored, readable only by you). Production uses Secrets Manager at slop/routines/<email>.
# Usage: scripts/set-routine.sh <email>
set -euo pipefail

email="${1:-}"
if [[ -z "$email" ]]; then
  echo "Usage: $0 <email>" >&2
  exit 1
fi

file="$(cd "$(dirname "$0")/.." && pwd)/apps/server/.routines.json"
read -rp "Routine fire URL: " SLOP_ROUTINE_URL
read -rsp "Routine token (hidden): " SLOP_ROUTINE_TOKEN
echo

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
