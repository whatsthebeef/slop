#!/usr/bin/env bash
# .sstor/atf-specs.sh [environment] [report dir]: asks slop which acceptance test (ATF) specs to run for the deploy
# that was just made (a succeeded branch deploy of a glob), and exports the answer for .sstor/atf.sh. SOURCE it, so the exports reach the build's shell:
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
#   Identity (SLOP_ATF_AUTH=oidc|client|aws|token forces one; otherwise the first that applies, in this order). Register it on the board as an ATF
#   runner (README.md); a token is never printed:
#   SLOP_OIDC_TOKEN  a JWT from the CI system (GitHub Actions: github-actions-atf.yml), sent as the bearer
#   SLOP_CLIENT_ID, SLOP_CLIENT_SECRET, SLOP_TOKEN_URL   a client-credentials runner's client (shown once when an admin
#                    registers it): the script exchanges them for an access token (scope slop/atf.read-specs, or SLOP_ATF_SCOPE)
#                    with the secret in a mode-600 file, never on the command line. The secret and token are never printed.
#   AWS credentials  when SLOP_TOKEN is not set and the environment has AWS credentials: a JWT from AWS outbound identity
#                    federation (STS GetWebIdentityToken; audience SLOP_OIDC_AUDIENCE, else SLOP_URL). Needs the aws CLI
#                    with `sts get-web-identity-token`, or python3 with a boto3 that has it.
#   SLOP_TOKEN       the board's integration token (deprecated for ATF: slop answers with a Deprecation header)
#   SLOP_ENVIRONMENT, SLOP_SHA   the environment tested and the commit it runs (the first argument overrides the
#                  environment; the commit falls back to CODEBUILD_RESOLVED_SOURCE_VERSION when that is a SHA)
#   SLOP_ATF_ENDPOINT      the full URL to ask, instead of $SLOP_URL/integrations/boards/$SLOP_BOARD/atf-specs
#   SLOP_ATF_WAIT          seconds to wait for slop to see the branch deploy succeed (default 120)
#   SLOP_ATF_POLL_SECONDS  seconds between asks while it waits (default: what slop says, at most 30)
#
# When slop starts the build itself (a push-mode board) the list is already in SLOP_ATF_SPECS (even if empty), and
# this script asks for nothing. It never fails the pipeline: any problem is a warning, the list stays empty and
# the default suite runs. No `set -e` and no `exit`, so sourcing it can't end the caller's shell.

slop_atf_have_aws() {
  command -v aws >/dev/null 2>&1 || command -v python3 >/dev/null 2>&1 || return 1
  [ -n "${AWS_ACCESS_KEY_ID:-}${AWS_CONTAINER_CREDENTIALS_RELATIVE_URI:-}${AWS_CONTAINER_CREDENTIALS_FULL_URI:-}${AWS_WEB_IDENTITY_TOKEN_FILE:-}${AWS_PROFILE:-}" ]
}

# A JWT from AWS outbound identity federation for slop's audience, on stdout; fails quietly when AWS can't issue one.
slop_atf_aws_token() {
  local audience="${SLOP_OIDC_AUDIENCE:-${SLOP_URL:-}}" token=""
  audience="${audience%/}"
  [ -n "$audience" ] || return 1
  if command -v aws >/dev/null 2>&1; then
    token="$(aws sts get-web-identity-token --audience "$audience" --signing-algorithm RS256 --duration-seconds 300 \
      --query WebIdentityToken --output text 2>/dev/null)" || token=""
  fi
  if { [ -z "$token" ] || [ "$token" = "None" ]; } && command -v python3 >/dev/null 2>&1; then
    token="$(SLOP_AUD="$audience" python3 -c 'import os, boto3
print(boto3.client("sts").get_web_identity_token(Audience=[os.environ["SLOP_AUD"]], SigningAlgorithm="RS256", DurationSeconds=300)["WebIdentityToken"])' 2>/dev/null)" || token=""
  fi
  [ -n "$token" ] && [ "$token" != "None" ] || return 1
  printf '%s' "$token"
}

# An access token for a client-credentials runner on stdout (SLOP_CLIENT_ID, SLOP_CLIENT_SECRET and SLOP_TOKEN_URL, asking
# for scope $1, or SLOP_ATF_SCOPE when set); fails quietly. The secret reaches curl through a mode-600 config file, never the
# command line, and is never printed. The token is requested once per script run (the credential is chosen once).
slop_atf_client_token() {
  local scope="${SLOP_ATF_SCOPE:-$1}" cfg="" out="" code="" token=""
  [ -n "${SLOP_CLIENT_ID:-}" ] && [ -n "${SLOP_CLIENT_SECRET:-}" ] && [ -n "${SLOP_TOKEN_URL:-}" ] || return 1
  command -v curl >/dev/null 2>&1 && command -v python3 >/dev/null 2>&1 || return 1
  # Characters that would break out of a curl config string are not in any client id, secret or scope.
  case "${SLOP_CLIENT_ID}${SLOP_CLIENT_SECRET}${scope}" in
    *'"'* | *\\* | *$'\n'* | *$'\r'*) return 1 ;;
  esac
  cfg="$(mktemp 2>/dev/null)" || return 1
  out="$(mktemp 2>/dev/null)" || { rm -f "$cfg"; return 1; }
  chmod 600 "$cfg" "$out" 2>/dev/null
  printf 'user = "%s:%s"\ndata-urlencode = "grant_type=client_credentials"\ndata-urlencode = "scope=%s"\n' \
    "$SLOP_CLIENT_ID" "$SLOP_CLIENT_SECRET" "$scope" >"$cfg"
  code="$(curl -sS --max-time 20 -K "$cfg" -o "$out" -w '%{http_code}' "$SLOP_TOKEN_URL" 2>/dev/null)" || code="000"
  if [ "$code" = "200" ]; then
    token="$(python3 -c 'import json,sys
try:
    print(json.load(open(sys.argv[1])).get("access_token", ""))
except Exception:
    pass' "$out" 2>/dev/null)" || token=""
  fi
  rm -f "$cfg" "$out"
  [ -n "$token" ] || return 1
  printf '%s' "$token"
}

# Prints the method on the first line and the bearer on the second, or fails when no identity is available.
slop_atf_credential() {
  local want="${SLOP_ATF_AUTH:-}" token=""
  if [ -z "$want" ]; then
    if [ -n "${SLOP_OIDC_TOKEN:-}" ]; then want=oidc
    elif [ -n "${SLOP_CLIENT_ID:-}" ] && [ -n "${SLOP_CLIENT_SECRET:-}" ]; then want=client
    elif [ -z "${SLOP_TOKEN:-}" ] && slop_atf_have_aws; then want=aws
    elif [ -n "${SLOP_TOKEN:-}" ]; then want=token
    fi
  fi
  case "$want" in
    oidc) token="${SLOP_OIDC_TOKEN:-}" ;;
    client) token="$(slop_atf_client_token slop/atf.read-specs)" || token="" ;;
    aws) token="$(slop_atf_aws_token)" || token="" ;;
    token) token="${SLOP_TOKEN:-}" ;;
  esac
  [ -n "$token" ] || return 1
  printf '%s\n%s\n' "$want" "$token"
}

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
  if [ -z "$endpoint" ] || [ -z "$environment" ] || [ -z "$sha" ]; then
    echo "atf-specs: needs SLOP_URL, SLOP_BOARD, an environment and the deployed commit (SLOP_SHA); running the default suite" >&2
    return 0
  fi
  local cred method bearer
  cred="$(slop_atf_credential)" || {
    echo "atf-specs: no identity (set SLOP_OIDC_TOKEN, SLOP_CLIENT_ID with SLOP_CLIENT_SECRET and SLOP_TOKEN_URL, or SLOP_TOKEN, or run with AWS credentials); running the default suite" >&2
    return 0
  }
  method="$(printf '%s\n' "$cred" | sed -n '1p')"
  bearer="$(printf '%s\n' "$cred" | sed -n '2p')"
  command -v curl >/dev/null 2>&1 || { echo "atf-specs: curl isn't installed; running the default suite" >&2; return 0; }
  command -v python3 >/dev/null 2>&1 || { echo "atf-specs: python3 isn't installed; running the default suite" >&2; return 0; }

  local body answer code deadline wait_s poll headers
  body="$(mktemp 2>/dev/null)" || { echo "atf-specs: couldn't create a temporary file; running the default suite" >&2; return 0; }
  headers="$(mktemp 2>/dev/null)" || { rm -f "$body" "$headers"; echo "atf-specs: couldn't create a temporary file; running the default suite" >&2; return 0; }
  chmod 600 "$headers" 2>/dev/null
  # The bearer goes through a header file, not the command line, so it isn't visible in the process list.
  printf 'Authorization: Bearer %s\n' "$bearer" >"$headers"
  wait_s="${SLOP_ATF_WAIT:-120}"
  deadline=$(( $(date +%s) + wait_s ))
  while :; do
    code="$(curl -sS --max-time 20 -G -o "$body" -w '%{http_code}' \
      -H "@$headers" \
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
          echo "atf-specs: slop hadn't seen the deploy succeed after ${wait_s}s; running the default suite" >&2
          rm -f "$body" "$headers"
          return 0
        fi
        sleep "$poll"
        ;;
      409)
        echo "atf-specs: a newer deploy replaced $sha in $environment; running the default suite" >&2
        rm -f "$body" "$headers"
        return 0
        ;;
      401)
        echo "atf-specs: slop didn't accept the ${method} identity (is the runner registered, enabled and serving $environment?); running the default suite" >&2
        rm -f "$body" "$headers"
        return 0
        ;;
      *)
        echo "atf-specs: slop answered ${code} (not 200); running the default suite" >&2
        rm -f "$body" "$headers"
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
)" || { echo "atf-specs: couldn't read slop's answer; running the default suite" >&2; rm -f "$body" "$headers"; return 0; }

  mkdir -p "$reports" 2>/dev/null && cp "$body" "$reports/specs.json" 2>/dev/null
  rm -f "$body" "$headers"
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
unset -f slop_atf_specs slop_atf_retry_after slop_atf_have_aws slop_atf_aws_token slop_atf_client_token slop_atf_credential
