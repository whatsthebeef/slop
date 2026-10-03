# Agent set

The catalog's generic agent set. A new board imports (forks) it into its knowledge base as `agent` items; from then on the board's copy changes through approved proposals, and changes made here reach each board as a proposal with the diff. Everything here is generic and non-sensitive: the agents describe how to fetch board knowledge through slop's authenticated MCP, never the knowledge itself.

At run time the agents fetch the rest through slop's MCP tools, which require the person's or routine's OAuth login: the board's settings (`get_board`), its knowledge (`get_conventions`), each glob's context (`get_context`) and search. Project knowledge (build commands, conventions, review checklists, architecture docs) never lives in this repo.

Agent definitions hold short rules that always apply to that agent; bulky or situational knowledge goes in KB documents, passed to agents by their audience. Improvements that would help any project are made here as PRs.

## Layout

| Path | Written into a checkout (and committed) by `sstor init`, from the board's copy, as |
| --- | --- |
| `agents/*.md` | `.claude/agents/` |
| `commands/*.md` (`/run-glob`, `/finalise`) | `.claude/commands/` |
| `hooks/*` | `.claude/hooks/` |
| `settings.json` | merged into `.claude/settings.json` |
| `mcp.json` (`{{SLOP_URL}}` and the Claude Code client ID filled from sstor's config) | merged into `.mcp.json` |
| `claude_md.md` | `CLAUDE.md`, between the `<!-- implementation-agent-system -->` markers |

## Changes from sessionator's agent system

- Jira is gone. Phase 1 reads the glob through `get_glob` and `get_context`; the group and `list_globs` replace the epic and its sibling tasks.
- `/run-task --task|--bug|--prompt` is replaced by `/run-glob <id>`. Category and slop type come from the glob; prompt mode is replaced by `sstor --new`, which creates a glob first.
- Reference docs no longer sit in `.sstor/docs/`. The orchestrator fetches the board's knowledge from slop in Phase 1, saves it under `.reviews/<id>-docs/` and passes the paths to sub-agents. Each knowledge document carries an audience (the agents that must always get it), which replaces the hard-coded "always pass X to Y" rules.
- Unattended mode for routines (`--run <runId>`): no questions, recommended proposal, assumptions recorded on the glob, run ID on every artifact and commit trailer, glob check before every push.
- Super mode and `/finalise` are new.
- `.sstor/docs/learnings.md` is replaced by `get_conventions` (read) and `submit_learning` (write).
- Phase 2 pushes the chosen proposal as the `implementation_plan` artifact, with an Amendments section kept up to date.
- The local review is pushed in Phase 6, after the commit, so it carries the commit SHA.
- Phase 6 commits as `<id>: <title>`, pushes the glob branch and marks the PR ready (routines) or hands over to `sstor --ready` (interactive).
- `qa` is renamed `tester`. The OpenAI cross-review, the Codex mirrors (`.codex/`, `AGENTS.md`) and the Google Sheet memory are dropped.
- Project rules (quotes, template formatting, typing, package manager commands) left the agents; each board's knowledge base holds them.
- The agent set is board knowledge in slop, fetched by `sstor init` through headless Claude (`get_agent_set`) and committed in each project repo, so cloud checkouts register it at startup. Routines refresh it at the start of each run; changes show up as small diffs in whichever glob's commit picks them up.
- Every artifact, failure and learning records the agent-set version (`.claude/slop-agent-set.json`), so slop can check whether a change to the agents helped.
- The slop MCP server is declared in `.mcp.json`. Claude Code ignores `mcpServers` in `.claude/settings.json`, where sessionator used to merge them.

## First `sstor init` on an existing checkout

The manifest only covers files sstor manages, so the first run also removes what the old agent system installed: `qa.md`, `unit_test_writer.md`, `.claude/agents/docs/`, `run-task.md` (in `commands/` and `skills/`), `.claude/memory/workflow_config.md`, `deploy.sh` copies under `.claude/`, the `atlassian-rovo` MCP entry and `mcp__atlassian*` permissions.
