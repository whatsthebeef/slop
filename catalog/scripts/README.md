# Catalog scripts

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
