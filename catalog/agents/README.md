# Agent set

The catalog's generic agent set. Every board serves these files with its own layer on top: board rules appended under `## Board rules` (markdown files), JSON merged into `settings.json`, or files the board adds. Changes made here reach every board when slop restarts, with a new agent-set version; boards change only their own layer, through approved proposals. Everything here is generic and non-sensitive: the agents describe how to fetch board knowledge through slop's authenticated MCP, never the knowledge itself.

At run time the agents fetch the rest through slop's MCP tools, which require the person's or routine's OAuth login: the board's settings (`get_board`), its knowledge (`get_conventions`), each glob's context (`get_context`) and search. Project knowledge (build commands, conventions, review checklists, architecture docs) never lives in this repo.

Agent definitions hold short rules that always apply to that agent; bulky or situational knowledge goes in KB documents, passed to agents by their audience. Improvements that would help any project are made here as PRs.

## Layout

| Path | Written into a checkout (and committed) by `sstor init`, from the board's copy, as |
| --- | --- |
| `agents/*.md` | `.claude/agents/` |
| `commands/*.md` (`/run-glob`, `/finalise`, `/kb-bootstrap`) | `.claude/commands/` |
| `hooks/*` | `.claude/hooks/` |
| `settings.json` | merged into `.claude/settings.json` (list values such as permissions and `sandbox.network.allowedDomains` are combined; the sandbox domains are the ones the agents' own commands need, `github.com` for `git fetch` and `git push`) |
| `mcp.json` (`{{SLOP_URL}}` and the Claude Code client ID filled from sstor's config) | merged into `.mcp.json` |
| `claude_md.md` | `CLAUDE.md`, between the `<!-- implementation-agent-system -->` markers |

## Changes from sessionator's agent system

- Jira is gone. Phase 1 reads the glob through `get_glob` and `get_context`; the group and `list_globs` replace the epic and its sibling tasks.
- `/run-task --task|--bug|--prompt` is replaced by `/run-glob <id>`. Category and slop type come from the glob; prompt mode is replaced by `sstor --new`, which creates a glob first.
- Reference docs no longer sit in `.sstor/docs/`. The orchestrator fetches the board's knowledge from slop in Phase 1, saves it under `.reviews/<id>-docs/` and passes the paths to sub-agents. Each knowledge document carries an audience (the agents that must always get it), which replaces the hard-coded "always pass X to Y" rules.
- Unattended mode for routines (`--run <runId>`): no questions, recommended proposal, assumptions recorded on the glob, run ID on every artifact and commit trailer, glob check before every push.
- Super mode, `/finalise` and `/kb-bootstrap` (drafts the documents a board is missing from the code and submits them as proposals) are new.
- `.sstor/docs/learnings.md` is replaced by `get_conventions` (read) and `submit_learning` (write).
- Every glob keeps one implementation record (Approach, Decisions, Deviations, What was built, Traps, Open items), stored as the `implementation_plan` artifact. Phase 2 starts it from the chosen proposal, Phases 3–5 update it, Phase 6 completes and pushes it, and supers keep it up to date after each push. It replaces the separate postplan and decision log; the investigator's alternatives stay in the local plan file.
- The local review is pushed in Phase 6, after the commit, so it carries the commit SHA.
- Phase 6 commits as `<id>: <title>`, pushes the glob branch and marks the PR ready with slop's `mark_ready` (routines, and interactive sessions once the developer agrees). Agents never run `sstor`; the developer runs `sstor --ready` from a terminal.
- `qa` is renamed `tester`. The OpenAI cross-review, the Codex mirrors (`.codex/`, `AGENTS.md`) and the Google Sheet memory are dropped.
- Project rules (quotes, template formatting, typing, package manager commands) left the agents; each board's knowledge base holds them.
- The agent set is board knowledge in slop, fetched by `sstor init` (`get_agent_set`, with sstor's own slop sign-in) and committed in each project repo, so cloud checkouts register it at startup. Routines refresh it at the start of each run; changes show up as small diffs in whichever glob's commit picks them up.
- Every artifact, failure and learning records the agent-set version (`.claude/slop-agent-set.json`), so slop can check whether a change to the agents helped.
- The slop MCP server is declared in `.mcp.json`. Claude Code ignores `mcpServers` in `.claude/settings.json`, where sessionator used to merge them.

## First `sstor init` on an existing checkout

The manifest only covers files sstor manages, so the first run also removes what the old agent system installed: `qa.md`, `unit_test_writer.md`, `.claude/agents/docs/`, `run-task.md` (in `commands/` and `skills/`), `.claude/memory/workflow_config.md`, `deploy.sh` copies under `.claude/`, the `atlassian-rovo` MCP entry and `mcp__atlassian*` permissions.
