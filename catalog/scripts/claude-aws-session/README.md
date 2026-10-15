# claude-aws-session

Per-session AWS credentials for Claude Code. Claude can't read your shared AWS credentials (`~/.aws`, including the SSO cache). When a step needs AWS, Claude asks, you hand that one session short-lived credentials, and they go away when the session ends.

## Why

A Claude session can pick up your AWS access without being asked: it sets `AWS_PROFILE` from a repo's config and the CLI reads the cached SSO token from `~/.aws/sso/cache`. Even read-only calls then run with whatever your profile allows, often admin. This script makes AWS access something you grant per session.

## What it does

- **Block.** The installer adds `sandbox.filesystem.denyRead: ["~/.aws"]` and `permissions.deny` rules `Read(~/.aws/**)` and `Edit(~/.aws/**)` to `~/.claude/settings.json`. It also removes `~/.aws/...` entries from the `sandbox.filesystem.allowWrite` of project settings files, because sandbox arrays merge across scopes and a project entry can't be overridden from the user file.
- **Grant.** In the session, you run `! claude-aws-session <profile>`. It signs in with `aws sso login` if needed and writes the role credentials from `aws configure export-credentials` to `~/.claude-aws-sessions/<session-id>.env` (mode 600, with an expiry guard). The session gets `AWS_CONFIG_FILE=/dev/null` and no `AWS_PROFILE`. It prints only the account, role and expiry.
- **Load.** A SessionStart hook appends one line to the session's `CLAUDE_ENV_FILE`, which Claude Code runs before each Bash command. The line sources `~/.claude-aws-sessions/${CLAUDE_CODE_SESSION_ID}.env` when it is readable. The ID is read per command, so the new ID after `/clear` works.
- **Remove.** A SessionEnd hook deletes the session's file. SessionStart sweeps expired files. `! claude-aws-session --revoke` deletes it early, and the next Bash call has no credentials.

## Install

Run it yourself in a normal terminal (not through Claude). It needs `jq` and the AWS CLI v2, and write access to `~/.claude`, `~/.local/bin` and your project settings. No AWS login is needed.

```
bash catalog/scripts/claude-aws-session/install.sh --dry-run   # show what would change
bash catalog/scripts/claude-aws-session/install.sh             # asks y/N; --yes skips the question
```

- `--projects-glob GLOB` sets which project settings files are scanned (repeatable, quote it, replaces the defaults). The defaults are `~/dev/*/.claude/settings*.json` and `~/dev/*/*/.claude/settings*.json` (worktrees).
- Each settings file is backed up first as `<file>.bak.<timestamp>`. Re-running changes no setting (it only writes a new backup).
- `--uninstall` removes the hooks, the helper, the hook script and any session files. The `~/.aws` block stays. Add `--restore-allow-write` to put only the removed `~/.aws` `allowWrite` entries back from the oldest backup that has them.
- Restart Claude Code afterwards so the sandbox rules and hooks load. Make sure `~/.local/bin` is on your `PATH`.

## Use

1. Claude says which AWS calls it wants to make and why.
2. You run `! claude-aws-session <profile>` in that session. If `CLAUDE_CODE_SESSION_ID` isn't set in `!` commands, ask Claude for it (`echo "$CLAUDE_CODE_SESSION_ID"`) and pass `--session ID`. `--region R` overrides the profile's region.
3. Revoke early with `! claude-aws-session --revoke`. Otherwise it ends with the session or on expiry.

Hand over a narrow profile: a permission set for the environments the session needs, never prod.

## Trust model and limits

- `!` commands run outside the sandbox and their output goes into the conversation, so the helper never prints credentials.
- Don't add a Read deny for `~/.claude-aws-sessions`. Claude Code turns `permissions.deny` `Read(...)` rules into sandbox read denials, which would stop the loader (it runs in the sandboxed shell) from reading the file. The installer removes such rules if an earlier version added them.
- The AWS CLI can't move the SSO cache per session, so your SSO sign-in stays shared on the machine. Only the derived short-lived credentials reach the session.
- Sandbox rules are global, not per session: other Claude sessions on the machine can read a live session file. The short expiry is the mitigation.
- SessionEnd is best-effort (a crash or Ctrl-C may skip it), so the expiry is the backstop.

## Test

```
bash catalog/scripts/claude-aws-session/install.test.sh
```

It runs the installer, hook and helper in a fake `HOME` with a stub `aws`, and runs `shellcheck` on all three scripts when it is installed.
