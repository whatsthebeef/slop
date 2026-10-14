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
#   specs        one row per spec file: passed, failed or skipped, with its test count. The file is the test
#                case's `file` attribute, else its `classname`, else its test suite's name (Playwright's JUnit
#                names the spec file). A file that is the tail of a planned spec path (SLOP_ATF_SPECS, set by
#                atf-specs.sh or a push start) is reported under the planned path, and a planned spec with no
#                test case is reported as `missing`. At most 1000 rows, failures first, under 200 KB.
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

detail = {"repo": os.environ["REPORT_REPO"], "passed": passed, "failed": failed, "skipped": skipped}
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
