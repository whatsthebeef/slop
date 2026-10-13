# Deploy scripts

## Rollout scripts: a person runs these, never an agent

`host-deploy.sh` and `server-env.sh` change paid infrastructure (the host stack, CloudFront, CodeBuild) and IAM, and
production settings. Run them yourself, from a terminal with an AWS session for the account. Agents and routines must
not run them; `host-deploy.sh` refuses to run without a terminal unless you pass `--yes`.

- `host-deploy.sh [--stage prod] [--yes]` reads the host stack's cdk context from the live stack (deploy connection,
  domain and certificate, alert email, deploy projects, the instance's AMI and data volume), prints it, runs `cdk diff`
  and asks before `cdk deploy`. Read the diff first; see `HOST.md`.
- `server-env.sh [--stage prod] set KEY=VALUE... [--unset KEY]... [--redeploy] [--dry-run]` changes only the named
  lines of `/slop/<stage>/server-env` and never prints values. `--redeploy` starts the deploy project and waits for it.

Nothing account-specific (IDs, ARNs, domains, emails) belongs in these scripts; they look it up at run time.
