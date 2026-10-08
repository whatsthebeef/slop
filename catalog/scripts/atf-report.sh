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
# It puts a `slop.ci` "Slop ATF Completed" event on the account's default EventBridge bus; the board's
# deploy-target stack forwards those to slop. The project's role needs events:PutEvents on the default bus.
#
# What it sends, and where it comes from (set the SLOP_* variables to override):
#   environment  the first argument, else SLOP_ENVIRONMENT (optional for a branch run)
#   branch       SLOP_GLOB (optional: the glob whose branch was tested)
#   repo         SLOP_REPO, else the source repository URL (owner/name)
#   sha          SLOP_SHA, else CODEBUILD_RESOLVED_SOURCE_VERSION (optional for an environment run)
#   counts       <testcase>, <failure>/<error> and <skipped> across the report dir's *.xml (default reports/atf)
#   url          SLOP_ATF_URL, else CODEBUILD_BUILD_URL (optional: a link to the report or run)
#
# A failed report never fails the pipeline: every problem is a warning and the script exits 0.
set -euo pipefail

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

if [[ -z "$repo" ]]; then
  echo "atf-report: couldn't tell the repo; set SLOP_REPO. Not reported." >&2
  exit 0
fi
if [[ -n "$branch" && -z "$sha" ]]; then
  echo "atf-report: a branch run needs the commit it tested; set SLOP_SHA. Not reported." >&2
  exit 0
fi

command -v python3 >/dev/null 2>&1 || { echo "atf-report: python3 isn't installed. Not reported." >&2; exit 0; }
command -v aws >/dev/null 2>&1 || { echo "atf-report: the AWS CLI isn't installed. Not reported." >&2; exit 0; }

entries="$(mktemp 2>/dev/null)" || { echo "atf-report: couldn't create a temporary file. Not reported." >&2; exit 0; }
trap 'rm -f "$entries"' EXIT
# python3 counts the JUnit results and builds the JSON, so no value needs shell quoting.
if ! REPORT_DIR="$reports" REPORT_ENV="$env" REPORT_BRANCH="$branch" REPORT_REPO="$repo" REPORT_SHA="$sha" \
  python3 - >"$entries" <<'PY'
import glob, json, os, sys
import xml.etree.ElementTree as ET

passed = failed = skipped = 0
files = sorted(glob.glob(os.path.join(os.environ["REPORT_DIR"], "**", "*.xml"), recursive=True))
for path in files:
    try:
        root = ET.parse(path).getroot()
    except ET.ParseError as error:
        print(f"atf-report: skipping {path}: {error}", file=sys.stderr)
        continue
    for case in root.iter("testcase"):
        if case.find("failure") is not None or case.find("error") is not None:
            failed += 1
        elif case.find("skipped") is not None:
            skipped += 1
        else:
            passed += 1
if not files:
    print(f"atf-report: no JUnit reports under {os.environ['REPORT_DIR']}", file=sys.stderr)
    sys.exit(1)

detail = {"repo": os.environ["REPORT_REPO"], "passed": passed, "failed": failed, "skipped": skipped}
for key, var in (("environment", "REPORT_ENV"), ("branch", "REPORT_BRANCH"), ("sha", "REPORT_SHA")):
    if os.environ.get(var):
        detail[key] = os.environ[var]
url = os.environ.get("SLOP_ATF_URL") or os.environ.get("CODEBUILD_BUILD_URL", "")
if url.startswith("https://"):
    detail["url"] = url
print(f"ATF: {passed} passed, {failed} failed, {skipped} skipped", file=sys.stderr)
print(json.dumps([{"Source": "slop.ci", "DetailType": "Slop ATF Completed", "Detail": json.dumps(detail)}]))
PY
then
  echo "atf-report: nothing to report; slop won't show this run" >&2
  exit 0
fi

if aws events put-events --entries "file://$entries" --query 'FailedEntryCount' --output text | grep -qx 0; then
  echo "Reported to slop: ATF for $repo${env:+ in $env}${branch:+ on $branch}${sha:+ at $sha}"
else
  echo "atf-report: EventBridge didn't take the event; slop won't show this run" >&2
fi
