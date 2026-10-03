# Sessionator — Overview & Slop Integration

Oct 3, 2026 · @John

## Overview

Sessionator (`sstor`) is a single Bash script that gives each piece of work its own git worktree and tmux session, then launches Claude Code in it. Today it also carries an agent system (orchestrator, investigator, implementer, qa, change\_reviewer) that it copies into each worktree, and the orchestrator pulls work from Jira.

With slop, sstor is used exclusively with slop and becomes a thinner workspace tool:

- **Kept:** worktrees under `~/dev/<project>__worktrees/`, one tmux session per instance with the claude, console, editor and server windows, server port allocation, and the session management commands.
- **Changed:** instances are named after glob IDs and check out the branch slop created; `sstor init <board>` replaces copying `.claude/` from the sessionator repo; merging goes through PRs instead of local merges into master.
- **Moved to slop:** the agent definitions, the `/run-task` command, reference docs and learnings. Jira is removed entirely; slop is the board.

Sessionator stays one replaceable implementation tool. This document is authoritative for sstor's local command behaviour; the slop spec is authoritative for lifecycle, contracts and rules. Wherever this document says master, it means the board's base branch (e.g. master or main), read from the board's settings. Routines run the same board agent set in the cloud from the copy committed in the repo; their orchestrator refreshes it from slop at the start of each run.

## Commands

The tmux and worktree machinery is preserved as-is; only naming, the agent setup and the merge commands change.

| Command | Today | With slop |
| --- | --- | --- |
| `sstor init <board>` | — | **New.** Fetches the board's agent set from slop (headless Claude, `get_agent_set`) and merges it into the current checkout (see sstor init). Runs without tmux |
| `sstor --glob <id>` | `--task` / `--bug <jira>` | **Replaces both.** Before creating anything, a headless Claude call (`get_glob`, as used by `--new` and `--teleport`) checks the glob; sstor refuses, without creating a worktree or session, while a routine run is active or watching (add --take-over, which calls pick\_up with takeOver, to supersede it); re-running it for a glob you already own just reopens the session. Fetches the glob's branch from origin, creates the worktree on it, runs `sstor init`, and launches `claude '/run-glob <id>'` |
| `sstor --new [--same\|--sub\|--super] [--feature\|--task\|--bug] [--routine] "<prompt>"` | `--prompt "<text>"` | **Replaces it.** Optional category flags --feature, --task or --bug (inferred by slop's intake from the prompt if omitted; invalid combinations such as --sub --feature or --super --bug are rejected by slop and reported). Creates a glob (same by default) by running Claude headlessly (`claude -p`) with only slop's `create_glob` tool allowed, which returns `{ id, branch }`. Same: opens a worktree and session on the branch, or with `--routine` lets a routine implement it. Sub: no worktree; a routine implements it and sstor prints the ID. Super: opens a session in super mode |
| `sstor --review <id\|sha>` | `--review <jira\|sha>` | Kept, keyed by glob ID or commit SHA |
| `sstor --ready` | — | **New.** Pushes the branch and marks the PR ready for review (`gh pr ready`), which triggers ATF and the remote review |
| `sstor --merge` | Local `git merge --no-ff` into master | **Changed.** Squash-merges the PR through GitHub (`gh pr merge --squash`; the title is already `<id>: <title>`). Direct merges into master are no longer allowed |
| `sstor --derge` | Local merge, then delete | **Changed.** `--merge`, then the existing cleanup: kill the session, remove the worktree, delete the local branch |
| `sstor --done` | — | **New.** Cleanup only, for a glob merged elsewhere (on the board or in GitHub) |
| `sstor --routine-setup` | — | **New.** Walks a developer through creating their routine in claude.ai and stores its fire URL and token in Secrets Manager at `slop/routines/<userId>` |
| `--kill`, `--end`, `--delete`, `--list`, `--server`, `--reload` |  | Unchanged |
| `--sync` | Re-copies `.claude/` from the sessionator repo | Becomes an alias for `sstor init` on an existing instance |
| `--deploy` | Runs `.sstor/deploy.sh` | Kept as a manual escape hatch; normal deploys are started by slop when a glob branch with an environment is pushed |

**`sstor --teleport <id>`** (new) continues a routine run locally. It gets the run's cloud session ID through the same headless Claude call used by `--new` (`get_glob`), creates the worktree on the glob's branch, runs `sstor init`, calls `pick_up` with `takeOver` (continuing locally makes the glob yours, and the cloud run stops at its next check), then launches `claude --teleport <session-id>` in the tmux session so the run's full conversation carries on. Its first message is an explicit handoff instruction: the local session is now the human implementer's interactive session, it stops using the superseded run ID and ignores the unattended rule to stop when superseded or picked up, and it may ask clarifying questions. This handoff is part of the teleport integration test. Only the routine owner can teleport; for anyone else sstor stops and points to the glob's view-only *Open in Claude* link. The glob card shows the same command under *Continue locally*.

**Naming:** the instance is the glob ID, so the worktree is `~/dev/<project>__worktrees/<project>-s1t4` and the tmux session `<project>-s1t4`. The branch is the glob ID itself (`s1t4`), created by slop and tracked from origin, instead of a local `<project>-<instance>` branch created with `-b`.

## sstor init

`sstor init <board>` keeps today's `merge_claude_config` logic but changes its source: instead of copying `$SSTOR_DIR/.claude/`, it fetches the board's agent set from slop through a headless Claude call to `get_agent_set` (the same mechanism as `--new`), so it uses the developer's OAuth login. On a first install it first writes the slop server entry into `.mcp.json` from sstor's own configuration (slop's URL and the Claude Code client ID), so the call can authenticate. The board ID comes from an argument, an environment variable, or `.sstor/sstor.conf` (`SLOP_BOARD`, replacing `JIRA_CLOUD_ID` and `JIRA_PROJECT_KEY`).

| Step today | With slop |
| --- | --- |
| rsync agents, commands and memory from the sessionator repo | Write the board's agents, commands and hooks into `.claude/` |
| Merge `settings.json` (env, MCP servers, permissions, sandbox) | Same merge (env, permissions, sandbox, hooks), from the agent set's settings, removing the Atlassian MCP entry, its permissions and `TASK_APP_URL`. MCP servers are no longer merged here, because Claude Code ignores `mcpServers` in `settings.json` |
| — | Merge the `slop` server (URL and OAuth client ID) into `.mcp.json` |
| Replace the marked section in `CLAUDE.md` | Same, using the agent set's CLAUDE.md section between the existing markers |
| Merge `settings.local.json` (secrets, sandbox domains) | Unchanged and still local-only: personal secrets never come from slop |
| Update `.gitignore` | Also ignore `.reviews/` |
| — | Record the agent-set version in `.claude/slop-agent-set.json`; if slop is unreachable, keep the committed copy and warn |

The merge scripts already use only Bash, rsync and Python, so `sstor init` runs the same way in any checkout. Board knowledge other than the agent set is not written to disk; agents fetch it through the MCP at run time.

**When it runs:** on every sstor command that launches or relaunches Claude (`--glob`, `--new`, `--sync`, and attaching to a session whose Claude has exited), always before the launch, so new agents and commands register. `--ready` and `--derge` do not restart Claude. Routines don't run it: they use the committed copy, and their orchestrator writes and commits a newer version from `get_agent_set` when there is one.

**Committed agent set:** files written during a session's start only register in the next session, so the agent set is committed in the project repo. Cloud checkouts register it at startup; `sstor init` overwrites it with the current version, and changes show up as small diffs in whichever glob commit picks them up. The project's `.gitignore` tracks `.claude/agents/`, `.claude/commands/`, `.claude/hooks/` and `.claude/settings.json`, and ignores `.claude/settings.local.json` and `.reviews/`.

**Safe refresh:** a manifest lists every file sstor manages; only those are replaced or removed, so obsolete managed files are deleted and local files are never touched. The new agent set is written to a temporary folder and swapped in only when complete. On a first run with no committed copy, `sstor init` fails loudly instead of continuing without agents. The first run on an existing checkout also removes the legacy files listed in slop's `catalog/agents/README.md`.

## Moving the agent system to slop

The five agents and the `/run-task` command leave the sessionator repo and become the first agent set managed in slop, delivered by `sstor init`. The sessionator repo shrinks to the `sstor` script and tmux/editor configuration.

**What stays the same:** the orchestrator-plus-sub-agents structure, the six phases, the `.reviews/` working files, the three-round review cycle, browser verification through Chrome DevTools MCP and `.sstor/.url` and the sandbox rule. The optional OpenAI cross-review is dropped for now, as are the Codex agent mirrors (`.codex/`, `AGENTS.md`). The `qa` agent is renamed `tester`. The migrated agents become the shared agent set in slop's repo under `catalog/agents/`, the same for every board; board-specific instructions for an agent live in the board's KB.

**Orchestrator changes, by phase**

| Phase | Today | With slop |
| --- | --- | --- |
| Start | Read Jira keys from `sstor.conf` | Read the board from `sstor.conf`; in interactive sessions call `pick_up` (routines do not, so no human implementer is recorded) |
| 1 Context | Fetch the Jira issue, its epic and sibling tasks | `get_context` returns plan.md, decisions, linked meetings and related globs; the group replaces the epic and `list_globs` by group replaces sibling tasks |
| 1 Clarifications | Ask with `AskUserQuestion` | Same interactively; the Q&A is attached to the glob with `attach`. In unattended mode (routines), questions are skipped and assumptions recorded instead |
| 2 Investigation | Proposals in `.reviews/…-plan.md`; the user picks one | Same, then the chosen proposal is pushed as the `implementation_plan` artifact, with an amendments section added as work changes it. Unattended mode takes the recommended proposal |
| 3–4 Implementation and tests | Unchanged | Unchanged |
| 5 Review | Review document in `.reviews/` | Same |
| 6 Finalise | Commit with the Jira key, do not push, transition Jira, attach the review to Jira | Commit as `<id>: <title>` with bullet points, push the review and test report together as the `local_review` artifact with the commit SHA (shown under the card's local review icon), and push the glob branch (never master), then mark the glob's draft PR ready for review: routines do this themselves, interactive sessions with `sstor --ready`. No Jira steps; slop learns everything else from GitHub events |
| 6 Learnings | Append to `.sstor/docs/learnings.md` | Submit each learning with `submit_learning`, so it becomes a KB proposal in slop |
| Blockers | Stop and explain | Also call `report_failure` so the glob shows as failed |

**Changes to the other agents**

- **Inputs:** "Task description and acceptance criteria" become plan.md and its "Done when" lines; bugs use plan.md's bug fields (steps, expected, actual). "Technical notes" and "sibling tasks" come from the context bundle.
- **Reference docs and learnings:** no longer on disk. The orchestrator fetches the board's documents and approved learnings with `get_conventions`, saves them under `.reviews/<id>-docs/` and passes the paths to sub-agents; each document's audience says which agents always get it.
- **Project rules move out of the agents:** language rules (quoting, formatting, typing) and package-manager commands are project conventions. They move into each board's knowledge base in slop, so the agents themselves stay generic across boards and languages.
- **Review output** keeps its IN-SCOPE / SUGGESTION classification; slop stores it verbatim.

**Learnings:** the orchestrator's existing learning extraction stays, but its output goes to slop instead of `.sstor/docs/learnings.md`. It runs at the end of phase 6 for sames and subs (interactive or in routines) and at `sstor --ready` and `--derge` for supers. Each learning is one `submit_learning` call with a type (decision, gotcha, pattern, agent-behaviour), a short statement, evidence (glob, files, the review findings or test failures behind it) and an optional suggested target. Agents only propose; slop deduplicates, drafts the change and queues it for human approval (see the main spec's self-improvement pipeline).

**Modes:** `/run-glob <id>` covers tasks and bugs (category comes from the glob), `--review` stays, and a new `super` mode runs without the phase pipeline: the developer drives, sub-agents are called on demand (investigator for spikes, change\_reviewer before `sstor --ready`), and postplan updates run on each push. The same agents run unattended in routines for subs and sames.

**How the orchestrator chooses what to run:** sstor passes only the glob ID. The orchestrator reads the glob first: its category (feature, task or bug) sets the flavour of the phases (bugs reproduce, find the root cause and add a regression test; features and tasks work from plan.md's acceptance criteria), and its slop type sets the mode (the full phase pipeline for subs and sames, unattended in routines; super mode for supers). `sstor init` always installs the full agent set rather than a subset per category, so a category changed in the glob view never requires a re-init.

## Workflows

**Picking up an existing glob:** `sstor --glob s1t4` fetches `s1t4` from origin (possibly already worked on by a routine), creates the worktree and tmux session, runs `sstor init`, copies certs as today, starts the server window if configured, and launches `claude '/run-glob s1t4'`. The orchestrator calls `pick_up` and `get_context` and runs the phases. Pick-up is refused while a routine run is active or watching (use --take-over to supersede it). Take-over is cooperative: the routine stops at its next check, but a push already in flight can still land. Such pushes carry a Slop-Run trailer and are flagged on the glob, so the developer can revert them.

**Starting new work:** `sstor --new "<prompt>"` creates a same (or `--sub` / `--super`) through a headless Claude call to `create_glob`, then opens the worktree directly on the returned branch. Subs and `--routine` sames open nothing locally; a routine implements them. Work can also start from the board or the Claude app, then `sstor --glob <id>`.

**Super (pairing with the PO):**

1. `sstor --new --super "<prompt>"` (or `--glob` for a super created elsewhere); the glob appears in Doing with the developer as implementer.
2. The developer works with Claude in super mode, pushing regularly to the glob's branch. Slop starts a CodeBuild deploy to the glob's environment (a branch-deploy environment) on each push.
3. Each push also updates the postplan from the session conversation and the diff (`put_artifact`, kind `postplan`).
4. When ready: the change\_reviewer runs locally, the review is pushed as `local_review`, and `sstor --ready` marks the PR ready, triggering ATF and the remote review.
5. When the meeting's Gemini notes arrive in slop, they are merged into the postplan.
6. `sstor --derge` squash-merges the PR and cleans up; the next super always starts from master.

**Review only:** `sstor --review s1t4` (or a commit SHA) runs the standalone review as today and, when keyed by a glob, pushes the result as `local_review`.

**After merge elsewhere:** `sstor --done` removes the session, worktree and local branch once the glob was merged on the board or in GitHub.

## Setup and suggestions

- **One-time per developer:** clone sessionator and put `sstor` on the PATH as today; authenticate Claude Code to slop's MCP once (browser login to Identity Center, 10-year refresh token); authenticate the `gh` CLI for `--ready` and `--merge`; run `sstor --routine-setup`.
- **sstor stays dumb about slop's API.** Anything that needs slop's private MCP (creating, picking up, artifacts, learnings) is done by Claude inside the session, which already holds the OAuth login. sstor itself only talks to slop through headless Claude calls (`create_glob`, `get_glob`, `pick_up`, `get_agent_set`), plus git and `gh`, so it needs no slop credential of its own.
- **Draft PRs exist from the start.** Slop's GitHub App creates each glob's branch with an empty first commit (`<id>: start`), because GitHub cannot open a PR on a branch identical to master, and opens the draft PR with labels; the squash merge removes the empty commit. sstor never opens PRs, it only marks them ready and merges them.
- **Postplan and learnings guarantee:** updating the postplan on each push is best effort: a Claude Code hook follows `git push` with a reminder to update it, which does not cover pushes from the terminal or editor. The guarantee lives in `sstor --ready` and `sstor --derge`, which always finalise before continuing, by one of two paths so they can never deadlock. Invoked from outside Claude (a terminal or tmux pane): sstor generates a fresh request ID, sends the running session /finalise \<requestId> via tmux, and waits for the completion marker. Invoked by Claude itself: Claude runs /finalise first, then calls sstor with --finalised \<requestId>, and sstor does not send anything back to the session. /finalise updates the postplan, pushes the local review and submits learnings through the MCP, then writes .sstor/.finalised containing the request ID and the commit SHA only after every call succeeds. sstor proceeds only if both match the current request and the current head commit, so a marker from an earlier invocation never counts; on mismatch, failure or timeout it stops and reports, and does not mark the PR ready or merge.
- **Unattended mode:** the orchestrator has a flag for routines that skips `AskUserQuestion`, picks the recommended proposal, and records assumptions on the glob, since there is no user to answer. Routines check the glob through the MCP before every push and stop if their run was superseded, a human implementer is recorded, or the glob is merged.

## Open questions

- [ ] **Headless creation:** confirm `claude -p` with only slop's `create_glob` tool allowed returns the glob ID and branch reliably and quickly enough for interactive use.
- [x] **Board docs to move:** a project's existing `.sstor/docs/` is imported into its board's knowledge base (none of it is public). Each doc carries frontmatter with its area and audience for the import. Afterwards the committed `.sstor/docs/` is removed from that repo.
