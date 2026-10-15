#!/usr/bin/env bash
# Per-session AWS credentials for Claude Code.
#
# What it does: stops Claude Code from reading your shared AWS credentials (~/.aws, including the SSO cache), and
# gives you a command that hands short-lived credentials to ONE Claude session when it asks. They are removed when
# that session ends and expire on their own (usually within an hour) if it doesn't end cleanly.
# What it changes (after you confirm; each settings file is backed up first as <file>.bak.<timestamp>):
#   1. ~/.claude/settings.json:
#        sandbox.filesystem.denyRead  += "~/.aws"             (sandboxed Bash can't read ~/.aws at all)
#        permissions.deny             += Read/Edit(~/.aws/**)  (file tools)
#        permissions.deny             -= Read/Edit(~/.claude-aws-sessions/**) if an earlier version added them: Claude
#                                        Code turns Read denies into sandbox read denies, which stops the loader
#                                        reading the session's file
#        hooks.SessionStart / SessionEnd += ~/.claude/hooks/aws-session-hook.sh
#   2. Project settings files (default: ~/dev/*/.claude/settings*.json and ~/dev/*/*/.claude/settings*.json, for
#      worktrees; change with --projects-glob) whose sandbox.filesystem.allowWrite lists ~/.aws/...: removes those
#      entries. Sandbox arrays merge across scopes, so a project entry can't be overridden from the user file.
#   3. Installs ~/.local/bin/claude-aws-session (the command you run) and ~/.claude/hooks/aws-session-hook.sh, and
#      creates ~/.claude-aws-sessions (mode 700).
# How it works afterwards:
#   - Claude asks for AWS access and says which calls it wants to make and why.
#   - You run, in that Claude session:  ! claude-aws-session <profile>
#     It signs in with SSO if needed, exports short-lived role credentials into
#     ~/.claude-aws-sessions/<session-id>.env (mode 600), sets AWS_CONFIG_FILE=/dev/null and unsets AWS_PROFILE for
#     that session, and prints only the account, role and expiry.
#   - The SessionStart hook added a line to the session's CLAUDE_ENV_FILE that loads that file before each Bash
#     command while it hasn't expired. The SessionEnd hook deletes it; SessionStart also sweeps expired files.
#   - Revoke early:  ! claude-aws-session --revoke
# Limits (read these):
#   - Hand over a narrow profile: a permission set for the environments the session needs, never prod.
#   - `!` commands run outside the sandbox and their output goes into the conversation, so the helper never prints
#     credentials.
#   - The AWS CLI can't move the SSO cache per session, so your SSO sign-in stays shared on the machine. Only the
#     derived short-lived credentials reach the session.
#   - Sandbox rules are global, not per session: other Claude sessions on the machine can read a live session file.
#     The short expiry is the mitigation.
#   - SessionEnd is best-effort (a crash or Ctrl-C may skip it), so the expiry is the backstop.
# Permissions: run it yourself in a normal terminal, not through Claude. Needs write access to ~/.claude, ~/.local/bin
# and your project settings files, jq, and the aws CLI v2. No AWS login is needed to install.
# Usage: install.sh [--yes] [--dry-run] [--projects-glob GLOB]... [--uninstall [--restore-allow-write]]
#   --yes                  skip the y/N question
#   --dry-run              print what would change and stop; changes nothing
#   --projects-glob GLOB   project settings files to scan (repeatable; replaces the defaults; quote it)
#   --uninstall            remove the hooks, the helper, the hook script and any session files. The ~/.aws block stays.
#   --restore-allow-write  with --uninstall: put the ~/.aws allowWrite entries back from the oldest backup that has them
# Safe to re-run: entries are de-duplicated and hooks are replaced, not added twice. Restart Claude Code afterwards.
set -euo pipefail

[ -n "${HOME:-}" ] || { echo "error: HOME is not set." >&2; exit 1; }
ASSUME_YES=0
DRY_RUN=0
UNINSTALL=0
RESTORE=0
PROJECT_GLOBS=()
USER_SETTINGS="$HOME/.claude/settings.json"
HOOK_PATH="$HOME/.claude/hooks/aws-session-hook.sh"
HELPER_PATH="$HOME/.local/bin/claude-aws-session"
SESSIONS_DIR="$HOME/.claude-aws-sessions"
TS="$(date +%Y%m%d%H%M%S)"

die() { echo "error: $*" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --yes) ASSUME_YES=1 ;;
    --dry-run) DRY_RUN=1 ;;
    --uninstall) UNINSTALL=1 ;;
    --restore-allow-write) RESTORE=1 ;;
    --projects-glob) PROJECT_GLOBS+=("${2:?--projects-glob needs a value}"); shift ;;
    -h | --help) sed -n '2,/^set -euo/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown argument: $1 (try --help)" ;;
  esac
  shift
done
[ "$RESTORE" = 0 ] || [ "$UNINSTALL" = 1 ] || die "--restore-allow-write only works with --uninstall"
if [ ${#PROJECT_GLOBS[@]} -eq 0 ]; then
  PROJECT_GLOBS=("$HOME/dev/*/.claude/settings*.json" "$HOME/dev/*/*/.claude/settings*.json")
fi

# ---- preflight -------------------------------------------------------------------------------------------------------
command -v jq >/dev/null || die "jq is not installed."
if [ "$UNINSTALL" = 0 ]; then
  command -v aws >/dev/null || die "the aws CLI is not installed."
  aws --version 2>&1 | grep -q '^aws-cli/2' || die "the aws CLI must be v2 (for 'aws configure export-credentials')."
fi
[ -f "$USER_SETTINGS" ] || die "$USER_SETTINGS not found."
jq empty "$USER_SETTINGS" 2>/dev/null || die "$USER_SETTINGS is not valid JSON; fix it first."
if [ -n "${CLAUDE_CODE_SESSION_ID:-}" ]; then
  die "this looks like it's running inside a Claude Code session. Run it in a normal terminal."
fi

# Project settings files, from the globs ("~" at the start of a glob means $HOME).
SCANNED=()
shopt -s nullglob
for pattern in "${PROJECT_GLOBS[@]}"; do
  case "$pattern" in "~"/*) pattern="$HOME/${pattern#"~"/}" ;; esac
  # Unquoted on purpose: the pattern is a glob.
  # shellcheck disable=SC2231
  IFS= ; for f in $pattern; do
    if [ -f "$f" ] && jq empty "$f" 2>/dev/null; then SCANNED+=("$f"); fi
  done; unset IFS
done
shopt -u nullglob

# jq filter: allowWrite entries that point into ~/.aws.
# $HOME is regex-escaped and passed to jq as $h, so spaces or regex characters in it are safe.
HOME_RE="$(printf '%s' "$HOME" | sed 's/[][\\.^$*+?(){}|/-]/\\&/g')"
# shellcheck disable=SC2016
AWS_ENTRY='test("^(~|" + $h + ")/\\.aws(/|$)")'
jqh() { jq --arg h "$HOME_RE" "$@"; }
has_aws_entries() {
  jqh -e "[.sandbox.filesystem.allowWrite // [] | .[] | select($AWS_ENTRY)] | length > 0" "$1" >/dev/null 2>&1
}
PROJECT_FILES=()
if [ "$UNINSTALL" = 0 ]; then
  for f in "${SCANNED[@]+"${SCANNED[@]}"}"; do
    if has_aws_entries "$f"; then PROJECT_FILES+=("$f"); fi
  done
fi

# Oldest backup of a project file that still lists ~/.aws write entries (for --restore-allow-write).
oldest_backup_with_aws() {
  local b
  for b in "$1".bak.*; do
    [ -f "$b" ] || continue
    if has_aws_entries "$b"; then echo "$b"; return 0; fi
  done
  return 1
}

# ---- what will change ------------------------------------------------------------------------------------------------
echo "Will change:"
if [ "$UNINSTALL" = 1 ]; then
  echo "  - $USER_SETTINGS: remove the SessionStart and SessionEnd hooks for $HOOK_PATH (the ~/.aws block stays)"
  echo "  - delete $HELPER_PATH, $HOOK_PATH and the session files in $SESSIONS_DIR"
  if [ "$RESTORE" = 1 ]; then
    for f in "${SCANNED[@]+"${SCANNED[@]}"}"; do
      if b="$(oldest_backup_with_aws "$f")"; then echo "  - $f: put its ~/.aws allowWrite entries back from $b"; fi
    done
  else
    echo "  - project allowWrite entries stay removed (add --restore-allow-write to put them back from the backups)"
  fi
else
  echo "  - $USER_SETTINGS:"
  echo "      sandbox.filesystem.denyRead += ~/.aws"
  echo "      permissions.deny += Read(~/.aws/**) Edit(~/.aws/**); -= Read/Edit(~/.claude-aws-sessions/**) if present"
  echo "      hooks SessionStart, SessionEnd -> $HOOK_PATH"
  if [ ${#PROJECT_FILES[@]} -gt 0 ]; then
    for f in "${PROJECT_FILES[@]}"; do
      echo "  - $f: remove from sandbox.filesystem.allowWrite: $(jqh -r "[.sandbox.filesystem.allowWrite[] | select($AWS_ENTRY)] | join(\" \")" "$f")"
    done
  else
    echo "  - no scanned project settings give write access to ~/.aws"
  fi
  echo "  - install $HELPER_PATH and $HOOK_PATH; create $SESSIONS_DIR (mode 700)"
fi
echo
if [ "$DRY_RUN" = 1 ]; then echo "Dry run: nothing changed."; exit 0; fi
if [ "$ASSUME_YES" != 1 ]; then
  read -r -p "Apply these changes? [y/N] " answer
  [ "$answer" = y ] || [ "$answer" = Y ] || { echo "Nothing changed."; exit 0; }
fi

# ---- uninstall -------------------------------------------------------------------------------------------------------
if [ "$UNINSTALL" = 1 ]; then
  cp "$USER_SETTINGS" "$USER_SETTINGS.bak.$TS"
  tmp="$(mktemp)"
  jq --arg cmd "$HOOK_PATH" '
    def drop($event):
      if (.hooks[$event] // null) == null then .
      else .hooks[$event] |= (map(.hooks |= map(select(.command != $cmd))) | map(select((.hooks | length) > 0)))
        | if (.hooks[$event] | length) == 0 then del(.hooks[$event]) else . end end;
    if (.hooks | type) == "object" then drop("SessionStart") | drop("SessionEnd") else . end
  ' "$USER_SETTINGS" > "$tmp"
  cat "$tmp" > "$USER_SETTINGS" && rm -f "${tmp:?}"
  rm -f "${HELPER_PATH:?}" "${HOOK_PATH:?}"
  if [ -d "$SESSIONS_DIR" ]; then
    rm -f "${SESSIONS_DIR:?}"/*.env "${SESSIONS_DIR:?}"/.tmp.*
    rmdir "$SESSIONS_DIR" 2>/dev/null || true
  fi
  if [ "$RESTORE" = 1 ]; then
    for f in "${SCANNED[@]+"${SCANNED[@]}"}"; do
      if b="$(oldest_backup_with_aws "$f")"; then
        cp "$f" "$f.bak.$TS"
        tmp="$(mktemp)"
        jqh --slurpfile old "$b" "
          .sandbox.filesystem.allowWrite = ((.sandbox.filesystem.allowWrite // []) + [\$old[0].sandbox.filesystem.allowWrite // [] | .[] | select($AWS_ENTRY)] | unique)
        " "$f" > "$tmp"
        cat "$tmp" > "$f" && rm -f "${tmp:?}"
      fi
    done
  fi
  echo "Uninstalled. Backups: *.bak.$TS. Restart Claude Code so the hooks are dropped."
  exit 0
fi

# ---- install the hook ------------------------------------------------------------------------------------------------
mkdir -p "$(dirname "$HOOK_PATH")" "$(dirname "$HELPER_PATH")"
mkdir -p "$SESSIONS_DIR" && chmod 700 "$SESSIONS_DIR"

cat > "$HOOK_PATH" <<'HOOK'
#!/usr/bin/env bash
# Claude Code SessionStart/SessionEnd hook for per-session AWS credentials (installed by claude-aws-session's install.sh).
# SessionStart: sweeps expired credential files and stray temp files and adds a line to CLAUDE_ENV_FILE that loads this session's file
# (if present and unexpired) before each Bash command. SessionEnd: deletes this session's file.
set -u
dir="$HOME/.claude-aws-sessions"
input="$(cat)"
event="$(jq -r '.hook_event_name // empty' <<<"$input" 2>/dev/null)"
sid="$(jq -r '.session_id // empty' <<<"$input" 2>/dev/null)"
case "$sid" in *[!A-Za-z0-9_-]*) sid="" ;; esac
case "$event" in
  SessionStart)
    mkdir -p "$dir" && chmod 700 "$dir"
    now="$(date +%s)"
    for f in "$dir"/*.env; do
      [ -e "$f" ] || continue
      exp="$(sed -n 's/^# expires=//p' "$f" | head -1)"
      case "$exp" in '' | *[!0-9]*) rm -f -- "$f"; continue ;; esac
      if [ "$exp" -le "$now" ]; then rm -f -- "$f"; fi
    done
    # Temp files a helper left behind when it was killed between mktemp and mv.
    find "$dir" -maxdepth 1 -type f \( -name '.tmp.*' -o -name '*.tmp.*' \) -mmin +5 -exec rm -f -- {} + 2>/dev/null || true
    if [ -n "${CLAUDE_ENV_FILE:-}" ]; then
      # The session ID is read when each Bash command runs, so /clear's new ID is used.
      printf '%s\n' "f=\"$dir/\${CLAUDE_CODE_SESSION_ID:-none}.env\"; if [ -r \"\$f\" ]; then . \"\$f\"; fi; unset f" >> "$CLAUDE_ENV_FILE"
    fi
    ;;
  SessionEnd)
    if [ -n "$sid" ]; then rm -f -- "${dir:?}/${sid:?}.env"; fi
    ;;
esac
exit 0
HOOK
chmod 755 "$HOOK_PATH"

# ---- install the helper ----------------------------------------------------------------------------------------------
cat > "$HELPER_PATH" <<'HELPER'
#!/usr/bin/env bash
# claude-aws-session: hand short-lived AWS credentials to one Claude Code session.
#
# Usage (from the Claude session, with the ! prefix):
#   ! claude-aws-session <profile> [--region R] [--session ID]
#   ! claude-aws-session --revoke [--session ID]
# The session ID defaults to $CLAUDE_CODE_SESSION_ID; if that isn't set in ! commands, ask Claude for its session ID
# (it can run: echo "$CLAUDE_CODE_SESSION_ID") and pass it with --session.
#
# Signs in with 'aws sso login' when the profile has no valid session, then writes role credentials from
# 'aws configure export-credentials' to ~/.claude-aws-sessions/<session-id>.env (mode 600). Prints only the account,
# role and expiry: never the credentials, because ! output goes into the conversation.
set -euo pipefail

# A refresh may run with an earlier grant's variables loaded (AWS_CONFIG_FILE=/dev/null would hide the profile), so drop
# those. A caller's own AWS_CONFIG_FILE / AWS_SHARED_CREDENTIALS_FILE (a custom location) is kept for the calls below;
# only the session's env file, written further down, never carries them.
unset AWS_PROFILE AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN
[ "${AWS_CONFIG_FILE:-}" != /dev/null ] || unset AWS_CONFIG_FILE
[ "${AWS_SHARED_CREDENTIALS_FILE:-}" != /dev/null ] || unset AWS_SHARED_CREDENTIALS_FILE

[ -n "${HOME:-}" ] || { echo "claude-aws-session: HOME is not set." >&2; exit 1; }

dir="$HOME/.claude-aws-sessions"
profile=""
region=""
sid="${CLAUDE_CODE_SESSION_ID:-}"
revoke=0

die() { echo "claude-aws-session: $*" >&2; exit 1; }

iso_to_epoch() {
  # e.g. 2026-10-15T20:00:00+00:00 or 2026-10-15T20:00:00Z. GNU date first, then BSD/macOS date (UTC), then python3.
  date -d "$1" +%s 2>/dev/null \
    || date -j -u -f '%Y-%m-%dT%H:%M:%S' "${1:0:19}" +%s 2>/dev/null \
    || python3 -c 'import sys, datetime; print(int(datetime.datetime.fromisoformat(sys.argv[1].replace("Z", "+00:00")).timestamp()))' "$1" 2>/dev/null \
    || true
}
fmt_epoch() {
  date -d "@$1" '+%Y-%m-%d %H:%M %Z' 2>/dev/null || date -r "$1" '+%Y-%m-%d %H:%M %Z' 2>/dev/null || echo "epoch $1"
}

while [ $# -gt 0 ]; do
  case "$1" in
    --revoke) revoke=1 ;;
    --region) region="${2:?--region needs a value}"; shift ;;
    --session) sid="${2:?--session needs a value}"; shift ;;
    -h | --help) sed -n '2,/^set -euo/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) die "unknown option: $1" ;;
    *) [ -z "$profile" ] || die "only one profile"; profile="$1" ;;
  esac
  shift
done

[ -n "$sid" ] || die "no Claude session ID. Ask Claude for it (echo \"\$CLAUDE_CODE_SESSION_ID\") and pass --session ID."
case "$sid" in *[!A-Za-z0-9_-]*) die "that doesn't look like a session ID: $sid" ;; esac
file="$dir/$sid.env"

if [ "$revoke" = 1 ]; then
  rm -f -- "${dir:?}/${sid:?}.env"
  echo "Removed AWS credentials for Claude session $sid."
  exit 0
fi

[ -n "$profile" ] || die "usage: claude-aws-session <profile> [--region R] [--session ID]"
command -v jq >/dev/null || die "jq is not installed."

if ! aws sts get-caller-identity --profile "$profile" >/dev/null 2>&1; then
  echo "Signing in to $profile..."
  aws sso login --profile "$profile" >&2
fi
identity="$(aws sts get-caller-identity --profile "$profile" --output json)" || die "couldn't use profile $profile."
creds="$(aws configure export-credentials --profile "$profile" --format process)" || die "couldn't export credentials for $profile."

[ -n "$region" ] || region="$(aws configure get region --profile "$profile" 2>/dev/null || true)"
[ -n "$region" ] || region="us-east-1"

key="$(jq -r '.AccessKeyId // empty' <<<"$creds")"
secret="$(jq -r '.SecretAccessKey // empty' <<<"$creds")"
token="$(jq -r '.SessionToken // empty' <<<"$creds")"
expiration="$(jq -r '.Expiration // empty' <<<"$creds")"
if [ -z "$key" ] || [ -z "$secret" ] || [ -z "$token" ]; then
  die "$profile didn't give temporary role credentials (no session token); use an SSO or role profile."
fi

expires=""
if [ -n "$expiration" ]; then expires="$(iso_to_epoch "$expiration")"; fi
case "$expires" in '' | *[!0-9]*) expires="$(( $(date +%s) + 3600 ))" ;; esac

mkdir -p "$dir" && chmod 700 "$dir"
umask 077
tmp="$(mktemp "$dir/.tmp.XXXXXX")"
{
  echo "# expires=$expires"
  echo "# profile=$profile"
  echo "if [ \"\$(date +%s)\" -lt $expires ]; then"
  printf '  export AWS_ACCESS_KEY_ID=%q\n' "$key"
  printf '  export AWS_SECRET_ACCESS_KEY=%q\n' "$secret"
  printf '  export AWS_SESSION_TOKEN=%q\n' "$token"
  printf '  export AWS_REGION=%q AWS_DEFAULT_REGION=%q\n' "$region" "$region"
  echo "  export AWS_CONFIG_FILE=/dev/null AWS_SHARED_CREDENTIALS_FILE=/dev/null"
  echo "  unset AWS_PROFILE"
  echo "fi"
} > "$tmp"
mv "$tmp" "$file"

echo "AWS credentials ready for Claude session $sid:"
echo "  account $(jq -r .Account <<<"$identity"), $(jq -r .Arn <<<"$identity" | sed 's#.*:assumed-role/##')"
echo "  region $region, expires $(fmt_epoch "$expires")"
echo "Revoke early: ! claude-aws-session --revoke --session $sid"
HELPER
chmod 755 "$HELPER_PATH"

# ---- settings --------------------------------------------------------------------------------------------------------
cp "$USER_SETTINGS" "$USER_SETTINGS.bak.$TS"
tmp="$(mktemp)"
jq --arg cmd "$HOOK_PATH" '
  def addhook($event; $timeout):
    .hooks[$event] = (
      ((.hooks[$event] // []) | map(.hooks |= map(select(.command != $cmd))) | map(select((.hooks | length) > 0)))
      + [{hooks: [({type: "command", command: $cmd} + (if $timeout then {timeout: $timeout} else {} end))]}]
    );
  .sandbox.filesystem.denyRead = ((.sandbox.filesystem.denyRead // []) + ["~/.aws"] | unique)
  | .permissions.deny = ((.permissions.deny // [])
      + ["Read(~/.aws/**)", "Edit(~/.aws/**)"]
      | map(select(. != "Read(~/.claude-aws-sessions/**)" and . != "Edit(~/.claude-aws-sessions/**)"))
      | unique)
  | .hooks = (if (.hooks | type) == "object" then .hooks else {} end)
  | addhook("SessionStart"; null)
  | addhook("SessionEnd"; 10)
' "$USER_SETTINGS" > "$tmp"
cat "$tmp" > "$USER_SETTINGS" && rm -f "${tmp:?}"

for f in "${PROJECT_FILES[@]+"${PROJECT_FILES[@]}"}"; do
  cp "$f" "$f.bak.$TS"
  tmp="$(mktemp)"
  jqh ".sandbox.filesystem.allowWrite |= map(select($AWS_ENTRY | not))" "$f" > "$tmp"
  cat "$tmp" > "$f" && rm -f "${tmp:?}"
done

# ---- check -----------------------------------------------------------------------------------------------------------
echo
echo "Check:"
jq -r '"  denyRead: \(.sandbox.filesystem.denyRead | join(" "))",
       "  deny rules for ~/.aws: \([.permissions.deny[] | select(test("aws"))] | join(" "))",
       "  SessionStart hooks: \([.hooks.SessionStart[].hooks[].command] | join(" "))",
       "  SessionEnd hooks: \([.hooks.SessionEnd[].hooks[].command] | join(" "))"' "$USER_SETTINGS"
for f in "${PROJECT_FILES[@]+"${PROJECT_FILES[@]}"}"; do
  left="$(jqh -r "[.sandbox.filesystem.allowWrite // [] | .[] | select($AWS_ENTRY)] | length" "$f")"
  echo "  $f: ~/.aws write entries left: $left"
done
for p in "$HELPER_PATH" "$HOOK_PATH"; do
  if [ -x "$p" ]; then echo "  installed: $p"; else echo "  MISSING: $p"; fi
done
if command -v claude-aws-session >/dev/null; then
  echo "  claude-aws-session is on PATH"
else
  echo "  note: $(dirname "$HELPER_PATH") is not on PATH"
fi
echo
echo "Done. Backups: *.bak.$TS. Restart Claude Code so the sandbox rules and hooks load in new sessions."
