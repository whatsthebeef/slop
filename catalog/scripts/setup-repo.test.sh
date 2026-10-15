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
PY
echo ok
