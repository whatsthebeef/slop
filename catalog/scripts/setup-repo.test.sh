#!/usr/bin/env bash
# Checks the ruleset JSON setup-repo.sh builds. Run: bash catalog/scripts/setup-repo.test.sh
set -euo pipefail
cd "$(dirname "$0")"
SETUP_REPO_SOURCE_ONLY=1 source ./setup-repo.sh
json=$(ruleset_json 4242 checks lint)
python3 - "$json" <<'PY'
import json, sys
r = json.loads(sys.argv[1])
assert r["name"] == "slop" and r["enforcement"] == "active"
assert r["conditions"]["ref_name"]["include"] == ["~DEFAULT_BRANCH"]
assert {"actor_id": 4242, "actor_type": "Integration", "bypass_mode": "always"} in r["bypass_actors"]
assert {"actor_id": 5, "actor_type": "RepositoryRole", "bypass_mode": "always"} in r["bypass_actors"]
rules = {x["type"]: x for x in r["rules"]}
assert "deletion" in rules and "non_fast_forward" in rules
p = rules["required_status_checks"]["parameters"]
assert p["strict_required_status_checks_policy"] is True
assert [c["context"] for c in p["required_status_checks"]] == ["checks", "lint"]
assert "merge_queue" not in rules
PY

# The script end to end against a stubbed gh that records the ruleset bodies it is sent.
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
mkdir "$tmp/bin"
cat >"$tmp/bin/gh" <<'STUB'
#!/usr/bin/env bash
# Records POST and PUT bodies; answers the reads the script makes.
args="$*"
case "$args" in
  *"-X POST"*rulesets*) cat >"$GH_STUB_DIR/post.json" ;;
  *"-X PUT"*rulesets/*) cat >"$GH_STUB_DIR/put.json" ;;
  *"-X PATCH"*) ;;
  *"apps/slop-test --jq .id"*) echo 4242 ;;
  *"apps/slop-test"*) echo '{"events":[]}' ;;
  *"repos/o/r/rulesets --jq"*) printf '%s' "${GH_STUB_EXISTING:-}" ;;
  *"branches/main/protection"*) exit 1 ;;
esac
exit 0
STUB
chmod +x "$tmp/bin/gh"
export GH_STUB_DIR="$tmp"
run() { PATH="$tmp/bin:$PATH" bash ./setup-repo.sh o/r --app slop-test --base main "$@" >/dev/null; }
check() { # <body file>
  python3 - "$1" <<'PY'
import json, sys
r = json.load(open(sys.argv[1]))
rules = {x["type"]: x for x in r["rules"]}
assert [c["context"] for c in rules["required_status_checks"]["parameters"]["required_status_checks"]] == ["checks"]
assert {"actor_id": 4242, "actor_type": "Integration", "bypass_mode": "always"} in r["bypass_actors"]
assert {"actor_id": 5, "actor_type": "RepositoryRole", "bypass_mode": "always"} in r["bypass_actors"]
assert "merge_queue" not in rules
assert rules["required_status_checks"]["parameters"]["strict_required_status_checks_policy"] is True
assert "deletion" in rules and "non_fast_forward" in rules
PY
}
run --protect
check "$tmp/post.json"
GH_STUB_EXISTING=77 run --protect
check "$tmp/put.json"
# The removed merge queue flag is rejected as an unknown option.
if PATH="$tmp/bin:$PATH" bash ./setup-repo.sh o/r --app slop-test --base main --protect --no-merge-queue >/dev/null 2>"$tmp/err"; then
  echo "--no-merge-queue was accepted" >&2; exit 1
fi
grep -q "Unknown option: --no-merge-queue" "$tmp/err"
# merge_group is no longer a required App event.
if grep -q merge_group ./setup-repo.sh; then echo "merge_group still in setup-repo.sh" >&2; exit 1; fi
echo ok
