#!/usr/bin/env bash
# Checks claude-aws-session's installer, hook and helper in a fake HOME with a stub aws. Changes nothing outside a temp dir.
# Run: bash catalog/scripts/claude-aws-session/install.test.sh
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
installer="$here/install.sh"

# The tests may run inside a Claude session: the installer refuses that, so every run below starts without the ID.
unset CLAUDE_CODE_SESSION_ID CLAUDE_ENV_FILE AWS_PROFILE

work="$(mktemp -d)"
trap 'rm -rf "${work:?}"' EXIT
export HOME="$work/home"
mkdir -p "$HOME/.claude" "$HOME/dev/app/.claude" "$HOME/dev/app/wt/.claude" "$work/bin"
export PATH="$work/bin:$PATH"

pass=0
check() { # check <name> <command...>
  local name="$1"; shift
  if "$@" >/dev/null 2>&1; then pass=$((pass + 1)); else echo "FAIL: $name" >&2; exit 1; fi
}
inst() { env -u CLAUDE_CODE_SESSION_ID bash "$installer" "$@"; }
check_fails() { # check_fails <name> <error text> <command...>: the command must fail and say the text
  local name="$1" text="$2" out; shift 2
  if out="$("$@" 2>&1)"; then echo "FAIL: $name (succeeded)" >&2; exit 1; fi
  if grep -qF -- "$text" <<<"$out"; then pass=$((pass + 1)); else echo "FAIL: $name (output: $out)" >&2; exit 1; fi
}

# Stub aws: v2, a fixed identity, credentials with awkward characters, an expiry an hour ahead.
# STUB_STS_FAIL_ONCE=<file>: the first sts call fails (no valid SSO session) and creates the file; 'sso login' is logged to
# STUB_LOG. STUB_NO_TOKEN=1: credentials without a session token. STUB_LOG also records AWS_CONFIG_FILE for each call.
SECRET='s3cr$t "q" '"'"'x'"'"' `id` \ end'
export STUB_SECRET="$SECRET"
cat > "$work/bin/aws" <<'STUB'
#!/usr/bin/env bash
[ -z "${STUB_LOG:-}" ] || echo "$1 ${2:-} cfg=${AWS_CONFIG_FILE-unset} creds=${AWS_SHARED_CREDENTIALS_FILE-unset}" >> "$STUB_LOG"
case "$1 ${2:-}" in
  "--version "*) echo "aws-cli/2.15.0 Python/3.11 Linux" ;;
  "sso login") echo "stub: signed in" ;;
  "sts get-caller-identity")
    if [ -n "${STUB_STS_FAIL_ONCE:-}" ] && [ ! -e "$STUB_STS_FAIL_ONCE" ]; then : > "$STUB_STS_FAIL_ONCE"; exit 255; fi
    echo '{"Account":"123456789012","Arn":"arn:aws:sts::123456789012:assumed-role/Dev/me"}' ;;
  "configure export-credentials")
    exp="${STUB_EXPIRATION:-$(python3 -c 'import datetime as d; print((d.datetime.now(d.timezone.utc) + d.timedelta(hours=1)).strftime("%Y-%m-%dT%H:%M:%SZ"))')}"
    jq -n --arg s "$STUB_SECRET" --arg e "$exp" --arg t "$([ -n "${STUB_NO_TOKEN:-}" ] || echo 'tok/en+==')" \
      '{Version:1, AccessKeyId:"AKIATESTKEY", SecretAccessKey:$s, Expiration:$e} + (if $t == "" then {} else {SessionToken:$t} end)' ;;
  "configure get") echo "eu-west-1" ;;
  *) echo "stub aws: unexpected $*" >&2; exit 1 ;;
esac
STUB
chmod +x "$work/bin/aws"

# ---- syntax and shellcheck of the installer and the two embedded scripts ----------------------------------------------
cat > "$HOME/.claude/settings.json" <<'JSON'
{"model": "x", "permissions": {"deny": ["Read(.env)", "Read(~/.claude-aws-sessions/**)", "Edit(~/.claude-aws-sessions/**)"]},
 "sandbox": {"filesystem": {"denyRead": ["~/.ssh"]}},
 "hooks": {"SessionStart": [{"hooks": [{"type": "command", "command": "/other/hook.sh"}]}]}}
JSON
cat > "$HOME/.claude/pre-install.json" < "$HOME/.claude/settings.json"
cat > "$HOME/dev/app/.claude/settings.local.json" <<JSON
{"sandbox": {"filesystem": {"allowWrite": ["~/.aws", "$HOME/.aws/sso", "~/.awsome", "/tmp/x"]}}}
JSON
cp "$HOME/dev/app/.claude/settings.local.json" "$work/project.orig.json"
echo '{"sandbox": {"filesystem": {"allowWrite": ["~/.aws/cli"]}}}' > "$HOME/dev/app/wt/.claude/settings.json"
mkdir -p "$HOME/elsewhere/.claude"
echo '{"sandbox": {"filesystem": {"allowWrite": ["~/.aws"]}}}' > "$HOME/elsewhere/.claude/settings.json"

check "installer bash -n" bash -n "$installer"

# ---- dry run changes nothing ------------------------------------------------------------------------------------------
check "dry run exits 0" inst --dry-run
check "dry run leaves settings alone" cmp "$HOME/.claude/settings.json" "$HOME/.claude/pre-install.json"
check "dry run installs nothing" test ! -e "$HOME/.local/bin/claude-aws-session"
check "n answer changes nothing" bash -c "echo n | env -u CLAUDE_CODE_SESSION_ID bash '$installer' && cmp '$HOME/.claude/settings.json' '$HOME/.claude/pre-install.json'"

# ---- refuses inside a session, and an unknown flag ------------------------------------------------------------------
check_fails "refuses inside a Claude session" "running inside a Claude Code session" env CLAUDE_CODE_SESSION_ID=abc bash "$installer" --yes
check_fails "rejects unknown flags" "unknown argument: --nope" bash "$installer" --nope
check_fails "--restore-allow-write needs --uninstall" "--restore-allow-write only works with --uninstall" bash "$installer" --restore-allow-write --yes
check_fails "installer says when HOME is unset" "HOME is not set" env -u HOME bash "$installer" --yes

# ---- install ----------------------------------------------------------------------------------------------------------
inst --yes >"$work/install.out"
settings="$HOME/.claude/settings.json"
hook="$HOME/.claude/hooks/aws-session-hook.sh"
helper="$HOME/.local/bin/claude-aws-session"
check "denyRead has ~/.aws and keeps ~/.ssh" jq -e '.sandbox.filesystem.denyRead | index("~/.aws") and index("~/.ssh")' "$settings"
check "deny has the ~/.aws rules and keeps Read(.env)" jq -e '.permissions.deny | index("Read(~/.aws/**)") and index("Edit(~/.aws/**)") and index("Read(.env)")' "$settings"
check "Read denies on the sessions folder are removed" jq -e '[.permissions.deny[] | select(test("claude-aws-sessions"))] | length == 0' "$settings"
check "SessionStart hook added beside the existing one" jq -e --arg c "$hook" '[.hooks.SessionStart[].hooks[].command] | (index($c) != null) and (index("/other/hook.sh") != null)' "$settings"
check "SessionEnd hook added" jq -e --arg c "$hook" '[.hooks.SessionEnd[].hooks[].command] | index($c) != null' "$settings"
check "other settings kept" jq -e '.model == "x"' "$settings"
check "project allowWrite: only ~/.aws entries removed" jq -e '.sandbox.filesystem.allowWrite == ["~/.awsome", "/tmp/x"]' "$HOME/dev/app/.claude/settings.local.json"
check "worktree settings scanned too" jq -e '(.sandbox.filesystem.allowWrite | length) == 0' "$HOME/dev/app/wt/.claude/settings.json"
check "files outside the globs untouched" jq -e '.sandbox.filesystem.allowWrite == ["~/.aws"]' "$HOME/elsewhere/.claude/settings.json"
check "settings backup written" bash -c "ls '$settings'.bak.* >/dev/null"
check "sessions dir is 700" bash -c "[ \"\$(stat -c %a '$HOME/.claude-aws-sessions' 2>/dev/null || stat -f %Lp '$HOME/.claude-aws-sessions')\" = 700 ]"
check "no pocketlab names in the installed scripts" bash -c "! grep -ril 'pocketlab\\|pl-aws' '$installer' '$hook' '$helper'"

# ---- a second run changes nothing -------------------------------------------------------------------------------------
cp "$settings" "$work/settings.after1.json"
cp "$HOME/dev/app/.claude/settings.local.json" "$work/project.after1.json"
inst --yes >/dev/null
check "second run: user settings identical" cmp "$settings" "$work/settings.after1.json"
check "second run: project settings identical" cmp "$HOME/dev/app/.claude/settings.local.json" "$work/project.after1.json"
check "second run: one hook entry each" jq -e --arg c "$hook" '([.hooks.SessionStart[].hooks[] | select(.command == $c)] | length) == 1 and ([.hooks.SessionEnd[].hooks[] | select(.command == $c)] | length) == 1' "$settings"

# ---- the embedded scripts ---------------------------------------------------------------------------------------------
check "hook bash -n" bash -n "$hook"
check "helper bash -n" bash -n "$helper"
if command -v shellcheck >/dev/null; then
  check "shellcheck installer" shellcheck "$installer"
  check "shellcheck hook" shellcheck "$hook"
  check "shellcheck helper" shellcheck "$helper"
else
  echo "note: shellcheck is not installed; skipped" >&2
fi

# ---- the helper -------------------------------------------------------------------------------------------------------
sess="$HOME/.claude-aws-sessions"
out="$(env CLAUDE_CODE_SESSION_ID=sidA "$helper" dev)"
check "helper prints the account" grep -q 123456789012 <<<"$out"
check "helper prints the role" grep -q 'Dev/me' <<<"$out"
check "helper prints no secrets" bash -c "! grep -q -e AKIATESTKEY -e 'tok/en' -e 'cr\$t' <<<\"\$1\"" _ "$out"
check "session file is mode 600" bash -c "[ \"\$(stat -c %a '$sess/sidA.env' 2>/dev/null || stat -f %Lp '$sess/sidA.env')\" = 600 ]"
check "session file header has an expiry" grep -Eq '^# expires=[0-9]+$' "$sess/sidA.env"
check "region comes from the profile" grep -q 'eu-west-1' "$sess/sidA.env"
check_fails "helper rejects a bad session ID" "doesn't look like a session ID" "$helper" dev --session '../evil'
check_fails "helper rejects a session ID with a space" "doesn't look like a session ID" "$helper" dev --session 'a b'
check_fails "helper needs a session ID" "no Claude session ID" env -u CLAUDE_CODE_SESSION_ID "$helper" dev
check_fails "helper says when HOME is unset" "HOME is not set" env -u HOME CLAUDE_CODE_SESSION_ID=sidH "$helper" dev
check "no file written for a bad ID" bash -c "[ \"\$(ls '$sess' | wc -l)\" -eq 1 ]"
"$helper" dev --session sidC --region ap-south-1 >/dev/null
check "--region wins" grep -q 'ap-south-1' "$sess/sidC.env"
rm -f "${sess:?}/sidC.env"

# sign-in branch: the first sts call fails, so the helper runs 'aws sso login' and carries on
stublog="$work/stub.log"
: > "$stublog"
rm -f "$work/sts-failed"
env CLAUDE_CODE_SESSION_ID=sidL STUB_LOG="$stublog" STUB_STS_FAIL_ONCE="$work/sts-failed" "$helper" dev >"$work/login.out"
check "helper signs in when sts fails" grep -q '^sso login ' "$stublog"
check "helper says it is signing in" grep -q 'Signing in to dev' "$work/login.out"
check "helper writes the file after signing in" test -e "$sess/sidL.env"
: > "$stublog"
env CLAUDE_CODE_SESSION_ID=sidL STUB_LOG="$stublog" "$helper" dev >/dev/null
check "helper does not sign in when sts works" bash -c "! grep -q '^sso login ' '$stublog'"
rm -f "${sess:?}/sidL.env"

# no session token: refused, nothing written
check_fails "helper refuses credentials without a session token" "no session token" env CLAUDE_CODE_SESSION_ID=sidN STUB_NO_TOKEN=1 "$helper" dev
check "no file written without a session token" test ! -e "$sess/sidN.env"

# a caller's own config locations reach the aws calls; the session's env file still points them at /dev/null
: > "$stublog"
env CLAUDE_CODE_SESSION_ID=sidK STUB_LOG="$stublog" AWS_CONFIG_FILE=/custom/config AWS_SHARED_CREDENTIALS_FILE=/custom/creds "$helper" dev >/dev/null
check "helper keeps a custom AWS_CONFIG_FILE for its aws calls" bash -c "grep -v '^--version' '$stublog' | grep -q . && ! grep -v 'cfg=/custom/config' '$stublog'"
check "helper keeps a custom AWS_SHARED_CREDENTIALS_FILE for its aws calls" bash -c "! grep -v 'creds=/custom/creds' '$stublog'"
check "custom locations don't reach the session file" bash -c "! grep -q '/custom/' '$sess/sidK.env'"
check "session file still points at /dev/null" grep -q 'AWS_CONFIG_FILE=/dev/null' "$sess/sidK.env"
: > "$stublog"
env CLAUDE_CODE_SESSION_ID=sidK STUB_LOG="$stublog" AWS_CONFIG_FILE=/dev/null "$helper" dev >/dev/null
check "helper drops an inherited /dev/null config" bash -c "! grep -q 'cfg=/dev/null' '$stublog'"
rm -f "${sess:?}/sidK.env"

# ---- the loader: the hook's SessionStart line --------------------------------------------------------------------------
envfile="$work/claude-env"
: > "$envfile"
printf '{"hook_event_name":"SessionStart","session_id":"sidA"}' | env CLAUDE_ENV_FILE="$envfile" bash "$hook"
check "SessionStart added exactly one loader line" bash -c "[ \"\$(wc -l < '$envfile')\" -eq 1 ]"
load() { # load <session id>: run a shell that sources the env file the way Claude does before a Bash command, then print vars
  env -i HOME="$HOME" PATH="$PATH" CLAUDE_CODE_SESSION_ID="$1" AWS_PROFILE=leaky bash -c ". '$envfile'; printf '%s|%s|%s|%s|%s' \"\${AWS_ACCESS_KEY_ID-}\" \"\${AWS_SECRET_ACCESS_KEY-}\" \"\${AWS_CONFIG_FILE-}\" \"\${AWS_PROFILE-unset}\" \"\${AWS_REGION-}\""
}
got="$(load sidA)"
check "loader exports the key" test "$(cut -d'|' -f1 <<<"$got")" = AKIATESTKEY
check "special characters in the secret survive" test "$(cut -d'|' -f2 <<<"$got")" = "$SECRET"
check "loader points AWS_CONFIG_FILE at /dev/null" test "$(cut -d'|' -f3 <<<"$got")" = /dev/null
check "loader unsets AWS_PROFILE" test "$(cut -d'|' -f4 <<<"$got")" = unset
check "loader sets the region" test "$(cut -d'|' -f5 <<<"$got")" = eu-west-1
check "another session ID sees nothing" test "$(load sidB)" = "||||unset" -o "$(load sidB | cut -d'|' -f1)" = ""
check "no session ID sees nothing" test "$(env -i HOME="$HOME" PATH="$PATH" bash -c ". '$envfile'; printf '%s' \"\${AWS_ACCESS_KEY_ID-}\"")" = ""

# ---- expiry: an expired file is ignored by the loader and swept at SessionStart ----------------------------------------------
STUB_EXPIRATION="2001-01-01T00:00:00Z" "$helper" dev --session sidOld >/dev/null
check "expired file is written with a past expiry" bash -c "[ \"\$(sed -n 's/^# expires=//p' '$sess/sidOld.env')\" -lt \"\$(date +%s)\" ]"
check "loader ignores an expired file" test "$(load sidOld | cut -d'|' -f1)" = ""
printf 'junk\n' > "$sess/noexpiry.env"
printf '{"hook_event_name":"SessionStart","session_id":"sidA"}' | env CLAUDE_ENV_FILE="$work/env2" bash "$hook"
check "SessionStart sweeps the expired file" test ! -e "$sess/sidOld.env"
check "SessionStart sweeps a file with no expiry" test ! -e "$sess/noexpiry.env"
check "SessionStart keeps a live file" test -e "$sess/sidA.env"

# stray temp files from a helper that died before its mv: old ones are swept, a fresh one is kept
touch "$sess/.tmp.fresh" "$sess/.tmp.stale" "$sess/x.tmp.stale"
touch -d '1 hour ago' "$sess/.tmp.stale" "$sess/x.tmp.stale" 2>/dev/null || touch -t "$(date -v-1H +%Y%m%d%H%M)" "$sess/.tmp.stale" "$sess/x.tmp.stale"
printf '{"hook_event_name":"SessionStart","session_id":"sidA"}' | env CLAUDE_ENV_FILE="$work/env2" bash "$hook"
check "SessionStart sweeps an old temp file" test ! -e "$sess/.tmp.stale"
check "SessionStart sweeps an old *.tmp.* file" test ! -e "$sess/x.tmp.stale"
check "SessionStart keeps a fresh temp file" test -e "$sess/.tmp.fresh"
rm -f "${sess:?}/.tmp.fresh"

# ---- SessionEnd and --revoke delete -------------------------------------------------------------------------------------------
"$helper" dev --session sidB >/dev/null
printf '{"hook_event_name":"SessionEnd","session_id":"sidB"}' | bash "$hook"
check "SessionEnd deletes the session's file" test ! -e "$sess/sidB.env"
check "SessionEnd leaves other sessions alone" test -e "$sess/sidA.env"
printf '{"hook_event_name":"SessionEnd","session_id":"../sidA"}' | bash "$hook"
check "SessionEnd ignores a bad session ID" test -e "$sess/sidA.env"
env CLAUDE_CODE_SESSION_ID=sidA "$helper" --revoke >/dev/null
check "--revoke deletes the file" test ! -e "$sess/sidA.env"
check "after --revoke the loader gives nothing" test "$(load sidA | cut -d'|' -f1)" = ""

# ---- uninstall --------------------------------------------------------------------------------------------------------------
"$helper" dev --session sidKeep >/dev/null
check "uninstall without --yes and with n changes nothing" bash -c "echo n | env -u CLAUDE_CODE_SESSION_ID bash '$installer' --uninstall && test -e '$helper'"
inst --uninstall --yes >/dev/null
check "uninstall removes the helper and the hook script" test ! -e "$helper" -a ! -e "$hook"
check "uninstall removes the session files" test ! -e "$sess/sidKeep.env"
check "uninstall removes only our hooks" jq -e --arg c "$hook" '([.hooks.SessionStart[].hooks[].command] == ["/other/hook.sh"]) and (.hooks.SessionEnd == null)' "$settings"
check "uninstall keeps the ~/.aws block" jq -e '.sandbox.filesystem.denyRead | index("~/.aws")' "$settings"
check "uninstall leaves project allowWrite removed" jq -e '.sandbox.filesystem.allowWrite == ["~/.awsome", "/tmp/x"]' "$HOME/dev/app/.claude/settings.local.json"
inst --yes >/dev/null
inst --uninstall --restore-allow-write --yes >/dev/null
check "--restore-allow-write puts the entries back" jq -e '.sandbox.filesystem.allowWrite | (index("~/.aws") != null) and (index("~/.awsome") != null) and (index("/tmp/x") != null)' "$HOME/dev/app/.claude/settings.local.json"

# ---- --projects-glob replaces the defaults ------------------------------------------------------------------------------------
inst --yes --projects-glob "$HOME/elsewhere/.claude/settings*.json" >/dev/null
check "--projects-glob scans the given files" jq -e '(.sandbox.filesystem.allowWrite | length) == 0' "$HOME/elsewhere/.claude/settings.json"
check "--projects-glob skips the default places" jq -e '.sandbox.filesystem.allowWrite | index("~/.aws") != null' "$HOME/dev/app/.claude/settings.local.json"

# ---- a HOME with a space and regex characters, and a helper refresh with an earlier grant loaded -------------------------------
spaced="$work/John (Smith)+x"
mkdir -p "$spaced/.claude" "$spaced/dev/app/.claude"
echo '{}' > "$spaced/.claude/settings.json"
printf '{"sandbox": {"filesystem": {"allowWrite": ["~/.aws", "%s/.aws/sso", "/tmp/x"]}}}' "$spaced" > "$spaced/dev/app/.claude/settings.json"
HOME="$spaced" inst --yes >/dev/null
check "HOME with spaces: project allowWrite entries removed" jq -e '.sandbox.filesystem.allowWrite == ["/tmp/x"]' "$spaced/dev/app/.claude/settings.json"
check "refresh works with AWS_CONFIG_FILE=/dev/null inherited" env HOME="$spaced" CLAUDE_CODE_SESSION_ID=sidR AWS_CONFIG_FILE=/dev/null AWS_PROFILE=x "$spaced/.local/bin/claude-aws-session" dev

# ---- a symlinked settings.json stays a symlink, with the merged content -----------------------------------------------------
linkhome="$work/linkhome"
mkdir -p "$linkhome/.claude" "$work/dotfiles"
echo '{"model": "linked"}' > "$work/dotfiles/settings.json"
ln -s "$work/dotfiles/settings.json" "$linkhome/.claude/settings.json"
HOME="$linkhome" inst --yes >/dev/null
check "symlinked settings.json is still a symlink" test -L "$linkhome/.claude/settings.json"
check "symlink still points at the dotfile" test "$(readlink "$linkhome/.claude/settings.json")" = "$work/dotfiles/settings.json"
check "merged content landed in the symlink's target" jq -e '.model == "linked" and (.sandbox.filesystem.denyRead | index("~/.aws"))' "$work/dotfiles/settings.json"

# ---- --uninstall --dry-run changes nothing -----------------------------------------------------------------------------------
snapshot() { (cd "$1" && find . | sort && find . -type f -exec cksum {} + | sort); }
snapshot "$linkhome" > "$work/before.snap"
HOME="$linkhome" inst --uninstall --restore-allow-write --dry-run >"$work/dry.out"
snapshot "$linkhome" > "$work/after.snap"
check "uninstall dry run says nothing changed" grep -q 'Dry run: nothing changed' "$work/dry.out"
check "uninstall dry run changes nothing" cmp "$work/before.snap" "$work/after.snap"
check "uninstall dry run keeps the helper and hook" test -x "$linkhome/.local/bin/claude-aws-session" -a -x "$linkhome/.claude/hooks/aws-session-hook.sh"

# ---- --restore-allow-write uses the oldest backup that has the entries --------------------------------------------------------
mbhome="$work/mbhome"
mkdir -p "$mbhome/.claude" "$mbhome/dev/app/.claude"
echo '{}' > "$mbhome/.claude/settings.json"
proj="$mbhome/dev/app/.claude/settings.json"
echo '{"sandbox": {"filesystem": {"allowWrite": ["/tmp/x"]}}}' > "$proj"
echo '{"sandbox": {"filesystem": {"allowWrite": ["~/.aws", "~/.aws/sso", "/tmp/x"]}}}' > "$proj.bak.20260101000000"
echo '{"sandbox": {"filesystem": {"allowWrite": ["~/.aws/cli", "/tmp/x"]}}}' > "$proj.bak.20260201000000"
echo '{"sandbox": {"filesystem": {"allowWrite": ["/tmp/x"]}}}' > "$proj.bak.20250101000000"
HOME="$mbhome" inst --uninstall --restore-allow-write --yes >/dev/null
check "restore takes the entries from the oldest backup that has them" jq -e '.sandbox.filesystem.allowWrite == ["/tmp/x", "~/.aws", "~/.aws/sso"]' "$proj"
check "restore ignores a newer backup's entries" jq -e '.sandbox.filesystem.allowWrite | index("~/.aws/cli") == null' "$proj"

echo "ok ($pass checks)"
