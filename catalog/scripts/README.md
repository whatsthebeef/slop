# ATF runners

An ATF runner is any system that runs a board's acceptance tests and tells slop how they went. slop only observes: it never blocks a PR, approval, sign-off or deploy on ATF. Each board registers its runners (Board Settings, or `POST /api/boards/:b/atf-runners` as a board admin), and each runner has its own identity.

## The contract

1. **Trigger.** The runner's own pipeline runs after a deploy (or a branch deploy).
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
| `SLOP_ATF_AUTH` | `oidc`, `aws` or `token` to force an identity |
| `SLOP_ATF_TRANSPORT` | `http` or `eventbridge` for the results |
| `SLOP_ATF_IDEMPOTENCY_KEY` | the pipeline run id, when the CI isn't CodeBuild or GitHub Actions |

Without `SLOP_ATF_AUTH`: `SLOP_OIDC_TOKEN` first; then AWS credentials when `SLOP_TOKEN` isn't set; then `SLOP_TOKEN`.

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

## Board token (deprecated for ATF)

The board's integration token still works for `atf-specs` and `atf-results`. slop records those runs as the "Legacy runner" and answers with `Deprecation: true` and a link to this file. Move each runner to its own identity above, then remove `SLOP_TOKEN` from it. The token stays for Meet-notes ingest; revoking it is not how to retire an ATF runner.

## EventBridge (AWS only)

`SLOP_ATF_TRANSPORT=eventbridge` makes `atf-report.sh` put a `slop.ci` "Slop ATF Completed" event on the default bus, as before. Use it where the project has no HTTPS route to slop.
