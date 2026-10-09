#!/bin/bash
# Checks production through CloudFront once it is deployed (T4 of s15f32): health, the public URL slop builds from
# CloudFront's headers, MCP and webhook paths reaching the app, and, with a session cookie, that the SSE stream stays open.
#
#   infra/deploy/verify.sh https://<id>.cloudfront.net [slop_session cookie value [board number, default 15]]
set -uo pipefail
BASE="${1:?usage: verify.sh https://<id>.cloudfront.net [slop_session cookie value]}"
BASE="${BASE%/}"
FAILED=0
check() { if "$@"; then echo "ok    $DESC"; else echo "FAIL  $DESC"; FAILED=1; fi; }

DESC="/auth/config answers 200 (the app is up behind CloudFront)"
check curl -fsS -o /dev/null "$BASE/auth/config"

DESC="MCP protected-resource metadata names the https CloudFront address"
check bash -c "curl -fsS '$BASE/.well-known/oauth-protected-resource' | grep -q '\"resource\":\"$BASE/mcp\"'"

DESC="/mcp without a token is 401 from the app, with a WWW-Authenticate pointing at CloudFront"
check bash -c "curl -sS -o /dev/null -D - -X POST '$BASE/mcp' | grep -i '^www-authenticate:.*$BASE/.well-known'"

DESC="a GitHub webhook without a signature is refused by the app (4xx), not by CloudFront or the security group"
CODE="$(curl -sS -o /dev/null -w '%{http_code}' -X POST -H 'content-type: application/json' -d '{}' "$BASE/webhooks/github")"
check bash -c "[ '$CODE' -ge 400 ] && [ '$CODE' -lt 500 ] && [ '$CODE' != 403 ]"

DESC="plain http redirects to https"
check bash -c "curl -sS -o /dev/null -w '%{http_code}' 'http://${BASE#https://}/auth/config' | grep -q 301"

DESC="the hashed board bundle is cacheable (second request is a CloudFront hit)"
ASSET="$(curl -fsS "$BASE/" | grep -o '/assets/[^"]*\.js' | head -1)"
if [ -n "$ASSET" ]; then
  curl -fsS -o /dev/null "$BASE$ASSET"
  check bash -c "curl -fsS -o /dev/null -D - '$BASE$ASSET' | grep -qi '^x-cache: Hit from cloudfront'"
else
  DESC="the board's index page links a bundle"; check false
fi

if [ -n "${2:-}" ]; then
  # The board stream's keep-alive is every 25 s; 70 s open means CloudFront's 60 s origin read timeout isn't cutting it.
  DESC="the board's SSE stream stays open for 70 s and receives a keep-alive"
  OUT="$(curl -sS -N --max-time 70 -H "cookie: slop_session=$2" "$BASE/api/boards/${3:-15}/events" 2>&1 || true)"
  check bash -c "echo '$OUT' | grep -q 'keep-alive'"
else
  echo "skip  SSE (pass a slop_session cookie value as the second argument)"
fi
exit $FAILED
