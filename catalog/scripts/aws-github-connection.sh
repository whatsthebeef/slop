#!/usr/bin/env bash
# Creates (or finds) an AWS CodeConnections connection to GitHub, which a CodeBuild deploy project
# uses to read the repository, and waits until it's usable. AWS creates GitHub connections as
# Pending: the GitHub authorisation can only be finished in the browser, so this prints the link.
# Usage: aws-github-connection.sh <connection-name> [--region <region>]
# Prints the connection ARN on the last line (for the deploy target's deployTargetConnectionArn).
set -euo pipefail

name="${1:-}"; shift || true
region="${AWS_REGION:-${CDK_DEFAULT_REGION:-us-east-1}}"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --region) region="$2"; shift ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
  shift
done
[[ -n "$name" ]] || { echo "Usage: $0 <connection-name> [--region <region>]" >&2; exit 2; }

arn="$(aws codeconnections list-connections --region "$region" --provider-type-filter GitHub \
  --query "Connections[?ConnectionName=='$name'].ConnectionArn | [0]" --output text)"
if [[ -z "$arn" || "$arn" == "None" ]]; then
  arn="$(aws codeconnections create-connection --region "$region" --provider-type GitHub \
    --connection-name "$name" --query ConnectionArn --output text)"
  echo "Created connection $name" >&2
fi

status() {
  aws codeconnections get-connection --region "$region" --connection-arn "$arn" \
    --query Connection.ConnectionStatus --output text
}

if [[ "$(status)" != "AVAILABLE" ]]; then
  cat >&2 <<MSG
Finish the GitHub authorisation in the browser:
  https://${region}.console.aws.amazon.com/codesuite/settings/connections?region=${region}
Select "$name", choose "Update pending connection", and install the AWS Connector for GitHub
on the repository's account with access to the repository. Waiting for it to become available...
MSG
  until [[ "$(status)" == "AVAILABLE" ]]; do sleep 5; done
fi
echo "Connection $name is available" >&2
echo "$arn"
