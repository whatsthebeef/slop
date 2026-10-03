#!/usr/bin/env bash
# PostToolUse hook (Bash): after a git push, remind Claude to update the postplan.
# Best effort only; sstor --ready and --derge guarantee it through /finalise.
input=$(cat)
command=$(printf '%s' "$input" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("tool_input", {}).get("command", ""))' 2>/dev/null)

case "$command" in
  *"git push"*) ;;
  *) exit 0 ;;
esac

cat <<'EOF'
{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"You just pushed. If this glob is a super, update .reviews/<id>-postplan.md and send it with put_artifact (kind: postplan, commitSha: the pushed HEAD)."}}
EOF
