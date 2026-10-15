#!/usr/bin/env bash
# .sstor/atf-report.sh [environment] [report dir]: tells slop how an acceptance test (ATF) run went, from
# its JUnit XML reports. slop only observes ATF: the board's pipeline runs it (buildspec-atf.yml), and this
# script reports the counts afterwards, whatever the result.
#
# A run on a glob's branch (SLOP_GLOB set, e.g. by a branch deploy's pipeline) shows on that glob. A run
# against a release or integration environment (one with a role in the board's settings) shows on every
# glob that environment's deployed commit contains. Send the commit the environment ran when the tests
# started (SLOP_SHA); without one, slop takes the environment's latest deploy when the event arrives.
#
# How it reaches slop (SLOP_ATF_TRANSPORT, or by what is set):
#   http         POST to $SLOP_URL/integrations/boards/$SLOP_BOARD/atf-results with the runner's own identity (the default
#                whenever SLOP_URL, SLOP_BOARD and an identity are set). Any CI can use it. slop records the run against
#                the runner and only for the board and environments that runner serves, so no repo is needed.
#   eventbridge  a `slop.ci` "Slop ATF Completed" event on the account's default EventBridge bus; the board's
#                deploy-target stack forwards those to slop. AWS only; the project's role needs events:PutEvents there.
#                Used when selected, and when there is no URL, board or identity for http.
#
# Which identity http uses (SLOP_ATF_AUTH=oidc|client|aws|token forces one; otherwise the first that applies):
#   1. SLOP_OIDC_TOKEN   a JWT from the CI system (GitHub Actions: see github-actions-atf.yml), sent as the bearer.
#   2. SLOP_CLIENT_ID, SLOP_CLIENT_SECRET, SLOP_TOKEN_URL   a client-credentials runner's client (shown once when an admin
#                        registers it), exchanged for an access token (scope slop/atf.write-results, or SLOP_ATF_SCOPE) with the
#                        secret in a mode-600 file, never on the command line. The secret and token are never printed.
#   3. AWS credentials   when there is no SLOP_TOKEN and the environment has AWS credentials: a JWT from AWS outbound identity
#                        federation (STS GetWebIdentityToken, audience SLOP_OIDC_AUDIENCE, else SLOP_URL). Needs the aws CLI
#                        with `sts get-web-identity-token`, or python3 with a boto3 that has it.
#   4. SLOP_TOKEN        the board's integration token (deprecated for ATF: slop answers with a Deprecation header).
# The identity must be registered on the board as an ATF runner (see README.md). A token is never printed.
#
# Each report carries an Idempotency-Key naming this pipeline run (SLOP_ATF_IDEMPOTENCY_KEY, else the CodeBuild build id or
# the GitHub run id and attempt): slop records a redelivery of the same key once, and a re-run of the same commit with
# identical counts under a new key as a new run.
#
# What it sends, and where it comes from (set the SLOP_* variables to override):
#   environment  the first argument, else SLOP_ENVIRONMENT (optional for a branch run)
#   branch       SLOP_GLOB (optional: the glob whose branch was tested)
#   repo         SLOP_REPO, else the source repository URL (owner/name)
#   sha          SLOP_SHA, else CODEBUILD_RESOLVED_SOURCE_VERSION (optional for an environment run)
#   counts       <testcase>, <failure>/<error> and <skipped> across the report dir's *.xml (default reports/atf)
#   specs        one row per spec file: passed, failed or skipped, with its test count. The file is the test
#                case's `file` attribute, else its `classname`, else its test suite's name (Playwright's JUnit
#                names the spec file). A file that is the tail of a planned spec path (SLOP_ATF_SPECS, set by
#                atf-specs.sh or a push start) is reported under the planned path, and a planned spec with no
#                test case is reported as `missing`. At most 1000 rows, failures first, under 200 KB.
#   url          SLOP_ATF_URL, else CODEBUILD_BUILD_URL (optional: a link to the report or run)
#
# A failed report never fails the pipeline: every problem is a warning and the script exits 0.
set -euo pipefail

# --- identity (the same choice atf-specs.sh makes) ----------------------------------------------------------------

slop_atf_have_aws() {
  command -v aws >/dev/null 2>&1 || command -v python3 >/dev/null 2>&1 || return 1
  [[ -n "${AWS_ACCESS_KEY_ID:-}${AWS_CONTAINER_CREDENTIALS_RELATIVE_URI:-}${AWS_CONTAINER_CREDENTIALS_FULL_URI:-}${AWS_WEB_IDENTITY_TOKEN_FILE:-}${AWS_PROFILE:-}" ]]
}

# A JWT from AWS outbound identity federation for slop's audience, on stdout; fails quietly when AWS can't issue one.
slop_atf_aws_token() {
  local audience="${SLOP_OIDC_AUDIENCE:-${SLOP_URL:-}}" token=""
  audience="${audience%/}"
  [[ -n "$audience" ]] || return 1
  if command -v aws >/dev/null 2>&1; then
    token="$(aws sts get-web-identity-token --audience "$audience" --signing-algorithm RS256 --duration-seconds 300 \
      --query WebIdentityToken --output text 2>/dev/null)" || token=""
  fi
  if [[ -z "$token" || "$token" == "None" ]] && command -v python3 >/dev/null 2>&1; then
    token="$(SLOP_AUD="$audience" python3 -c 'import os, boto3
print(boto3.client("sts").get_web_identity_token(Audience=[os.environ["SLOP_AUD"]], SigningAlgorithm="RS256", DurationSeconds=300)["WebIdentityToken"])' 2>/dev/null)" || token=""
  fi
  [[ -n "$token" && "$token" != "None" ]] || return 1
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
  if [[ -z "$want" ]]; then
    if [[ -n "${SLOP_OIDC_TOKEN:-}" ]]; then want=oidc
    elif [[ -n "${SLOP_CLIENT_ID:-}" && -n "${SLOP_CLIENT_SECRET:-}" ]]; then want=client
    elif [[ -z "${SLOP_TOKEN:-}" ]] && slop_atf_have_aws; then want=aws
    elif [[ -n "${SLOP_TOKEN:-}" ]]; then want=token
    fi
  fi
  case "$want" in
    oidc) token="${SLOP_OIDC_TOKEN:-}" ;;
    client) token="$(slop_atf_client_token slop/atf.write-results)" || token="" ;;
    aws) token="$(slop_atf_aws_token)" || token="" ;;
    token) token="${SLOP_TOKEN:-}" ;;
  esac
  [[ -n "$token" ]] || return 1
  printf '%s\n%s\n' "$want" "$token"
}

env="${1:-${SLOP_ENVIRONMENT:-}}"
reports="${2:-reports/atf}"
branch="${SLOP_GLOB:-}"
if [[ -z "$env" && -z "$branch" ]]; then
  echo "atf-report: usage: .sstor/atf-report.sh <environment> [report dir] (or set SLOP_GLOB for a branch run). Not reported." >&2
  exit 0
fi

repo_of() {
  # https://github.com/owner/name(.git) or git@github.com:owner/name(.git) -> owner/name
  printf '%s' "$1" | sed -E 's#^(https://[^/]+/|git@[^:]+:)##; s#\.git$##'
}
repo="${SLOP_REPO:-}"
[[ -n "$repo" ]] || repo="$(repo_of "${CODEBUILD_SOURCE_REPO_URL:-$(git remote get-url origin 2>/dev/null || true)}")"
sha="${SLOP_SHA:-${CODEBUILD_RESOLVED_SOURCE_VERSION:-}}"
# Only a commit SHA identifies what was tested; anything else (e.g. a pipeline's artifact ARN) is left out.
if [[ -n "$sha" && ! "$sha" =~ ^[0-9a-fA-F]{7,40}$ ]]; then
  echo "atf-report: '$sha' isn't a commit SHA (e.g. a CodePipeline artifact); sending no commit" >&2
  sha=""
fi

# http needs a URL, a board and an identity; without them (or when asked) the report goes over EventBridge.
transport="${SLOP_ATF_TRANSPORT:-}"
results_endpoint="${SLOP_ATF_RESULTS_ENDPOINT:-}"
if [[ -z "$results_endpoint" && -n "${SLOP_URL:-}" && -n "${SLOP_BOARD:-}" ]]; then
  results_endpoint="${SLOP_URL%/}/integrations/boards/${SLOP_BOARD}/atf-results"
fi
auth_method=""
bearer=""
if [[ "$transport" != "eventbridge" && -n "$results_endpoint" ]]; then
  if cred="$(slop_atf_credential)"; then
    auth_method="$(printf '%s\n' "$cred" | sed -n '1p')"
    bearer="$(printf '%s\n' "$cred" | sed -n '2p')"
    transport="http"
  elif [[ "$transport" == "http" ]]; then
    echo "atf-report: no identity for http (set SLOP_OIDC_TOKEN, SLOP_CLIENT_ID with SLOP_CLIENT_SECRET and SLOP_TOKEN_URL, SLOP_TOKEN, or run with AWS credentials). Not reported." >&2
    exit 0
  fi
fi
[[ "$transport" == "http" ]] || transport="eventbridge"

if [[ "$transport" == "eventbridge" && -z "$repo" ]]; then
  echo "atf-report: couldn't tell the repo; set SLOP_REPO. Not reported." >&2
  exit 0
fi
if [[ -n "$branch" && -z "$sha" ]]; then
  echo "atf-report: a branch run needs the commit it tested; set SLOP_SHA. Not reported." >&2
  exit 0
fi

command -v python3 >/dev/null 2>&1 || { echo "atf-report: python3 isn't installed. Not reported." >&2; exit 0; }
if [[ "$transport" == "eventbridge" ]]; then
  command -v aws >/dev/null 2>&1 || { echo "atf-report: the AWS CLI isn't installed. Not reported." >&2; exit 0; }
else
  command -v curl >/dev/null 2>&1 || { echo "atf-report: curl isn't installed. Not reported." >&2; exit 0; }
fi

entries="$(mktemp 2>/dev/null)" || { echo "atf-report: couldn't create a temporary file. Not reported." >&2; exit 0; }
headers=""
trap 'rm -f "$entries" "$headers"' EXIT
# python3 counts the JUnit results and builds the JSON, so no value needs shell quoting.
if ! REPORT_DIR="$reports" REPORT_ENV="$env" REPORT_BRANCH="$branch" REPORT_REPO="$repo" REPORT_SHA="$sha" REPORT_TRANSPORT="$transport" \
  python3 - >"$entries" <<'PY'
import glob, json, os, re, sys
import xml.etree.ElementTree as ET

MAX_SPECS = 1000
MAX_DETAIL_BYTES = 200_000
MAX_PATH = 300
PATHLIKE = re.compile(r"(/|\.[A-Za-z0-9]{1,6}$)")
PROJECT_PREFIX = re.compile(r"^\[[^\]]*\]\s*[›>]\s*")


def normalise(value):
    """A spec path as slop compares it: no project prefix, forward slashes, no leading ./ or /."""
    value = PROJECT_PREFIX.sub("", (value or "").strip()).replace("\\", "/")
    while value.startswith("./"):
        value = value[2:]
    return value.lstrip("/")


def file_of(case, suite_name):
    """The spec file of a test case: its `file`, else its classname, else its suite (the first path-like wins)."""
    candidates = [normalise(case.get("file")), normalise(case.get("classname")), normalise(suite_name)]
    candidates = [c for c in candidates if c]
    for c in candidates:
        if PATHLIKE.search(c):
            return c
    return candidates[0] if candidates else ""


def planned_specs(report_dir):
    """The specs the deploy's batch asked for: SLOP_ATF_SPECS, else what atf-specs.sh stored beside the reports."""
    raw = os.environ.get("SLOP_ATF_SPECS")
    if raw is not None:
        return [normalise(line) for line in raw.splitlines() if normalise(line)]
    try:
        with open(os.path.join(report_dir, "specs.json"), encoding="utf-8") as handle:
            body = json.load(handle)
        return [normalise(s.get("spec")) for s in body.get("specs", []) if isinstance(s, dict) and normalise(s.get("spec"))]
    except (OSError, ValueError, AttributeError):
        return []


def planned_for(file, planned):
    """The planned path this file is, or the tail of (a testDir-relative report), when exactly one matches."""
    if file in planned:
        return file
    matches = [p for p in planned if p.endswith("/" + file) or file.endswith("/" + p)]
    return matches[0] if len(matches) == 1 else file


passed = failed = skipped = 0
report_dir = os.environ["REPORT_DIR"]
files = sorted(glob.glob(os.path.join(report_dir, "**", "*.xml"), recursive=True))
planned = planned_specs(report_dir)
rows = {}
for path in files:
    try:
        root = ET.parse(path).getroot()
    except ET.ParseError as error:
        print(f"atf-report: skipping {path}: {error}", file=sys.stderr)
        continue

    def walk(node, suite_name):
        global passed, failed, skipped
        for child in node:
            if child.tag == "testsuite":
                walk(child, child.get("name") or suite_name)
            elif child.tag == "testcase":
                bad = child.find("failure") is not None or child.find("error") is not None
                skip = child.find("skipped") is not None
                if bad:
                    failed += 1
                elif skip:
                    skipped += 1
                else:
                    passed += 1
                name = planned_for(file_of(child, suite_name), planned)
                if not name or len(name) > MAX_PATH:
                    continue
                row = rows.setdefault(name, {"file": name, "tests": 0, "failed": 0, "skipped": 0, "ms": 0.0})
                row["tests"] += 1
                row["failed"] += 1 if bad else 0
                row["skipped"] += 1 if (skip and not bad) else 0
                try:
                    row["ms"] += float(child.get("time") or 0) * 1000
                except ValueError:
                    pass
            else:
                walk(child, suite_name)

    walk(root, root.get("name") if root.tag == "testsuite" else "")
if not files:
    print(f"atf-report: no JUnit reports under {report_dir}", file=sys.stderr)
    sys.exit(1)

specs = []
for row in rows.values():
    if row["failed"] > 0:
        status = "failed"
    elif row["skipped"] == row["tests"]:
        status = "skipped"
    else:
        status = "passed"
    specs.append({"file": row["file"], "status": status, "tests": row["tests"], "failed": row["failed"], "durationMs": int(round(row["ms"]))})
for spec in planned:
    if spec not in rows and len(spec) <= MAX_PATH:
        specs.append({"file": spec, "status": "missing", "tests": 0, "failed": 0})
severity = {"failed": 0, "missing": 1, "skipped": 2, "passed": 3}
specs.sort(key=lambda s: (severity[s["status"]], s["file"]))

detail = {"passed": passed, "failed": failed, "skipped": skipped}
if os.environ.get("REPORT_REPO"):
    detail["repo"] = os.environ["REPORT_REPO"]
for key, var in (("environment", "REPORT_ENV"), ("branch", "REPORT_BRANCH"), ("sha", "REPORT_SHA")):
    if os.environ.get(var):
        detail[key] = os.environ[var]
url = os.environ.get("SLOP_ATF_URL") or os.environ.get("CODEBUILD_BUILD_URL", "")
if url.startswith("https://"):
    detail["url"] = url
if len(specs) > MAX_SPECS:
    specs = specs[:MAX_SPECS]
    print(f"atf-report: reporting the first {MAX_SPECS} specs only", file=sys.stderr)
detail["specs"] = specs
while specs and len(json.dumps(detail)) > MAX_DETAIL_BYTES:
    specs.pop()
    print("atf-report: report too large; dropping the least important spec rows", file=sys.stderr)
if not specs:
    del detail["specs"]
print(f"ATF: {passed} passed, {failed} failed, {skipped} skipped across {len(rows)} spec files", file=sys.stderr)
if os.environ.get("REPORT_TRANSPORT") == "http":
    print(json.dumps(detail))
else:
    print(json.dumps([{"Source": "slop.ci", "DetailType": "Slop ATF Completed", "Detail": json.dumps(detail)}]))
PY
then
  echo "atf-report: nothing to report; slop won't show this run" >&2
  exit 0
fi

if [[ "$transport" == "http" ]]; then
  key="${SLOP_ATF_IDEMPOTENCY_KEY:-${CODEBUILD_BUILD_ID:-}}"
  [[ -n "$key" || -z "${GITHUB_RUN_ID:-}" ]] || key="gha-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT:-1}"
  # No pipeline run id: a key unique to this call, so a re-run is never taken for a redelivery.
  [[ -n "$key" ]] || key="${env:-$branch}-${sha:-nosha}-$(date -u +%s)-$$"
  key="$(printf '%s' "$key" | tr -c 'A-Za-z0-9._:@/-' '_' | cut -c1-200)"
  headers="$(mktemp 2>/dev/null)" || { echo "atf-report: couldn't create a temporary file. Not reported." >&2; exit 0; }
  chmod 600 "$headers" 2>/dev/null || true
  # The bearer goes through a header file, not the command line, so it isn't visible in the process list.
  printf 'Authorization: Bearer %s\nContent-Type: application/json\nIdempotency-Key: %s\n' "$bearer" "$key" >"$headers"
  code="$(curl -sS --max-time 30 -o /dev/null -w '%{http_code}' -X POST -H "@$headers" --data-binary "@$entries" "$results_endpoint" 2>/dev/null)" || code="000"
  case "$code" in
    200|201) echo "Reported to slop over HTTP (${auth_method}): ATF${env:+ in $env}${branch:+ on $branch}${sha:+ at $sha}" ;;
    401) echo "atf-report: slop didn't accept the ${auth_method} identity (is the runner registered, enabled and serving $env?); slop won't show this run" >&2 ;;
    *) echo "atf-report: slop answered ${code}; slop won't show this run" >&2 ;;
  esac
elif aws events put-events --entries "file://$entries" --query 'FailedEntryCount' --output text | grep -qx 0; then
  echo "Reported to slop: ATF for $repo${env:+ in $env}${branch:+ on $branch}${sha:+ at $sha}"
else
  echo "atf-report: EventBridge didn't take the event; slop won't show this run" >&2
fi
