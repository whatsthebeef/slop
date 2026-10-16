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

# Changed tests: vitest runs once per package and a failure blocks the push (no .sstor/checks.sh in this repo).
tmp2=$(mktemp -d); trap 'rm -rf "$tmp" "$tmp2"' EXIT
mkdir "$tmp2/bin" && cat > "$tmp2/bin/npx" <<'NPX'
#!/usr/bin/env bash
[[ "$1" == vitest ]] || exit 0
echo "vitest $PWD $*" >> "$VLOG"
shift 2
! grep -l VITEST_FAIL "$@" 2>/dev/null
NPX
chmod +x "$tmp2/bin/npx"
cd "$tmp2" && git init -q . && git config user.email t@t && git config user.name t
mkdir -p pkg/src && echo '{}' > pkg/package.json && echo ok > pkg/src/a.test.ts && echo ok > pkg/src/b.test.ts
git add -A && git commit -qm base
export VLOG="$tmp2/vitest.log"
tpush() { : > "$VLOG"; printf '{"tool_input":{"command":"git push origin s1"}}' | PATH="$tmp2/bin:$PATH" "$hook" 2>"$tmp2/err"; echo $?; }

echo VITEST_FAIL > pkg/src/a.test.ts && git commit -qam red
check "failing changed test blocks the push" 2 "$(tpush)"
check "failing test is reported on stderr" 1 "$(grep -c 'FAILED: npx vitest' "$tmp2/err")"
echo VITEST_FAIL > pkg/src/b.test.ts && git commit -qam red2
check "two failing tests in one package block" 2 "$(tpush)"
tpush >/dev/null
check "one vitest run per package" 1 "$(wc -l < "$VLOG" | tr -d ' ')"
echo ok > pkg/src/a.test.ts && echo ok > pkg/src/b.test.ts && git commit -qam green
check "passing changed tests go through" 0 "$(tpush)"

echo "pre-push-checks: $pass passed, $failed failed"
[[ $failed -eq 0 ]]
