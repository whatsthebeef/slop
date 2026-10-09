#!/usr/bin/env bash
# Copies production's Cognito board client secret from the slop-prod-auth stack into Secrets Manager
# (slop/prod/cognito-board-client-secret) so it never lands in a file, and prints the server's COGNITO_* settings.
# Usage: AWS_PROFILE=... scripts/set-cognito-secrets.sh   (region us-east-1 unless AWS_REGION is set)
set -euo pipefail
region="${AWS_REGION:-us-east-1}"
stack="${STACK:-slop-prod-auth}"
out() { aws cloudformation describe-stacks --region "$region" --stack-name "$stack" \
  --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text; }
pool="$(out UserPoolId)"; board="$(out BoardClientId)"; domain="$(out Domain)"; ids="$(out ClientIds)"
secret="$(aws cognito-idp describe-user-pool-client --region "$region" --user-pool-id "$pool" --client-id "$board" \
  --query UserPoolClient.ClientSecret --output text)"
aws secretsmanager put-secret-value --region "$region" --secret-id slop/prod/cognito-board-client-secret \
  --secret-string "$secret" >/dev/null
echo "Stored slop/prod/cognito-board-client-secret. Put these in the SSM parameter /slop/prod/server-env:"
echo "COGNITO_USER_POOL_ID=$pool"
echo "COGNITO_REGION=$region"
echo "COGNITO_DOMAIN=$domain"
echo "COGNITO_CLIENT_IDS=$ids"
echo "COGNITO_BOARD_CLIENT_ID=$board"
