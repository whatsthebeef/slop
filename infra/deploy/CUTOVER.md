# Cutting over from the laptop to production

Generic steps for moving slop's boards from the laptop's Postgres to production and pointing every integration at
production. The run-through with real names (address, bucket, App names, which boards deploy with CodeBuild), timings and
the uptime service is in the board's knowledge base. Restoring production from its own backups is [RESTORE.md](RESTORE.md).

Placeholders: `<prod>` is the host stack's `PublicUrl` output (`https://<id>.cloudfront.net`), `<stage>` is `prod`.
The tooling is `infra/deploy/cutover.sh` (laptop; it runs `cutover-remote.sh` on the instance through SSM):

| Command                                  | What it does                                                                                                                                                                                                                          |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cutover.sh selftest [db]`               | Local, no AWS: dump, restore into a scratch database, compare exact counts; swap and roll back between scratch databases.                                                                                                             |
| `cutover.sh prepare [--dry-run]`         | Freeze, migration and disk-space checks, `pg_dump -Fc`, upload to `s3://<BackupBucket>/cutover/<stamp>/`, restore into `slop_restore` on the instance, compare exact per-table counts: **PASS** or **FAIL**. Nothing live is touched. |
| `cutover.sh swap <stamp> [--dry-run]`    | After typed confirmation: under the deploy lock, stop the app, rename `slop` to `slop_pre_cutover_<stamp>` and `slop_restore` to `slop`, clear `sessions`, start the app; renames back if it doesn't answer `/auth/config`.           |
| `cutover.sh discard <stamp> [--dry-run]` | Drop `slop_restore` and the instance's copy of the files (after a rehearsal or a FAIL).                                                                                                                                               |

Run them with production's AWS credentials (`AWS_PROFILE`, `AWS_REGION` if not `us-east-1`). `--dry-run` prints the S3 keys
and the exact SSM commands instead of sending them.

## 1. Before, any day

- [ ] Production runs current main and `infra/deploy/verify.sh <prod>` passes.
- [ ] `/slop/<stage>/server-env` (SSM String parameter, one `KEY=VALUE` per line) holds, besides s15f34's Cognito settings:
  - `GITHUB_APP_NAME=<production App name>` (the manifest flow names the App after it; the default is `slop-dev`, which
    clashes with the dev App),
  - `CLAUDE_CODE_CLIENT_ID=<ClaudeCodeClientId>` from the production auth stack (the agent set's `.mcp.json` is templated
    from it),
  - `SLACK_WORKSPACES=<workspace id>=<board>,...` as on the laptop,
  - `AWS_WEBHOOK_KEY` with each deploy target stack's key (the value of its `WebhookKeySecretArn` secret), comma-separated
    on the one line (`AWS_WEBHOOK_KEY=<key1>,<key2>`). This parameter is plaintext to anyone with `ssm:GetParameter`; moving
    the key into Secrets Manager is a follow-up glob.
  - the same `SLOP_WORK_TIME_ZONE` as the laptop, if set there.

  Then redeploy so `app.env` picks it up: `aws codebuild start-build --project-name <DeployProject>`.

- [ ] Slack (same Slack app, so the same values as the laptop's): `aws secretsmanager put-secret-value` for
      `slop/<stage>/slack-signing-secret` and `slop/<stage>/slack-bot-token`.
- [ ] Routine fire tokens: for each entry in the laptop's `apps/server/.routines.json`,
      `SLOP_SECRETS_PREFIX=slop/<stage>/ scripts/set-routine.sh <email> [board]` (paste the URL and token).
- [ ] IAM Identity Center: each member's email is exactly the email slop has for them (sign-in matches by lowercased email;
      a different one signs in as a new user with no boards). List them locally:
      `docker exec slop-postgres-1 psql -U slop -d slop -c "select distinct email from members order by 1"`.
      Stored Cognito user IDs from the dev pool don't matter: sign-in overwrites them.
- [ ] Sign in on `<prod>` and create the production GitHub App at `<prod>/setup/github-app` (the manifest flow sets the
      webhook URL `<prod>/webhooks/github`, the callback and the Setup URL `<prod>/setup/github-app/installed`, and stores the
      credentials in `slop/<stage>/github-app`). The dev App stays for local work. Don't install it on the boards' repos yet.
- [ ] Boards that deploy branches with CodeBuild (board settings, provider `codebuild`): redeploy the host stack with
      `-c deployProjects=<project>,<project>` (with the usual `-c stage=prod -c deployConnectionArn=...`) so the instance role
      may start their builds. Same account and region only; projects elsewhere need a cross-account role (a separate glob).
- [ ] Bedrock: nothing to set; production calls it with the instance role. The System page shows no LLM errors.

## 2. Rehearsal

- [ ] Locally: `infra/deploy/cutover.sh selftest` (with the local server stopped), or against a copy:
      `infra/deploy/cutover.sh selftest <scratch db>`. Expect `SELFTEST PASS`.
- [ ] On production: `infra/deploy/cutover.sh prepare` with the laptop frozen (section 3's first two items; restart local
      afterwards). Expect **PASS**, then `infra/deploy/cutover.sh discard <stamp>`. Note how long it took: that is the
      cutover window.
- `prepare` checks the disk space before it uploads the dump: the laptop's temp dir needs the local database's size
  (otherwise set `TMPDIR`), and the instance's data disk (`/var/lib/slop`, the live database's disk) twice the dump plus
  the local database's size, since the rehearsal restores a full copy next to the live one. It prints both; if the
  instance is short, grow the data disk first and clean up with `discard <stamp>`.
- A **FAIL** touches nothing live; the table shows which tables differ. Discard, find why, prepare again.
- "migration levels differ": deploy current main to production, or bring the laptop's checkout to origin/main and
  restart it once so it migrates, then prepare again.

## 3. Cutover window

- [ ] No routine run is in progress on any board (a run talks to the laptop's MCP address and would time out).
- [ ] Freeze the laptop: Ctrl-C `scripts/dev.sh follow` if it runs (it restarts the server when main moves), then
      `scripts/dev.sh stop`. Sessions' servers use their own databases and can stay. `prepare` and `swap` refuse while the
      `slop-dev` tmux session, anything on :3000, the follow loop or any connection to the local `slop` database remains.
- [ ] `infra/deploy/cutover.sh prepare` → **PASS**, and note the stamp. Keep the laptop frozen from here, and don't
      restart Docker or the laptop's Postgres: `swap` compares the local database's write statistics with prepare's,
      and a restart (or crash) between prepare and swap means running `prepare` again.
- [ ] Pending outbox effects run on production as soon as it starts on the new database, so before the swap: install the
      production GitHub App on every board's repo, and uninstall the dev App from those repos (the local database keeps its
      boards as dev data; with the dev App gone it can't act on real PRs). Routine secrets are already set (section 1).
- [ ] `infra/deploy/cutover.sh swap <stamp>`, type the stage name. It ends with `/auth/config` through CloudFront and
      `verify.sh <prod>`.

### Rolling back

A swap that fails on its own renames back by itself; a second attempt starts from `prepare` (the rolled-back
`slop_restore` has no sessions, so its counts no longer match). If `swap` ends without Success, it prints how to see which
database is live: look before doing anything else.

To go back after a swap, while nothing has been written on production that matters (the previous database is still
there):

1. On the instance (`aws ssm start-session --target <InstanceId>`, `sudo -i`), take the deploy lock and stop the app only
   if the lock was taken:
   `exec 9>/opt/slop/.deploy.lock; if flock -w 300 9; then docker stop slop-app-1; else echo "deploy lock busy"; fi`.
   On "deploy lock busy" a deploy is running: let it finish, then run the line again.
2. From `docker exec -it slop-postgres-1 psql -U slop -d postgres`, end the remaining connections and rename both in one
   transaction (if the second rename fails, neither happens). If it fails (a client reconnected), run the block again:

   ```sql
   select pg_terminate_backend(pid) from pg_stat_activity
     where datname in ('slop', 'slop_pre_cutover_<stamp>') and pid <> pg_backend_pid();
   begin;
   alter database slop rename to slop_restore;
   alter database slop_pre_cutover_<stamp> rename to slop;
   commit;
   ```

3. `docker start slop-app-1`, check `curl -fsS --max-time 5 localhost:3000/auth/config`, and release the lock (`exec 9>&-`,
   or end the shell).
4. Give the boards' repos back to the laptop: reinstall the dev GitHub App on every board's repo, and uninstall (or
   suspend) the production App's installations on them, so production stops receiving their webhooks and can't act on
   their PRs.
5. Undo whichever section 4 repoints were already done: the claude.ai connector back to the laptop's `/mcp` and its dev
   client; Claude Code's user-scope `slop` back to `http://localhost:3000/mcp` with the dev Claude Code client;
   `SLOP_URL` and `SLOP_CLIENT_ID` in `~/.config/slop/config`, `~/.config/sstor/config` and each repo's
   `.sstor/sstor.conf`, then `slop login` / `sstor login` and `sstor init`; the Slack Interactivity Request URL and the
   Apps Script `SLOP_URL` back to the laptop's ngrok address; each DeployTargetStack redeployed with its old
   `-c deployTargetWebhookUrl`; and the routines, whose connector follows the claude.ai connector (their fire tokens are
   the same on both sides).
6. Start the laptop again (`scripts/dev.sh`, with jobs on and the `.routines.json` put back if it was moved aside in
   section 7). It still has the data as it was at the freeze.

Do the same steps 4 and 5 if the cutover is abandoned after a swap that rolled itself back.

Drop `slop_pre_cutover_<stamp>` (`docker exec slop-postgres-1 dropdb -U slop slop_pre_cutover_<stamp>`) after a week. The
S3 copies under `cutover/` expire after 30 days with the backups.

## 4. Repoint

- [ ] claude.ai: the Slop connector → `<prod>/mcp` with the production connector client (`ClaudeConnectorClientId` from the
      production auth stack); reconnect.
- [ ] Claude Code: register `slop` at user scope against production:
      `claude mcp remove --scope user slop`, then
      `claude mcp add --scope user --transport http slop <prod>/mcp --client-id <ClaudeCodeClientId> --callback-port 7779`,
      and authenticate once. Optionally keep local as `slop-dev` (`claude mcp add --scope user --transport http slop-dev
http://localhost:3000/mcp --client-id <dev Claude Code client> --callback-port 7779`); the agents only call `slop`.
- [ ] slop CLI and sstor: `SLOP_URL=<prod>` and `SLOP_CLIENT_ID=<ClaudeCodeClientId>` in `~/.config/slop/config`,
      `~/.config/sstor/config` and each repo's `.sstor/sstor.conf`; then `slop login` / `sstor login`, and `sstor init` in each
      repo so its `.mcp.json` comes from production.
- [ ] Slack: the app's Interactivity Request URL → `<prod>/integrations/slack/interactivity`.
- [ ] Meet-notes Apps Script: script property `SLOP_URL` → `<prod>`. Integration tokens moved with the database (they are
      stored hashed), so the existing token keeps working; issuing a new one in board settings is optional.
- [ ] Each DeployTargetStack: redeploy with `-c deployTargetWebhookUrl=<prod>/webhooks/aws` (and its usual context), so build
      results reach production.

## 5. Done when (T3)

- [ ] Every board is visible on `<prod>` to its members.
- [ ] A GitHub webhook is received: the production App → Advanced → Recent deliveries shows a 2xx.
- [ ] A routine fires from production (a glob picked up by a routine shows its run).
- [ ] MCP answers from Claude Code (`whoami` through `slop`) and from claude.ai (the connector).
- [ ] A branch deploy runs on a board that deploys with CodeBuild, and its result comes back.

## 6. Uptime (T4)

- [ ] A free external monitor (UptimeRobot or Better Stack free tier): HTTP check on `<prod>/auth/config` every 5 minutes
      (it is public and the deploy's own health check; `/api/health` needs sign-in), alerting the owner by email.
- [ ] Record the service and monitor in the knowledge base (`submit_learning`).

## 7. Local development after cutover

- `scripts/dev.sh` keeps its own database and the dev Cognito pool. The local database keeps the boards as dev data.
- Run local with `SLOP_JOBS=none` (no reconcile, outbox or routines; put it in `apps/server/.env.local` or `.slop-dev`)
  unless testing integrations; the dev App is installed only on repos that aren't production boards'.
- Move `apps/server/.routines.json` aside (e.g. to `~/slop-routines.json.pre-cutover`, outside the repo): it holds the real
  routines' fire tokens, and a local server started with jobs on would fire routines whose connector now points at
  production. Production has its own copies in Secrets Manager (section 1).
- The ngrok tunnel is only for testing integrations (GitHub, Slack) locally.
- Submit the real names, timings and this note for the build doc to the knowledge base (`submit_learning`).
