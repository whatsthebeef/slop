# ATF runners

An ATF runner is any system that runs a board's acceptance tests and tells slop how they went. slop only observes: it never blocks a PR, approval, sign-off or deploy on ATF. Each board registers its runners (Board Settings, or `POST /api/boards/:b/atf-runners` as a board admin), and each runner has its own identity.

## The contract

1. **Trigger.** The runner's own pipeline runs after a deploy (or a branch deploy). A runner that can't watch for deploys itself can register a webhook (see "Deploy-live webhook" below): slop calls it once the deploy is live and checked, and the runner then does steps 3 and 4.
2. **Identity.** One of the methods below, sent as `Authorization: Bearer <credential>`. slop resolves it to one registered runner on one board; anything else is a plain `401`.
3. **Specs.** `GET /integrations/boards/:b/atf-specs?environment=<env>&sha=<sha>`. `202` means slop is still checking the deploy (wait `retryAfterSeconds`), `409` means a newer deploy replaced the commit, `200` has the planned `specs` and `greps`. Run the default suite on anything else.
4. **Results.** `POST /integrations/boards/:b/atf-results` with `{environment | branch, sha, passed, failed, skipped, url?, specs?: [{file, status, tests, failed}]}` and an `Idempotency-Key` header naming this pipeline run (a build id; one per run, not per commit, or an identical re-run is dropped as a redelivery). `201` recorded, `200` ignored (a redelivery, or nothing on the board to attach it to), `403` the runner doesn't serve that environment, `401` identity not accepted.

`atf-specs.sh` and `atf-report.sh` in this directory do steps 3 and 4 and choose the identity from the environment. They never fail the pipeline and never print a token.

| Variable | Meaning |
| --- | --- |
| `SLOP_URL`, `SLOP_BOARD` | slop's address and the board's number |
| `SLOP_ENVIRONMENT`, `SLOP_SHA`, `SLOP_GLOB` | environment tested, commit it runs, glob for a branch run |
| `SLOP_OIDC_TOKEN` | a CI-issued JWT (identity 1) |
| `SLOP_OIDC_AUDIENCE` | the token's audience when it isn't `SLOP_URL` (must equal the server's `ATF_OIDC_AUDIENCE`) |
| `SLOP_TOKEN` | the board's integration token (deprecated) |
| `SLOP_CLIENT_ID`, `SLOP_CLIENT_SECRET`, `SLOP_TOKEN_URL` | a client-credentials runner's client and its token URL (identity 2) |
| `SLOP_ATF_SCOPE` | the scope to ask the token URL for, when it isn't the one the script needs (`slop/atf.read-specs` for `atf-specs.sh`, `slop/atf.write-results` for `atf-report.sh`) |
| `SLOP_ATF_AUTH` | `oidc`, `client`, `aws` or `token` to force an identity |
| `SLOP_ATF_TRANSPORT` | `http` or `eventbridge` for the results |
| `SLOP_ATF_IDEMPOTENCY_KEY` | the pipeline run id, when the CI isn't CodeBuild or GitHub Actions |

Without `SLOP_ATF_AUTH`: `SLOP_OIDC_TOKEN` first; then `SLOP_CLIENT_ID` with `SLOP_CLIENT_SECRET`; then AWS credentials when `SLOP_TOKEN` isn't set; then `SLOP_TOKEN`.

## OIDC runner (GitHub Actions and other CI systems)

No stored secret. The CI job asks its provider for a short-lived JWT for slop's audience.

1. **Server admin:** list the issuer in `ATF_OIDC_ALLOWED_ISSUERS` (comma-separated exact `https` URLs, e.g. `https://token.actions.githubusercontent.com`) and redeploy. `ATF_OIDC_AUDIENCE` defaults to slop's public URL. OIDC is off while the list is empty.
2. **Board admin:** register a runner with method `oidc`, the `issuer`, the environments it serves and claim rules: `claims: {"repository": ["acme/app"], "ref": ["refs/heads/main"]}`. A rule value is exact, or `prefix*`. Every rule must match. A GitHub runner must pin `repository` or `sub`: any workflow on GitHub can get a token for slop, so the issuer and audience alone prove nothing.
3. **Workflow:** copy `github-actions-atf.yml` (needs `permissions: id-token: write`).

A token that matches two runners on the board is refused.

## AWS IAM runner (CodeBuild, ECS, anything with an IAM role)

No stored secret. The runner's IAM role asks AWS for a JWT through outbound identity federation (`sts:GetWebIdentityToken`); slop matches the role to the runner.

1. **AWS account owner:** enable outbound identity federation for the account (`aws iam enable-outbound-web-identity-federation`) and allow `sts:GetWebIdentityToken` for the runner's role. Note the account's issuer URL (`aws iam get-outbound-web-identity-federation-info`). Command names follow the API names; confirm them against AWS's "Getting started with outbound identity federation".
2. **Server admin:** add the issuer URL to `ATF_AWS_ALLOWED_ISSUERS` and the 12-digit account to `ATF_AWS_ALLOWED_ACCOUNTS`, then redeploy. These are separate from the OIDC list and from `ATF_PUSH_ALLOWED_ROLE_ACCOUNTS`: a role in an account that isn't listed is refused even when a board registers it.
3. **Board admin:** register a runner with method `aws_iam` and `roleArns` (`arn:aws:iam::123456789012:role/atf-codebuild`, or `prefix*`). A session of the role (`assumed-role/atf-codebuild/...`) matches the role.
4. **Runner:** use `buildspec-atf.yml` with `SLOP_URL` and `SLOP_BOARD` and no `SLOP_TOKEN`. The scripts need an AWS CLI (or boto3) that has `sts get-web-identity-token`; see the buildspec comments.

## Client credentials runner (OAuth, for systems with no CI identity)

For a runner that can keep a secret but has no OIDC or IAM identity. slop creates an OAuth client for it in its Cognito user pool, limited to the two ATF scopes; the runner exchanges the client for a short-lived access token (one hour).

1. **Board admin:** register a runner with method `client_credentials` (Board Settings, or `POST /api/boards/:b/atf-runners`) and the environments it serves. Do not send a `clientId`: slop makes the client. The server can do this only when Settings, System shows `ATF client credentials` as ready (it has the Cognito permission and the auth stack's `slop/atf.*` scopes); otherwise registering fails and nothing is saved. Cognito charges for machine-to-machine tokens, so ask who pays before turning this on for many runners.
2. **Read the answer once.** The answer to the create call (the notice in Settings, or `credentials` in the API response) has four values: `clientId`, `clientSecret`, `tokenUrl` and `scope` (`slop/atf.read-specs slop/atf.write-results`). slop never stores the secret and cannot show it again; if it is lost, revoke the runner and register another.
3. **Runner:** keep the secret in the CI system's secret store and set `SLOP_CLIENT_ID` (`clientId`), `SLOP_CLIENT_SECRET` (`clientSecret`) and `SLOP_TOKEN_URL` (`tokenUrl`) next to `SLOP_URL` and `SLOP_BOARD`. Each script asks `SLOP_TOKEN_URL` for a token with only the scope it needs (`atf-specs.sh`: `slop/atf.read-specs`; `atf-report.sh`: `slop/atf.write-results`; `SLOP_ATF_SCOPE` overrides), once per run. The secret is passed to curl in a mode-600 file, never on the command line, and is never printed. A failed token request is a warning and the pipeline carries on.

Without the scripts: `POST <tokenUrl>` with HTTP Basic auth `clientId:clientSecret` and a form body `grant_type=client_credentials&scope=<scope>`, then send `Authorization: Bearer <access_token>`. A user's token, or one without the scope the door needs, is refused. Revoking the runner deletes its client; the other runners are unaffected.

## Deploy-live webhook (push, for runners that can't pull)

Pull is the default: the runner's pipeline asks `atf-specs`. A runner whose system can only be called can have slop call it once a deploy is live and checked. The webhook is an extra setting of any runner, whatever its identity method. It has no screen yet: set it through the API.

1. **Board admin:** `POST /api/boards/:b/atf-runners`, or `PATCH /api/boards/:b/atf-runners/:id`, with `config: {..., "webhook": {"url": "https://ci.example.com/hooks/slop"}}`. `PATCH`'s `config.webhook` is the whole setting: leave it out to turn delivery off.
2. **URL rules:** `https`, no user name or password, a public host name (not `localhost`, a single label or an internal-looking suffix), and every address it resolves to must be public (private, loopback, link-local and other reserved ranges are refused). slop resolves the host when you set the webhook and again at every delivery, and connects to the address it resolved (the host name is the TLS name and the `Host` header). Redirects are not followed. The server must have `SIGNING_SECRET` set, or webhooks can't be turned on.
3. **Read the signing secret once.** The answer that turns the webhook on has `webhookSecret` (`whsec_...`), with `Cache-Control: no-store`. slop keeps it sealed and shows it nowhere else. Moving the URL keeps it; turning the webhook off and on again makes a new one. Don't send a secret of your own: it is refused.

**What slop sends.** One `POST` per runner and deploy, once the deploy is live and slop has checked what it contains, for each enabled runner that serves the environment. The body is JSON:

```json
{"event": "deploy.live", "id": "atf-<runner>-<deploy>", "board": {"id": 4, "name": "..."}, "environment": "staging", "sha": "<commit>", "deployId": 123, "deployedAt": "<ISO time>"}
```

| Header | Meaning |
| --- | --- |
| `Slop-Event` | `deploy.live` |
| `Slop-Delivery` | `atf-<runner>-<deploy>`: the same on every retry of one delivery |
| `Slop-Timestamp` | when slop signed it, Unix seconds |
| `Slop-Signature` | `sha256=<hex>`: HMAC-SHA256, keyed with the `whsec_` secret, of the text `<timestamp>.<raw body>` |

**Verify before acting.** Compute the HMAC over the `Slop-Timestamp` value, a dot and the raw request body (the bytes, before any JSON parsing), keyed with the secret; compare with `Slop-Signature` in constant time (`hmac.compare_digest`, `crypto.timingSafeEqual`); reject a timestamp more than five minutes from your clock (a replay window; retries are re-signed, so a late retry has a fresh timestamp); and ignore a `Slop-Delivery` you already handled. Then run the pipeline for `environment` at `sha` (steps 3 and 4 of the contract), and answer quickly: slop waits 10 seconds and doesn't keep your answer's body.

**Retries and drops.** Any `2xx` ends the delivery. A network failure, a timeout, `408`, `429` or `5xx` is retried with growing delays (5 seconds doubling, eight attempts in all) under the same `Slop-Delivery`. Any other answer (a redirect or another `4xx`) is taken as the receiver's refusal and the delivery is dropped and not repeated; so is one whose runner was disabled, revoked or no longer serves the environment, whose webhook was removed, whose deploy was replaced by a newer one, or whose host now resolves to a private address. A dropped or failed delivery is never queued again for the same deploy. Webhook failures never block a deploy or a merge.

## Board token (deprecated for ATF)

The board's integration token still works for `atf-specs` and `atf-results`. slop records those runs as the "Legacy runner" and answers with `Deprecation: true` and a link to this file. Move each runner to its own identity above, then remove `SLOP_TOKEN` from it. The token stays for Meet-notes ingest; revoking it is not how to retire an ATF runner.

## EventBridge (AWS only)

`SLOP_ATF_TRANSPORT=eventbridge` makes `atf-report.sh` put a `slop.ci` "Slop ATF Completed" event on the default bus, as before. Use it where the project has no HTTPS route to slop.

# Other catalog scripts

Generic, board-agnostic scripts a board can run or copy. Each follows `step-template.sh`: a header with what it changes and the permissions it needs, a preflight, a read-only summary, a y/N question (`--yes` skips it), `--dry-run`, safe to re-run, and a final check.

## identity-center-permission-set.sh

Creates or updates an IAM Identity Center permission set from an inline policy file, attaches managed policies, assigns it to a group or user in one account, provisions it, and checks the policy with a simulation table (`iam simulate-custom-policy`, once against the file before any change and once against the stored policy after). Run `--help` for every option.

```
# validate only: size limit (10,240 non-whitespace characters), Access Analyzer errors, simulation table
catalog/scripts/identity-center-permission-set.sh --check --policy policy.json --expectations expectations.txt

# apply (works from the management account or the delegated administrator)
catalog/scripts/identity-center-permission-set.sh --policy policy.json --expectations expectations.txt \
  --name MyNonProd --description "Least-privilege non-prod" --account 111111111111 --group Engineers
```

Expectations file, one row per line (`#` starts a comment); `xdeny` must match an explicit Deny, so a backstop is proven and not just the absence of an Allow:

```
allow logs:FilterLogEvents arn:aws:logs:us-east-1:111111111111:log-group:/aws/lambda/app-dev:*
deny  logs:PutLogEvents    arn:aws:logs:us-east-1:111111111111:log-group:/aws/lambda/app-dev:*
xdeny logs:FilterLogEvents arn:aws:logs:us-east-1:111111111111:log-group:/aws/lambda/app-prod:*
```

Use each action's real resource type: `logs:GetLogEvents` is authorised on the log group, not the log stream, and actions with no resource scoping (such as `cognito-identity:GetCredentialsForIdentity`) simulate as an implicit deny against a resource ARN. Resource patterns in the policy must be ARNs (`arn:aws:*:*:*:*Prod*`), not bare (`*Prod*`), or Access Analyzer rejects them.
