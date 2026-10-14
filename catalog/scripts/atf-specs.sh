#!/usr/bin/env bash
# .sstor/atf-specs.sh [environment] [report dir]: asks slop which acceptance test (ATF) specs to run for the deploy
# that was just made, and exports the answer for .sstor/atf.sh. SOURCE it, so the exports reach the build's shell:
#
#   . .sstor/atf-specs.sh "$SLOP_ENVIRONMENT" reports/atf      # (buildspec-atf.yml does this)
#
# It exports:
#   SLOP_ATF_SPECS  the specs to run, one repo-relative path per line (empty: run the board's default suite)
#   SLOP_ATF_GREP   an optional Playwright --grep pattern (several are combined as an alternation)
# and keeps the full answer in <report dir>/specs.json, which atf-report.sh reads to report planned specs it
# found no test for as `missing`. .sstor/atf.sh runs only the listed specs when the list isn't empty, e.g.:
#
#   args=()
#   while IFS= read -r spec; do [ -n "$spec" ] && args+=("$spec"); done <<< "${SLOP_ATF_SPECS:-}"
#   npx playwright test ${SLOP_ATF_GREP:+--grep "$SLOP_ATF_GREP"} ${args[@]+"${args[@]}"}
#
# Where it asks, and with what (set by the project's environment variables; nothing here names a board):
#   SLOP_URL       slop's address, e.g. https://slop.example.com
#   SLOP_BOARD     the board's number
#   SLOP_TOKEN     the board's integration token (a bearer credential that can read this list)
#   SLOP_ENVIRONMENT, SLOP_SHA   the environment tested and the commit it runs (the first argument overrides the
#                  environment; the commit falls back to CODEBUILD_RESOLVED_SOURCE_VERSION when that is a SHA)
#   SLOP_ATF_ENDPOINT      the full URL to ask, instead of $SLOP_URL/integrations/boards/$SLOP_BOARD/atf-specs
#   SLOP_ATF_WAIT          seconds to wait for slop to finish checking the deploy (default 120)
#   SLOP_ATF_POLL_SECONDS  seconds between asks while it is checking (default: what slop says, at most 30)
#
# When slop starts the build itself (a push-mode board) the list is already in SLOP_ATF_SPECS (even if empty), and
# this script asks for nothing. It never fails the pipeline: any problem is a warning, the list stays empty and
# the default suite runs. No `set -e` and no `exit`, so sourcing it can't end the caller's shell.

# Seconds slop asked to wait before the next ask (15 when it didn't say), at most 30.
slop_atf_retry_after() {
  python3 -c 'import json,sys
try:
    print(min(30, max(1, int(json.load(open(sys.argv[1])).get("retryAfterSeconds", 15)))))
except Exception:
    print(15)' "$1" 2>/dev/null || echo 15
}

slop_atf_specs() {
  local environment="${1:-${SLOP_ENVIRONMENT:-}}"
  local reports="${2:-reports/atf}"

  export SLOP_ATF_GREP="${SLOP_ATF_GREP-}"
  if [ -n "${SLOP_ATF_SPECS+x}" ]; then
    export SLOP_ATF_SPECS
    if [ -n "$SLOP_ATF_SPECS" ]; then
      echo "atf-specs: the spec list came with the build"
    else
      echo "atf-specs: the build's spec list is empty; running the default suite"
    fi
    return 0
  fi
  export SLOP_ATF_SPECS=""

  local sha="${SLOP_SHA:-${CODEBUILD_RESOLVED_SOURCE_VERSION:-}}"
  if ! printf '%s' "$sha" | grep -Eq '^[0-9a-fA-F]{7,40}$'; then
    sha=""
  fi
  local endpoint="${SLOP_ATF_ENDPOINT:-}"
  if [ -z "$endpoint" ] && [ -n "${SLOP_URL:-}" ] && [ -n "${SLOP_BOARD:-}" ]; then
    endpoint="${SLOP_URL%/}/integrations/boards/${SLOP_BOARD}/atf-specs"
  fi
  if [ -z "$endpoint" ] || [ -z "${SLOP_TOKEN:-}" ] || [ -z "$environment" ] || [ -z "$sha" ]; then
    echo "atf-specs: needs SLOP_URL, SLOP_BOARD, SLOP_TOKEN, an environment and the deployed commit (SLOP_SHA); running the default suite" >&2
    return 0
  fi
  command -v curl >/dev/null 2>&1 || { echo "atf-specs: curl isn't installed; running the default suite" >&2; return 0; }
  command -v python3 >/dev/null 2>&1 || { echo "atf-specs: python3 isn't installed; running the default suite" >&2; return 0; }

  local body answer code deadline wait_s poll
  body="$(mktemp 2>/dev/null)" || { echo "atf-specs: couldn't create a temporary file; running the default suite" >&2; return 0; }
  wait_s="${SLOP_ATF_WAIT:-120}"
  deadline=$(( $(date +%s) + wait_s ))
  while :; do
    code="$(curl -sS --max-time 20 -G -o "$body" -w '%{http_code}' \
      -H "Authorization: Bearer ${SLOP_TOKEN}" \
      --data-urlencode "environment=${environment}" --data-urlencode "sha=${sha}" \
      "$endpoint" 2>/dev/null)" || code="000"
    case "$code" in
      200) break ;;
      202)
        poll="${SLOP_ATF_POLL_SECONDS:-}"
        if [ -z "$poll" ]; then
          poll="$(slop_atf_retry_after "$body")"
        fi
        [ -n "$poll" ] || poll=15
        if [ "$(date +%s)" -ge "$deadline" ]; then
          echo "atf-specs: slop hadn't finished checking the deploy after ${wait_s}s; running the default suite" >&2
          rm -f "$body"
          return 0
        fi
        sleep "$poll"
        ;;
      409)
        echo "atf-specs: a newer deploy replaced $sha in $environment; running the default suite" >&2
        rm -f "$body"
        return 0
        ;;
      *)
        echo "atf-specs: slop answered ${code} (not 200); running the default suite" >&2
        rm -f "$body"
        return 0
        ;;
    esac
  done

  # python3 turns the answer into two lines: the specs (newline-joined, escaped as \n) and the grep.
  answer="$(python3 - "$body" <<'PY' 2>/dev/null
import json, sys
body = json.load(open(sys.argv[1]))
if body.get("status") != "ready":
    sys.exit(1)
specs = [s["spec"] for s in body.get("specs", []) if isinstance(s, dict) and isinstance(s.get("spec"), str) and "\n" not in s["spec"]]
greps = [g["grep"] for g in body.get("greps", []) if isinstance(g, dict) and isinstance(g.get("grep"), str)]
print("\x1f".join(specs))
print(greps[0] if len(greps) == 1 else "|".join("(?:%s)" % g for g in greps))
PY
)" || { echo "atf-specs: couldn't read slop's answer; running the default suite" >&2; rm -f "$body"; return 0; }

  mkdir -p "$reports" 2>/dev/null && cp "$body" "$reports/specs.json" 2>/dev/null
  rm -f "$body"
  local specs_line grep_line
  specs_line="$(printf '%s\n' "$answer" | sed -n '1p')"
  grep_line="$(printf '%s\n' "$answer" | sed -n '2p')"
  SLOP_ATF_SPECS="$(printf '%s' "$specs_line" | tr '\037' '\n')"
  SLOP_ATF_GREP="$grep_line"
  export SLOP_ATF_SPECS SLOP_ATF_GREP
  if [ -n "$SLOP_ATF_SPECS" ]; then
    echo "atf-specs: slop listed $(printf '%s\n' "$SLOP_ATF_SPECS" | grep -c .) spec(s) for $environment at $sha${SLOP_ATF_GREP:+ (grep $SLOP_ATF_GREP)}"
  else
    echo "atf-specs: no spec list for this deploy; running the default suite"
  fi
  return 0
}

slop_atf_specs "$@"
unset -f slop_atf_specs slop_atf_retry_after
