#!/usr/bin/env bash
# Checks the ruleset JSON setup-repo.sh builds. Run: bash catalog/scripts/setup-repo.test.sh
set -euo pipefail
cd "$(dirname "$0")"
SETUP_REPO_SOURCE_ONLY=1 source ./setup-repo.sh
json=$(ruleset_json 4242 1 checks lint)
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
assert p["strict_required_status_checks_policy"] is False
assert [c["context"] for c in p["required_status_checks"]] == ["checks", "lint"]
q = rules["merge_queue"]["parameters"]
assert q["merge_method"] == "SQUASH" and q["grouping_strategy"] == "ALLGREEN"
assert q["max_entries_to_build"] == 5 and q["max_entries_to_merge"] == 5 and q["check_response_timeout_minutes"] == 30
PY

# Without the queue: no queue rule, up-to-date head required.
python3 - "$(ruleset_json 4242 0 checks)" <<'PY'
import json, sys
r = json.loads(sys.argv[1])
rules = {x["type"]: x for x in r["rules"]}
assert "merge_queue" not in rules
assert rules["required_status_checks"]["parameters"]["strict_required_status_checks_policy"] is True
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
check() { # <body file> <expect queue 1|0>
  python3 - "$1" "$2" <<'PY'
import json, sys
r = json.load(open(sys.argv[1])); queue = sys.argv[2] == "1"
rules = {x["type"]: x for x in r["rules"]}
assert [c["context"] for c in rules["required_status_checks"]["parameters"]["required_status_checks"]] == ["checks"]
assert {"actor_id": 4242, "actor_type": "Integration", "bypass_mode": "always"} in r["bypass_actors"]
assert {"actor_id": 5, "actor_type": "RepositoryRole", "bypass_mode": "always"} in r["bypass_actors"]
assert ("merge_queue" in rules) == queue
if queue:
    q = rules["merge_queue"]["parameters"]
    assert q["merge_method"] == "SQUASH" and q["grouping_strategy"] == "ALLGREEN"
    assert q["max_entries_to_build"] == 5 and q["max_entries_to_merge"] == 5 and q["check_response_timeout_minutes"] == 30
PY
}
run --protect
check "$tmp/post.json" 1
GH_STUB_EXISTING=77 run --protect
check "$tmp/put.json" 1
rm -f "$tmp/post.json"
run --protect --no-merge-queue
check "$tmp/post.json" 0
echo ok
