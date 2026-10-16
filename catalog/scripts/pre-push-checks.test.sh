#!/usr/bin/env bash
# Tests catalog/agents/hooks/pre_push_checks.sh: a push with a failing check is blocked, a clean one goes through.
set -u
here=$(cd "$(dirname "$0")" && pwd)
hook="$here/../agents/hooks/pre_push_checks.sh"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
pass=0; failed=0
check() { if [[ "$2" == "$3" ]]; then pass=$((pass + 1)); else failed=$((failed + 1)); echo "FAIL: $1 (expected $2, got $3)"; fi; }

cd "$tmp" && git init -q . && git config user.email t@t && git config user.name t
mkdir .sstor
cat > .sstor/checks.sh <<'CHK'
#!/usr/bin/env bash
! grep -l LINT_ERROR "$@" 2>/dev/null
CHK
chmod +x .sstor/checks.sh
echo ok > a.ts && git add -A && git commit -qm base

push() { printf '{"tool_input":{"command":"%s"}}' "$1" | "$hook" 2>/dev/null; echo $?; }

echo 'LINT_ERROR' > a.ts && git commit -qam bad
check "lint error blocks the push" 2 "$(push 'git push origin s1')"
check "--no-verify is refused" 2 "$(push 'git push --no-verify origin s1')"
check "other commands pass" 0 "$(push 'git status')"
echo clean > a.ts && git commit -qam good
check "clean change goes through" 0 "$(push 'git push origin s1')"

echo "pre-push-checks: $pass passed, $failed failed"
[[ $failed -eq 0 ]]
