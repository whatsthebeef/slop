# Production sign-in: Cognito federated to IAM Identity Center

Production (`slop-prod-auth`, same account and region as dev) has its own Cognito pool. Identity Center says who
someone is; roles live in slop. Removing someone from Identity Center blocks their new logins.

## 1. Deploy the stack (before Identity Center)

```
cd infra
pnpm cdk deploy slop-prod-auth -c stage=prod -c publicUrl=https://<id>.cloudfront.net
```

`publicUrl` is the host stack's `PublicUrl`. Callbacks and logout URLs are that address only (no localhost), plus
Claude Code's (`:7779`) and the CLI's (`:7780`) loopback callbacks and the claude.ai / claude.com connector callbacks.
Until step 2 the Hosted UI offers native Cognito users.

## 2. Identity Center SAML application (console, by the owner)

1. IAM Identity Center > Applications > Add application > custom SAML 2.0 application.
2. Copy the **IAM Identity Center SAML metadata file URL**.
3. Application ACS URL: the stack output `IdentityCenterAcsUrl`. Application SAML audience: `IdentityCenterAudience`.
4. Attribute mappings: `Subject` = `${user:email}` (format emailAddress); `email` = `${user:email}` (format unspecified).
5. Assign the people (or groups) who may sign in.
6. Redeploy with the metadata URL; the Hosted UI then shows Identity Center only:

```
pnpm cdk deploy slop-prod-auth -c stage=prod -c publicUrl=https://<id>.cloudfront.net -c identityCenterMetadataUrl=<url>
```

## 3. Hand the server its settings

`scripts/set-cognito-secrets.sh` stores the board client secret in `slop/prod/cognito-board-client-secret` and prints
`COGNITO_USER_POOL_ID`, `COGNITO_REGION`, `COGNITO_DOMAIN`, `COGNITO_CLIENT_IDS` and `COGNITO_BOARD_CLIENT_ID` for the
SSM parameter `/slop/prod/server-env`. Redeploy/restart the server. No secret goes in a file.

## 4. Check

- Board: sign in at the production address through Identity Center.
- claude.ai connector: add `<publicUrl>/mcp` with the `ClaudeConnectorClientId` and its secret (read it with
  `aws cognito-idp describe-user-pool-client`); call `whoami`.
- Claude Code: `claude mcp add --transport http slop <publicUrl>/mcp --client-id <ClaudeCodeClientId> --callback-port 7779`, then `whoami`.
- Token lifetimes are as dev (access/id 1 hour, refresh 10 years).
