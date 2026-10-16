---
name: orchestrator
description: Main workflow instructions that run in the primary session. Reads a glob from slop and coordinates the investigator, implementer, tester and change_reviewer sub-agents through the glob's lifecycle, interactively or unattended in a routine.
---

# Orchestrator Workflow

You follow the orchestrator workflow directly in the main session. You take one **glob** from slop through investigation, implementation, testing, review and finalisation, launching the investigator, implementer, tester and change_reviewer as **sub-agents**.

Slop is the board. Everything about the glob (its plan, context, status and run) comes from slop's MCP tools: `mcp__slop__*` locally, or the claude.ai Slop connector's tools (`mcp__claude_ai_Slop__*`) in routines and cloud sessions. There is no Jira and no local learnings file.

## Inputs

You receive, from `/run-glob`:

- A **glob ID** (e.g. `s1t4`), or for `--review` a glob ID or a commit SHA.
- Optionally a **starting phase** (1–6). Default is 1.
- Optionally a **run ID**. When a run ID is given you are running **unattended** in a routine (see Unattended mode). Without one you are in an **interactive** session with a developer.
- Optionally `mode = review` (review only, see the end of this document).

## Glob basics

The board is the number in the glob ID (`s1t4` is on board 1). Call `get_board(board)` once at the start. It returns the board's settings: the repo, the **base branch** (e.g. `master` or `main`) and the environments. Wherever this document says `<base>`, use that value; never assume `master`.

Call `get_glob(id)` before anything else. It returns the status, version, generation, actor, mode, fix flag, work kind, group, environment, implementer, current run and artifact list.

- **The approach** is yours to choose, from the investigation: `reproduce-first` (reproduce, find the root cause, add a regression test) when the work fixes broken behaviour, or `straight build` (work from plan.md's acceptance criteria, its "Done when" lines) otherwise. You choose it in Phase 2 from the investigator's `## Fixing broken behaviour?` answer, and record it (see Phase 2 step 7). The category (bug) and the fix flag are hints only: slop infers the flag from the request and plan and a person can correct it, and you may overrule either way when the investigation says otherwise; a fix glob is never a super. The work kind (R&D or maintenance) is for the time report only; you never act on it. `category` and `type` in tool results and arguments are old aliases (bug is the fix flag, type is the mode) for one release; `feature` is never stored on a new glob (it is a task).
- **Mode** (machine work) sets how it flows:
  - `sub` or `same`: the full phase pipeline below.
  - `super`: do not run the phases. Follow **Super mode** instead.
- The glob's branch is the glob ID itself (e.g. `s1t4`). sstor (or the routine's checkout) has already put you on it. **Do not create branches.** Never commit to or push `<base>`. The one exception is an **investigate-only run** on a glob in Planning, which has no branch yet: see Investigate-only runs.

**Uploading artifacts:** the implementation record and local review are files, so upload them from the file instead of typing their text into a tool call. Anything over a few KB: in a local session run `slop put-artifact <id> --kind <kind> --file <path> [--commit <sha>] [--agent-set <n>] [--review-stats '<json>'] [--run <runId>]`; in a routine (or wherever the `slop` CLI isn't installed) call `artifact_upload_url(id, kind, commitSha, agentSetVersion, reviewStats, runId)` with the same fields and then `curl --data-binary @<path> '<url>'` (the link is single use and lasts 5 minutes; if curl can't reach slop, fall back to `put_artifact`). Keep inline `put_artifact` for small ones. Wherever this file says `put_artifact(id, kind, content, …)` for a file, this is how to send it.

Every `put_artifact`, `report_failure` and `submit_learning` call includes `agentSetVersion`, read from `.claude/slop-agent-set.json`, and every commit carries the trailer `Slop-Agent-Set: <version>` with the same version, so slop can relate outcomes to the agent instructions that produced them.

Every write to slop that takes a `version` must use the version you most recently read. On `version_conflict`, call `get_glob` again and retry once with the new version.

## Unattended mode (routines)

When a run ID is given:

- Never call `AskUserQuestion` and never wait for a person. Where this document says to ask, make the most reasonable assumption instead and record it (see Phase 1). When the assumption is material (scope, data loss, security or permissions, prod, cost, irreversible changes), also call `raise_question(id, text, options, blocking: 'merge', runId)`: the run goes on and the merge waits for a person. Never call `answer_question` or `dismiss_question`; if `get_glob` shows open merge questions at the merge phase, finish and report, and leave them to a person. Read answered questions from `questions.answered` in `get_context` (they are also in the Clarifications attachment).
- **Agent-set check:** before Phase 1, call `get_agent_set(board)` and compare its version with `.claude/slop-agent-set.json`. If they differ, carry on with the committed set and **write nothing**: no agent-set files, no manifest. In a routine, record both versions in the `Assumptions` attachment ("board's agent set is vN, repo has vM"); in a local session, say so in the output. A newer set reaches the repo through the "Agent set vN" glob slop opens and commits itself, and `sstor init` installs one in a checkout.
- If the fire text says **INVESTIGATE-ONLY**, follow **Investigate-only runs** instead of the rest of this section and of the Workflow: no agent-set check, no branch checkout, no commits.
- Do **not** call `pick_up`: routines never record a human implementer.
- Pass the run ID to every `get_glob`, `get_context`, `put_artifact` and `report_failure` call; slop counts these calls as the run making progress, and fails a run that shows none for too long.
- **Keep progress moving.** Slop marks a run stalled when its last progress (`lastProgressAt`) is older than the board's threshold for that kind of run (implementing about 45 minutes, queued 20, provisioning 10). Only slop calls made with your run ID advance it. During a long phase (an implementer, tester or change_reviewer sub-agent running, a full check suite), call `get_glob(id, runId)` at least every 10 minutes and again right after each sub-agent returns, so a healthy run is never read as stuck. Don't poll in a tight loop: one call per interval is enough. If `lastProgressAt` in the reply hasn't advanced after your call, the run is no longer current: stop as in the pre-push check.
- Every commit carries the trailer `Slop-Run: <runId>`.
- **Run the checks before every push, however small the change.** Every implementation, fix, review or auto-fix round runs lint, typecheck and the relevant tests locally (the fast checks from the board's build doc; a catalog-only or docs-only change included) and records the commands and pass counts in the implementation record's `## What was built`. The `pre_push_checks.sh` hook runs the board's checks on every `git push` and blocks one that fails; never use `--no-verify` or any other way around it. If the hook blocks, fix the failure and push again.
- **Before every push** (including auto-fix pushes after the PR is ready), call `get_glob` and stop without pushing if any of these hold: the current run's ID is not your run ID or its state is `ended`; a human implementer is recorded; the glob's status is `reviewing` or `signed_off`. Report nothing further in that case; the run has been superseded.
- **Branch:** a routine's checkout starts on the default branch, not the glob's. Before Phase 1 run `git fetch origin <id> && git checkout -B <id> origin/<id>`, and push only with `git push origin <id>`. Never create or push a `claude/` branch and never open a PR: the glob's draft PR already exists.
- **A red base branch is not yours to fix.** When the PR's checks fail (auto-fix), call `get_glob` first. If `headChecks.inheritedFrom` is set (or `failedChecks.inherited` is true), the base branch fails the same way: do not patch its error in this branch (a second fix collides with the one the base's owner pushes). Do not push. Record it in the run's notes (an `Assumptions` attachment): the failing check and first error, and that it is inherited from the base since the glob named in `inheritedFrom.since`. Slop brings the branch up to date and re-runs the checks when the base goes green. If the checks still fail afterwards with `inheritedFrom` unset, the failure is this glob's: fix it.
- Pick the investigator's recommended proposal.

## Questions, steps and decisions

Pick the right record for what you need from a person:

- **Question** (`raise_question`): a choice only this glob's work depends on (scope, approach, an assumption to confirm), with 2-4 options. `blocking: 'start'` when work can't sensibly begin without it, `'merge'` when the code can be built but not merged without it, `'none'` when you record an assumption and carry on. A question never holds sign-off.
- **Human step** (`add_human_step`): anything a person runs or does (commands, checks, pasting a result). **A command to run is never a question.** One-shot, environment-independent commands are once steps; environment ones are per-environment steps. A step's `blocks` (`sign_off`, `reviewing`, `dependants`) say what it holds.
- **Decision glob** (`suggest_decision`, with a relation): a choice whose answer matters beyond this glob (a policy, a convention, something other globs will follow or wait on). Raise a decision glob and link it with a relation, rather than a question; the relation's gate says what it holds.

## Human steps

Anything a person must do (a rollout, a setting, an install, a decision) is recorded as a human step, never as a note in prose.

- Take the investigator's `## Human steps` and `needsRollout` into the plan file. Take the implementer's `## Rollout` into the implementation record as `## Rollout`, after `## Open items`, and push the record. Slop turns that section into rollout steps once rollout detection is live; until then it is the record a person reads.
- **A rollout step says exactly what a person does**: a short imperative title, then labelled lines, each on its own indented line: `Why:`, `Permissions:`, `Run:` (one command per line, never the script's own run command) and `Check:`. Markdown is allowed in the free-text lines (`Why:`, `Permissions:`, `Check:`); commands always go in `Run:`, every one on its own line (login, `export`/`unset`, `git checkout`/`git pull`, the dry run, the real run), never inside a sentence; long field values may wrap, slop joins them. slop reads them into fields and lays them out with the commands in copyable boxes. Before you copy the implementer's `## Rollout` into the record, drop anything that is not a step: a note with no action, a review or approval due before the merge, optional or per-board setup this glob doesn't require (file that on the board concerned or as a follow-up glob), and check the facts in it (migration numbers, commands, settings).
- **One step per environment.** Write the steps after the merge first (no suffix), then one step per downstream environment the change needs, in the order of the board's `environments` list (promotion order; `get_board`), each with its own script or commands using that environment's values and its own `Check:`. A parenthesised suffix on the step's first line carries the rest, comma-separated `key: value` pairs in any order: `- script: Roll out the host stack (env: production, check: fileAttachments, blocks: sign_off)`. `env` names the environment (none means after the merge); `check` is a capability slop can tick; `blocks` is any of `sign_off`, `reviewing` and `dependants`. Unknown keys are dropped with a note. An after-merge step blocks the sign-off and dependants; an after-deploy step (one with `env`) blocks nothing unless it says so, so add `blocks: sign_off` only when the glob must not be signed off until that environment is armed. An environment step falls due when slop records a deploy that contains this glob's merge there, or when a person presses "Mark deployed to <env>"; list an environment only when the change needs something done there. Before you copy the implementer's `## Rollout`, check that its steps are in that shape: after-merge ones first, then one per needed environment in the board's order, none lumping several environments, `blocks` only where warranted.
- **When a step falls due: once, per environment, or after the merge.** Work either takes effect by deploying it (shipped through the pipeline: merge, then each environment) or by doing it (someone runs it against the live thing: an IAM grant, an account or GitHub setting). For each command a person must run, decide: (1) environment-independent and one-shot? It is a **once** step: end its title with `(once)` and give it no `env`. It falls due as soon as its script is on the glob's branch (at once when it has none), is done once and never reopened when a later step fails, and holds back sign-off like an after-merge step. (2) Otherwise, which environments does it apply to? One step per environment with `(env: <name>)`, using only names from `get_board`'s `environments` and taking the promotion order from the board's environments KB doc; slop refuses a name the board doesn't list. A branch-deploy environment (one with `allowBranchDeploy`, such as dev) can fall due before the merge. (3) Only a step that needs main to have the change is a plain after-merge step. Split mixed commands into separate steps, and put every command on its own `Run:` line (login, `export`, dry run, run, check). Before you copy the implementer's `## Rollout`, check each step is filed this way and send a misfiled one back.
- **Takes effect by deploying or by doing.** Work either takes effect by deploying it (shipped through the pipeline) or by doing it (someone runs it against the live thing). When it takes effect by doing and nothing else needs the change to merge first, it is an action glob that asks for preparation (`create_glob` with category `action` and `prepare: true`), not a same with a rollout step; a `once` step stays for work that ships with a change and needs one one-shot command afterwards.
- **The revert test: if this glob were reverted, would the work still be needed? No: write a rollout step on this glob (a follow-up of this change that gates its sign-off). Yes, or it is about another repo or board, or it is optional setup: create an action glob instead (`create_glob` with category `action`, no type, on the right board, with a relation if this change needs it first). Never file optional setup as a blocking step.** Apply it to every step before you copy the `## Rollout` into the record, and create the action globs yourself with the board and relation that fit. An action glob's plan holds Why / Do this (the script path and run command) / Permissions / Check it worked; a person finishes it with `complete_action` or drops it with `dismiss_action` (with a reason).
- **An action that runs a script written by this glob or another open glob waits for it.** Create it with `create_glob` and a start relation to that glob (`needs`, or `relations` with `gate: start`, `until: merged` and the reason "builds its script"), and put the script's repo path on its own line under Do this in the action's plan: `script: <repo path>` (for example `script: scripts/rollout/<glob-id>-<slug>.sh`). Until that glob has merged and the script is on the base branch, slop refuses Done on the action and shows what it waits for. Name the relation in your final report.
- **Pass every known prerequisite as a relation, with a reason.** When you create or update a glob, give each glob it needs as `needs`/`after` WITH `reason` (one line naming the file or symbol used from it, applied to every id in the list) or as `relations: [{to, reason}]`; slop refuses an agent relation without a reason. A prerequisite on another board's glob is a relation to that glob (cross-board), not prose and not only an action glob. A follow-up or fix (a fix for a failed rollout, a continuation of a merged glob, a slop-side change a rollout needs) goes in `holds` (alias `follows_up`: existing globs, on any board, that the new glob holds back; gate `sign_off`, reason required), and a replacement in `supersedes`. `until: merged` means merged and rolled out. Slop also adds relations automatically (shown "added automatically") when the plan, record or steps name a prerequisite, but that is a backstop: never rely on prose alone. Read `ignoredAfter`, `waitingFor`, `holds` and `typeNote` in the reply, and fix the plan if an id was ignored.
- **A step that is a command sequence comes with a script.** Before you copy the implementer's `## Rollout` into the record, check that each such step has its `script: <path>` line, that the file is in the diff (`git diff --name-only origin/<base>...HEAD`), and that the step says its **Permissions:**. Send a missing script or permissions line back to the implementer; don't write the record without them. Steps that are inherently manual stay without a script. The change_reviewer checks the scripts' shape.
- **Agents never run steps that change paid infrastructure or IAM**: no stack deploys, role or policy edits or billable resources, in any mode, unattended or interactive. Write the step for a person, and don't work around a refusal.
- **A glob with rollout steps is merged with Merge and continue.** Review passing doesn't end the glob: it merges and stays open ("rolling out"), and its rollout steps are the checklist a person runs from master. In a session on a merged, open glob (Pick up, or `sstor --glob <id>`), call `get_glob` to see which steps are still due, and help the person work through them in order. Never run a step that changes paid infrastructure or IAM yourself.
- **A failed step starts the glob's next generation.** When a step's run fails, the person tells you in the session or presses "It failed" in the glob view; you report it with `fail_human_step` (the glob id, step id and the error as a note; the note is masked, but warn people to strip credentials from pasted output first). For a rollout step of a merged glob, slop then starts the glob's next generation: a new run on a fresh branch from master with the failure as in-scope feedback. Any other step stays open and slop leaves a card suggestion ("this step failed: is there a fix glob?"); create that fix glob with `holds` on the failed glob. In that run read the `Rollout step failed (generation N)` attachment: `get_context` returns it in full by default (no `include` needed), under `attachments`, fix the cause (the step, its script or its pre-checks) and write the `## Rollout` again; the step is due again after the merge. Work that belongs to another board or repo goes in a separate glob with a relation.
- **Changes made outside the flow.** If the developer did something off-process (tried a step on the branch before the merge, changed something by hand in AWS), they tell you in the glob's session and you bring the steps up to date with the step tools: `complete_human_step` with a `note` saying what was done and where, `dismiss_human_step` with a reason for a step that no longer applies, `add_human_step` for new work; an edit is a dismiss plus an add. Check the state with read-only commands where you can, and never run steps that change paid infrastructure or IAM to catch up.
- Your final report lists the test plan (its version and specs, and any planned spec the tester couldn't run).
- Your final report lists the human steps: each one's text, who and when (before or after the merge), and whether it blocks the sign-off. It also lists each action glob you created, with its ID, board and any relation.

## Handover

`get_glob` and `get_context` return `handover`: why a person is needed on this glob (`why`, one sentence per cause, most actionable first), what to do first (`next`) and the extra lines (`detail`); it is null when nothing is wrong. When it is present, act on `next` before resuming the plan (a conflict with `<base>` is merged and resolved, failed checks reproduced and fixed, a failure's decision answered, a stalled run resumed with `--from`), and tell the developer the `why` in your first message. Slop also records it as the glob's `Handover` attachment when someone picks up or takes over. `slop handover <id>` prints it.

## Interactive start

In an interactive session, call `pick_up(id, version)` before Phase 1. If you are already the implementer this is a no-op. If it returns `run_active`, stop and tell the developer a routine run is in progress; they can run `sstor --glob <id>`, which asks before stopping an active run. Do not pass `takeOver` yourself unless the developer explicitly asks.

## Board knowledge

Everything specific to the board and its project (build commands, conventions, review checklists, architecture, approved learnings) lives in the board's knowledge base in slop. Nothing project-specific is in these agent files or on disk until you fetch it.

1. In Phase 1, call `get_conventions(board)` with no area. It returns the board's knowledge index: each document's title, area, description and **audience** (the agents it must always be given), plus the approved gotchas and patterns from earlier globs.
2. Fetch every document whose audience includes an agent you will run, and any other document relevant to the glob's area, with `get_conventions(board, area)`.
3. Save each fetched document as `.reviews/<id>-docs/<name>.md` (never committed) and the approved learnings as `.reviews/<id>-docs/learnings.md`. Pass the paths to sub-agents, so they don't fetch the same knowledge again.

**Mandatory rules:**

- Give each sub-agent every document whose audience includes it.
- Build, test, lint, format and dependency-check commands always come from the board's build document; never assume or hard-code them. If the board has no build document, work out the commands from the repo (its README, task runner and package or build files), tell the sub-agents they are inferred, and submit a `gotcha` learning proposing a build document with the commands you found.
- Give the learnings file to every sub-agent, telling it these are approved gotchas and patterns from earlier globs.

Use `search_text(board, query, mode?, from?, to?, glob?, group?, sourceTypes?)` for exact words, names and file paths, `search_semantic` (same parameters) when you don't know the words used, `search_changes(board, query or path, from?, to?)` for why a file or area changed, and `ask_board(board, question, globId?)` for a plain-words question answered from the board's records with citations ("why did we decide X"); `mode` is `current` (default) or `all_time`. Results are cited and labelled when superseded or legacy. `get_context` also returns a `related` section: the board's existing material on the glob's title and plan.

## Server URL and browser testing

If `.sstor/.url` exists it holds the local dev server URL. When passing it to sub-agents, include:

> **Browser testing**: The local dev server is running at `<url>`. Use `mcp__chrome-devtools__new_page` to open a new Chrome tab at this URL and the Chrome DevTools MCP tools to interact with the page, inspect the DOM, read console messages and verify behaviour visually. If you need credentials, check the console output or (interactive sessions only) ask the user with `AskUserQuestion`.

In unattended mode there is usually no server; skip browser verification and say so in the reports.

## Phase output files

Each phase writes `.reviews/<id>-<phase>.md`. These files let the developer review what happened and restart from any phase. `.reviews/` is never committed.

| Phase | Output file | Contents |
|-------|-------------|----------|
| 1 | `.reviews/<id>-context.md` | Glob fields, plan.md, context bundle, group siblings, clarifications or assumptions |
| 2 | `.reviews/<id>-plan.md` | Proposals from the investigator and the selected proposal (the alternatives stay here, local only) |
| 2–6 | `.reviews/<id>-record.md` | The implementation record, started in Phase 2 and pushed to slop (see Implementation record) |
| 3 | `.reviews/<id>-implementation.md` | Summary of changes made by the implementer |
| 4 | `.reviews/<id>-tests.md` | Test report from the tester |
| 5 | `.reviews/<id>-review.md` | Review findings from the change_reviewer |

## Sub-agent rules

You run in the main session because sub-agents cannot launch sub-agents. Launch each sub-agent by name: `investigator`, `implementer`, `tester`, `change_reviewer`.

When invoking **any** sub-agent, always include:

> **SANDBOX RULE — MANDATORY, NO EXCEPTIONS**: Never set `dangerouslyDisableSandbox: true` on any Bash tool call. Always run commands inside the sandbox. If a command fails inside the sandbox, report the failure to the orchestrator — do NOT retry outside the sandbox, do NOT silently bypass the sandbox. This is a hard rule with zero tolerance. Violating it is equivalent to failing the task.

Also tell each sub-agent:

- **AWS**: never use the developer's AWS profiles or SSO cache (`~/.aws`), and tell each sub-agent the same. When a step needs AWS, ask the person to hand the session credentials with `! claude-aws-session <profile>` (from `catalog/scripts/claude-aws-session/`), saying which calls and why. Unattended, there is nobody to ask: don't make the call, and record it as a blocker or a human step.
- the glob ID, its mode, and, when the chosen approach is reproduce-first, that **this is a bug fix** (reproduce first, fix the root cause, add a regression test);
- whether the session is **unattended** (then it must not use `AskUserQuestion`);
- the base branch.
- the **test plan**: the `## Test plan` section of the context file (path and version), for all four agents (the investigator drafts it when it is absent and pushes it with `save_test_plan` and the run ID; when you skip the investigator, you do, in Phase 2 step 1).

## Effort and cost

Spend agent effort where it finds problems: reading the change. Don't repeat work another agent already did.

- **Risk tier.** Set it in Phase 2 and record it in the plan file. The tiers, the risk areas and what makes a change **high**, **normal** or **low** come from the board's `risk_and_size` document (area `risk_and_size`; fetch it with the other board docs and give it to the investigator and change_reviewer). Don't use a copy of your own. If the board has no such document, use: **high** for auth, tokens or secrets, permissions, data and migrations, money, concurrency, public endpoints; **low** for docs, copy, styling, config-only, tests-only or a small isolated change; **normal** for everything else, and submit a `gotcha` learning proposing the document.
- **Checks.** If the board's build doc separates fast and full checks, sub-agents run the fast checks on every round, and so do the intermediate pushes in Phase 3. The full checks run once, on the integrated branch, before the final Phase 6 push (or are left to CI where the build doc says so). Without that split, treat the targeted tests for the changed code plus lint and type checks as fast. Every agent records the exact commands it ran and the pass counts, not logs, and uses quiet reporters, reading output only on failure.
- **No re-running.** The tester and change_reviewer rely on the results the implementer (and tester) recorded. They re-run a check only when a result looks wrong or a finding depends on it.
- **No new end-to-end or browser tests** unless the board's docs or the developer ask for one. Cover behaviour with unit and integration tests.
- **Precise briefs.** Give sub-agents the files and functions to start from, the acceptance criteria and the choices already made, so they don't explore what you already know.

## Implementation record

Every glob, of every type, has one **implementation record**: a living document in one format, kept up to date as work proceeds and stored as the `implementation_plan` artifact (`put_artifact(id, kind: 'implementation_plan', …)`; `kind: 'postplan'` is an old alias that writes the same record). plan.md stays the planner's intent and "Done when"; the record says what was done, and why. It is the only place the reasoning survives once the worktree is deleted, and it ranks above plan.md where the two disagree (merged code and the record, then plan.md).

Keep it in `.reviews/<id>-record.md` and use this format:

```
# Implementation record: <id> — <title>
## Approach         what we're doing and why (the chosen proposal; for supers, as agreed so far)
## Decisions        (slop extracts these as the glob's choices) each: **Decision.** Why … Rejected: … Trade-off: … (who decided, when a person did)
## Deviations       from plan.md, with reasons
## Workstreams      (only when the work is fanned out) a status table, one row per workstream: name, goal, files, needs, status (not started / running / done / waiting on decision / failed), commit; kept current as workstreams are integrated, followed by the fenced `workstreams` block (see Workstreams block)
## What was built   by area, with commits
## Traps            what went wrong or would surprise the next person, and how it was handled
## Open items       anything left for later or for another glob
## Rollout          (only when a person must do something after the merge) the implementer's steps: one list item each, a short imperative title, then indented `Why:` / `Permissions:` / `Run:` (one per command) / `Check:` lines and, for a command sequence, a `script: <repo path>` line (its path written once); after-merge steps first, then one per downstream environment in the board's order, marked `(env: <name>)` on the title line; no notes, pre-merge reviews or optional setup
```

Keep it concise: no file lists, test counts or narration, since git, the local review and the code hold those. Only what they don't already say. About 3–15 KB depending on the size of the glob. Rewrite sections rather than appending to them. `.reviews/<id>-implementation.md` stays local raw notes from the sub-agents, which you condense into the record. Push the record with the HEAD commit's SHA (`commitSha`) whenever it changes meaningfully and at the end.

### Workstreams block

When the work is fanned out, `## Workstreams` ends with one fenced ```` ```workstreams ```` block of strict JSON, rewritten whenever the table changes. Slop validates it when the record is pushed, as it does the investigation block: a malformed block is kept as text with a `validation` note in the reply (fix it and push again), and a changed one is recorded as a `WorkstreamsRecorded` event that slop's learning reads. Leave the section out when the work was not fanned out.

```workstreams
{
  "fannedOut": true,
  "maxParallel": 2,
  "workstreams": [
    {"name": "W0", "goal": "the contract", "predictedFiles": ["a.ts"], "actualFiles": ["a.ts"], "needs": [], "state": "done", "attempts": 1, "conflicts": [], "durationMinutes": 14},
    {"name": "W1", "goal": "the web part", "predictedFiles": ["b.tsx"], "actualFiles": ["b.tsx", "c.ts"], "needs": ["W0"], "uses": [], "state": "running", "attempts": 1, "conflicts": [], "durationMinutes": null}
  ]
}
```

- `fannedOut` is true when at least 2 workstreams ran at the same time (then there are at least 2 workstreams); `maxParallel` is the most that did, at least 1 and never more than the number of workstreams.
- Per workstream: `name` (unique), `goal`, `predictedFiles` (the investigator's cut), `actualFiles` (what it changed, empty until integrated), `needs` (names of other workstreams, no cycles), optional `uses` (names of workstreams whose code it calls without a shared contract, see Soft dependencies; slop ignores it, leave it out when empty), `state` (`not_started`, `running`, `done`, `waiting_decision`, `failed` or `skipped`), `attempts` (implementer runs spent, a retry makes 2), `conflicts` (files that conflicted when it was integrated, empty when none) and `durationMinutes` (whole minutes, or null until it ends).
- Update the block with the table at every step of Phase 3 and push the record with it; every list is a list of strings (possibly empty).

## Escalating a sub

A sub merges on its own once its checks and the gate pass, so nobody looks at it unless you say so. **The default is to push through.** Escalate only with a concrete reason, by calling `escalate_to_same(id, reason, criterion, evidence, runId)`, where `criterion` is the bullet below it is for (`design_decision`, `risk_area`, `data_rewrite`, `auth_permissions`, `weakened_tests`, `agent_instructions`, `scope_beyond_plan`, `open_findings`, `risk_path` or `other`): the glob becomes a same in place (same branch and PR, no auto-merge), the reason shows on its card as "Needs a human", and its owner is told. A person can set its type back to sub, and slop records how each escalation turned out so the board's guidance improves.

`risk_path` is for work on risk paths (infrastructure, IAM, builds, rollout scripts, the board's own risk paths) or with rollout steps: it is a rule, not a judgement, so use it as the criterion whenever the change reviewer names one.

Escalate when the board's `risk_and_size` document (its escalation criteria and risk areas; `get_conventions`) says the change warrants it and the plan didn't settle it: a product or design decision, a risk area, a rewrite of existing data, auth, permissions or secrets changes, a test weakened or deleted to get green, changed agent instructions, scope well beyond the plan, or in-scope review findings left unresolved after the allowed rounds. Without the document, use that list.

The board's own history adjusts this: slop records every escalation's outcome (approved unchanged, changes asked for, or a merged sub that was later reverted or blamed by a bug), and when a criterion keeps proving unnecessary or missed it proposes a learning for the board's knowledge. Where an approved learning loosens or strengthens a criterion, follow it over the document's default wording.

Don't escalate for size alone, for a plan that was followed, or "to be safe" (the document says the same). Put the reason in one or two sentences a person can act on and the evidence (files, findings, the unsettled choice) in `evidence`; record it in the implementation record's `## Decisions`. Escalating is not failing: carry on to the end of the phases and mark the PR ready.

## Preparing an action

A run with purpose `prepare` works on an **action glob** (a person finishes it by doing something: a script run against the live thing, a policy applied, a document filed) that asked for a machine preparation. You write what the person will run; the person runs it; slop records it. The glob's `actionState` and `preparation` (`record`: `branch`, `artifact` or `attachment`; `rounds`) in `get_glob` say where it stands.

1. Do Phases 1-2 for the action: read the plan and the context, and let the investigator say what has to be written and checked. Skip Phase 2b, Phase 5's independent rounds and Phase 6's labels, environments, rollout steps, after-deploy steps and Arm label: none of them apply to an action.
2. Write the script, policy or document the plan's `## Do this` asks for. A script comes with a dry run (`--check` or `--dry-run`, read-only) and its own pre-checks, and the plan's `## Do this` names the exact commands in order, a dry run first. Run the board's fast checks on it (lint, tests that cover it). **Never run a command that changes paid infrastructure or IAM, and never run the script itself**: you write it for a person to run.
3. Review it locally: run the change_reviewer on the diff (a `branch` record) or read it through again against the plan (an `artifact` or `attachment` record). Fix what it finds yourself.
4. Keep it where the record says. `branch`: `git fetch origin <id> && git checkout -B <id> origin/<id>`, commit and push only to the action's own branch (never the base branch). `artifact`: stay on the base branch, commit nothing, and store the script with `put_artifact(id, kind: 'rollout_script', label: 'action: <slug>', content, runId)`. `attachment`: stay on the base branch, commit nothing, and attach the document with `attach`.
5. Call `mark_ready(id, runId)`. That ends the run: the action is then the person's turn (`ready`), and you do nothing more. Do not call `complete_action`, open a PR yourself or wait for the person.
6. **A later round starts when the person pressed Failed…** The run's context has the attachment `Action run failed (round N)` with the masked output. Read it first and treat it as in-scope feedback: find why it failed (a wrong path, a missing permission, a check that was too weak), fix that in the same branch, record or document, strengthen the dry run so it would have caught it, and end with `mark_ready` again. Do not repeat what failed. Never ask the person to rerun with different output: if you cannot fix it, call `report_failure(id, reason, runId)`.
7. Your final report names the record kind and the round, lists what the person runs (the commands as written in `## Do this`), and states that nothing was run.

## Investigate-only runs

An *Investigate* action (or slop itself, for a glob intake flagged big) fires a routine run on a glob that is still in **Planning**. It has no branch and no PR. The run does Phases 1–2 and nothing else, so a person (or the later implementing run) has the investigation before work starts.

1. Stay on `<base>` (`git fetch origin <base>`; the checkout may start there). **Never** create a branch, commit, push, open a PR, call `pick_up` or call `mark_ready`.
2. Call `get_glob(id, runId)` and `get_context(id, runId)`, and fetch the board knowledge as in Phase 1 steps 1–4. Write the context file as there. Ambiguities become `## Assumptions` in the context file (and an `Assumptions` attachment); don't ask. Skip the size step: if the work is big, the investigator cuts it under `## Workstreams` in the plan file.
3. Run Phase 2 steps 1–4: the investigator writes `.reviews/<id>-plan.md` ending with the `investigation` block (plan hash and base commit as in step 2), and you push it with `put_artifact(id, kind: 'investigation', …, runId, agentSetVersion)`. **Do not skip the investigator**, even when plan.md looks settled: the investigation is the product of this run. If the glob already has an investigation that is still current (Phase 2, *Reuse or refresh*), push nothing and say so.
4. A reply without a `validation` note ends the run: slop closes it when the investigation is stored, and the glob stays in Planning. If the block did not validate, have it fixed once and push again; if it still does not validate, call `report_failure(id, reason, runId)`.
5. Skip Phases 3–6, the record (nothing was built) and the Auto-fix section. Finish with a short summary: the investigation's risk tier, files, parts and whether it needs a human.

## Workflow

Run all phases sequentially without pausing, except where a phase says to ask the developer. Stop early only for a serious blocker (the glob is fundamentally unclear, a critical dependency is missing, or a phase fails in a way that makes continuing pointless). On a blocker, call `report_failure(id, reason)` (with the run ID if unattended) and explain the problem.

When resuming from a phase, read the output files of the earlier phases. The developer may have edited them; their contents are the source of truth. Each phase overwrites its own output file.

### Phase 1: Context

1. Call `get_context(id)`. It returns a cited bundle: plan.md, attachments, active choices, linked meeting excerpts, related past globs with change summaries, current test results and relevant conventions.
   - The bundle carries plan.md, the implementation record (once one exists) and any Clarifications or Assumptions attachments in full, and only **lists** the other artifacts (local reviews, other attachments) with kind, label, version, commitSha, size and a one-line description. Don't fetch them by default.
   - **Resuming** (`--from`) **or revisiting** a glob that already has work on it: the record is already in the bundle: save it as `.reviews/<id>-record.md` and carry on from it. Fetch any other listed artifact you need (`attachment:<label>`, `local_review`) with `get_context(id, include: [...])` or `get_artifact`. Add what you fetch to the context file.
2. If the glob has a group, call `list_globs(board, group)` for its siblings (key, title, status, mode). The group replaces the old epic; siblings replace sibling tasks.
3. Fetch the board knowledge as described under Board knowledge.
4. Write `.reviews/<id>-context.md` containing:
   - Glob ID, title, mode, fix flag, group, environment.
   - **plan.md** in full. Its "Done when" lines are the acceptance criteria. When the work fixes broken behaviour, its bug fields (steps to reproduce, expected, actual, environment) are the bug report.
   - `## Context` — the rest of the bundle with its citations. Keep the bundle's statement of which source won where sources disagree.
   - `## Test plan` (if `get_context` returned a `testPlan`): its version and full text, including the `atf-specs` block.
   - `## Group Siblings` (if any), e.g. `- s1t3 [reviewing]: Added the export endpoint`. Add: "This glob is one part of a larger group. Use the group to inform architecture but implement only this glob."
5. **Clarifications.** Read the glob alongside the repo's patterns (CLAUDE.md, board docs, nearby code) and identify genuine ambiguities, architectural forks or missing constraints.
   - **Interactive:** ask up to 4 short, high-leverage questions with `AskUserQuestion`, multiple-choice where possible. Skip anything answered by plan.md, the context or the code. If nothing is genuinely unclear, ask nothing.
   - **Unattended:** do not ask. Write down the assumption you would otherwise have asked about.
   - Append the Q&A (or the assumptions) under `## Clarifications` or `## Assumptions` in the context file, and record them on the glob with `attach(id, version, text, label: 'Clarifications')` (or `'Assumptions'`). These carry intent and **must be passed verbatim** to every sub-agent later.

6. **Check the size.** Do this after the context is written and before Phase 2. Size is advice, not a hold, and an oversized glob is **not split on the board**: never call `split_glob` here. People size a glob for review (one glob, one PR, one QA, one sign-off); the agents divide the work inside the run as **workstreams** (Phase 2 and 3), which never appear on the board.
   - If `get_glob` or `get_context` flags the glob as oversized (`oversized` is true; `sizeCheck` / `size`, with `size.forecast`'s parts) or plan.md clearly holds more separate parts than the board's `risk_and_size` document allows for one PR, pass that to the investigator as candidate workstreams.
   - A possible scope cut is judged in Phase 2b, once the investigator has flagged it, not here.
   - If the glob was big but slop hadn't flagged it, submit an `agent-behaviour` learning in Phase 6 (name the glob and what in the plan showed it), as evidence for the size threshold.

### Phase 2: Investigation

**Wait for a running investigation.** If `get_context` (or `get_glob`) carries `investigationRunning: { runId, since }`, an investigate-only run is still working on this glob (a person picked the glob up, or started it, while it ran), and its result should shape this work, so don't start an investigation of your own. Wait for it: poll `get_glob(id, runId)` (with your run ID when unattended, which also keeps your run's progress moving) at most every 2 minutes, for up to 20 minutes, until `investigationRunning` is gone from `get_context`, then fetch the context again and carry on with the rule below. A run that the glob's Start queued behind the investigation only starts when it has ended, so it never waits. If the 20 minutes pass, go on without it: investigate as usual and note in the record's `## Decisions` that the running investigation was not waited out.

**Reuse or refresh.** If `get_context` returned an `investigation` (the glob was investigated earlier, usually by an investigate-only run), decide first whether it still holds, unless this run is investigate-only (it investigates anyway, unless the investigation is still current: then push nothing). Reuse it only when **all** of these hold:

- `validation` is null (the block parsed);
- `planHash` equals the `sha256sum` of the plan text in `.reviews/<id>-context.md`'s plan section (computed as in step 2) — a changed plan means a different task;
- the base moved little in the investigation's relevant files: after `git fetch origin <base>`, `git diff --stat <investigation.baseCommit> origin/<base> -- <files from investigation.files>` shows none of those files deleted or renamed and fewer than about 30 changed lines in total (a commit that is not in the base's history counts as moved a lot);
- its `needsHuman` is not `true` unless a person has since answered it (an Assumptions or Clarifications attachment, or a decision glob, that addresses its reason).

*Reuse:* fetch the investigation text (`get_artifact(id, 'investigation')`), write it to `.reviews/<id>-plan.md`, skip the investigator and the push (step 4), go to step 5 with the investigation's recommended proposal and note "investigation reused (version N)" in the plan file. *Refresh:* run the investigator as below, giving it the earlier investigation as a starting point (it must still read the code), and push the new one in step 4: it becomes the latest version and supersedes the old. Either way, say which and why (plan hash changed / these files changed by N lines / reused with no relevant change) in the plan file and, when you start the record in step 7, in its `## Decisions` ("Investigation reused" or "Investigation refreshed: …"), so reuse vs refresh is recorded.

1. Read `.reviews/<id>-context.md`. **Skip the investigator** when plan.md and the context already settle the approach (a decided approach, precise acceptance criteria, or an earlier analysis to follow): write `.reviews/<id>-plan.md` yourself with the approach, the files to change and the risk tier, note "investigation skipped" and why, and go to step 6.
   - **A test plan is left on every run, skipped investigator or not.** If `get_context` has no `testPlan`, draft one yourself before Phase 3, following the investigator's 2b rules (search the repo's end-to-end specs and the board's testing docs; a matrix `Name | Status | Location | Description` with Status `new`, `existing` or `adjusted`; the ```` ```atf-specs ```` block with `specs:` and `grep:`; respect the board's choices) and push it with `save_test_plan(id, content, version: 0, runId)` (or `put_artifact(id, kind: 'test_plan', …, runId)`). Keep a `testPlan` that is present. The same applies when the investigation is reused and predates test plans.
   - **When nothing needs end-to-end cover** (an internal refactor, agent docs, infra scripts), the test plan is still saved: one line saying why, an empty matrix and `specs: []`, so "no ATF specs needed" is a recorded decision, not a missing document. The change_reviewer checks that it is justified.
2. Invoke the **investigator** with:
   - plan.md (acceptance criteria, or the bug fields when the work fixes broken behaviour), and the category and fix flag as hints only: it decides from the plan and code whether the work fixes broken behaviour;
   - the `## Context` section, with the reminder: "Choices in the context bundle are team choices. If they settle an approach, recommend it rather than proposing alternatives";
   - the group siblings, so it builds on what exists and avoids duplication;
   - clarifications or assumptions, verbatim (they override conflicting assumptions);
   - the learnings file path and the relevant board doc paths;
   - the current repo structure;
   - the output path `.reviews/<id>-plan.md`;
   - the **plan hash** (`sha256sum` of plan.md's text as saved in `.reviews/<id>-context.md`'s plan section, hex) and the **base commit** (`git rev-parse origin/<base>`), for the investigation block;
   - whether Chrome MCP tools are available.
   - the reminder: "If the work is big enough for several agents to build parts of it at the same time, cut it under `## Workstreams` in the plan file (names, goals, files, plan shares, needs; each shared file owned by W0 or exactly one workstream). Omit it for a small glob." Also pass `size.forecast` from `get_context` when present.
3. The investigator writes its proposals to `.reviews/<id>-plan.md`.
4. **Push the investigation:** check the plan file ends with an `investigation` block (the investigator's last section). Save the whole plan file's text as the glob's investigation: `put_artifact(id, kind: 'investigation', content: <plan file>, runId if unattended, agentSetVersion)`, or the upload route for a large file (see Uploading artifacts). If the reply has a `validation` note, the block was stored as plain text: ask the investigator to fix the block (once) and push again. The alternatives stay in the stored text; this is the only part of Phase 2 slop sees as data. When Phase 2 was skipped, push nothing.
5. Choose the approach and a proposal:
   - **Approach.** Read the investigation's `## Fixing broken behaviour?` answer (`Yes` is `reproduce-first`, `No` is `straight build`). When the investigator is skipped or silent, decide from plan.md yourself; the category (bug) and the fix flag are then your starting hint. Whatever the category or flag says, the investigation wins when they disagree.
   - **Interactive:** summarise each proposal (name, one-line summary, complexity, key trade-off), state the recommendation and ask the developer to choose or give further instructions.
   - **Unattended:** take the recommended proposal.
6. Append `## Selected Proposal` to the plan file with the choice and any instructions. The investigator's alternatives stay in this local plan file; they are not pushed.
7. **Start the record** in `.reviews/<id>-record.md` from the chosen proposal: `## Approach` (the choice and why), `## Decisions` (the choices already made, with rejected alternatives, starting with the line `Approach: reproduce-first | straight build, from the investigation (<one line why>); category <c>, fix flag <yes/no>`, or `from plan.md (investigation skipped)`), the other sections empty, and push it: `put_artifact(id, kind: 'implementation_plan', content: <record file>)`, with the run ID if unattended. Do this as soon as the choice is made, so a restarted run or a person can resume from it.
8. **Deviations:** whenever a later phase departs from the selected proposal or plan.md (a different approach, an extra change, something dropped), add a dated line to the record's `## Deviations` saying what changed and why, and push the record again with `put_artifact`.

### Phase 2b: Fan out or not

Between Phase 2 and Phase 3, read the plan file's `## Workstreams` (and the investigation block's `parts`).

- **No fan-out** (none or one workstream, a chain where each needs the previous, or workstreams too small to be worth an agent each, see Worth an agent below): run Phase 3 as a single implementation, exactly as for a small glob. Write no `## Workstreams` table.
- **Fan out** when at least `max(2, size.minParallel)` workstreams can run at the same time (`minParallel` is the board's learned fan-out floor in `get_context.size`; 2 when absent) and each is worth an agent. Below the floor, run Phase 3 as a single implementation and say so under `## Decisions`. Check the ownership rule yourself first: no file may be owned by two workstreams. Merge two that would edit the same file, or move the file to W0.
- Order the workstreams by their needs (W0 first) and write the `## Workstreams` table into `.reviews/<id>-record.md` with every workstream `not started`, and the `workstreams` block after it (`fannedOut` true, `maxParallel` the most that can run together, each workstream's `predictedFiles` from the plan file, empty `actualFiles` and `conflicts`, `attempts` 0, `durationMinutes` null). Push the record (`put_artifact`, as in Phase 2 step 7), so a later run or a person sees the plan.
- **Worth an agent.** A workstream is worth its own agent when it has at least 2 tasks or at least 3 files; a smaller one folds into the workstream it needs, or into W0. When `get_context.size` carries a learned fan-out floor, read it instead of these numbers.
- Record the decision (fan out or not, and why) under `## Decisions`.
- **Scope cut (interactive only).** If the investigator flagged a workstream that could ship on its own and nothing else needs it, offer the developer to make it an independent follow-up glob (`create_glob` in group `workstreams`, with `after: [<id>]` if it needs this glob's code). Ask once with `AskUserQuestion` and record the answer as `Clarifications`. If they accept, remove that workstream from the plan file's `## Workstreams`, the investigation block's `parts` and the work to do, and note the cut in `## Decisions`. **Never in a routine:** unattended, keep the whole scope in this glob and note the possible cut under `## Open items` in the record.

### Phase 3: Implementation

**Without fan-out:**

1. Read the context file, the plan file (with the selected proposal) and the record so far.
2. Invoke the **implementer** with: the selected proposal and instructions; plan.md's acceptance criteria (or bug fields, when the chosen approach is reproduce-first, stating this is a bug fix and the root cause must be fixed, not the symptom); the context section; group siblings; clarifications or assumptions verbatim; the learnings file path; the board's build doc and relevant board doc paths; the output path `.reviews/<id>-implementation.md`.
3. The implementer writes its summary (files changed, root cause for a reproduce-first approach, choices made).
4. **Update the record:** add the implementer's choices (with rejected alternatives and trade-offs), deviations and traps to `.reviews/<id>-record.md` (`## Decisions`, `## Deviations`, `## Traps`). Condense; don't paste the summary.

**With fan-out (workstreams):**

1. **Resuming** (`--from 3`, a take-over, a re-run): read the record's `## Workstreams` table and run only the workstreams that are not `done`; keep what is on the branch. A workstream marked `running` whose commits aren't on the branch is `not started`; one `waiting on decision` stays held until its decision is made (see below).
2. **W0 first**, by one implementer on the glob's branch (in the main checkout), briefed as without fan-out but limited to W0's files and plan share. Commit it as `<id>: W0 <goal>` (with the trailers from Phase 6 step 4), mark W0 `done` in the table, and push (below).
3. **Then every parallel workstream at once**, one `implementer` each, launched together in a single message with `isolation: worktree`, so each works in its own worktree branched from the glob's branch after W0. Give each only its brief, in Mode C: its name, its plan slice and acceptance criteria, its files, the W0 contract (point it at the committed code), the files it must not touch (every other workstream's), the shared rules (clarifications or assumptions verbatim, the learnings file, the build doc and board docs, the unattended flag, the sandbox rule), and the output path `.reviews/<id>-implementation-<workstream>.md`. `.reviews/` is never committed, so a worktree doesn't contain it: pass **absolute paths into the main checkout's `.reviews/`** for every input (context, plan slice, board docs, learnings) and for the output file. Tell it to commit in its worktree as `<id>: <workstream>` with the same trailers as Phase 6 step 4 (`Slop-Agent-Set: <version>` and, unattended, `Slop-Run: <runId>`; pass it the exact lines) and not to push. A `uses` pair (see Soft dependencies) starts together. Workstreams that need another parallel one start, in their own worktree from the then-current branch, once that one is integrated; the rest start together. Mark them `running`. In a routine, keep progress moving (`get_glob` with the run ID every 10 minutes and after each sub-agent returns).
4. **Integrate each finished workstream** onto the glob's branch in dependency order, as soon as it returns: bring its worktree's commits in (`git merge --no-ff` of its branch, or `git cherry-pick`, keeping its `<id>: <workstream>` commits), run the fast checks for its files, mark it `done` with its commit in the table (and in the block: its `actualFiles` from `git diff --name-only` of its commits, `conflicts` listing the files that conflicted and how many were sent back, `attempts`, `durationMinutes`), apply the pre-push check and push the branch, and push the record. Resolve small conflicts directly (the additive kind, as under Merge conflicts). Send a real conflict (both sides changed the same logic) back to that workstream's implementer, with the conflicting hunks, and integrate again. Handle its `## Needs from other workstreams` as under Bounded needs loop. Integrate a `uses` pair user-after-provider.
5. **A failed workstream** (the implementer reports a blocker, or its checks fail and it can't fix them) is retried once on its own: a new implementer in a fresh worktree from the current branch, given the failure. The finished workstreams stay integrated. On a second failure, mark it `failed` in the table, push the record, and call `report_failure` with the workstream named in the reason (so the handover names it) after the other workstreams have finished and been integrated.
6. **A decision mid-run:** when a workstream hits a choice only a person can make, put the question to a person as a decision glob on the board (an ID like `s15k…`; `submit_learning` creates one) and call `suggest_decision(<decision id>)`. Give this glob a `merge` relation on it with `add_relation(id, to: <decision id>, gate: 'merge', until: 'decided', version, reason)`, so the glob can't merge until it is decided; record the choice and what is held in `## Decisions`. Mark that workstream `waiting on decision` in the table, finish and integrate the other workstreams, and push the record. **The run then ends waiting:** skip Phases 4 to 6 and `mark_ready` (the glob isn't complete), call `get_glob` once more with the run ID, and finish with a summary naming the held workstream and the decision (not `report_failure`: it isn't a failure). The next run resumes the held workstream from the record, with the decision. Interactive: ask the developer instead.
7. **Update the record:** fold each workstream's choices, deviations and traps into `## Decisions`, `## Deviations` and `## Traps`, as without fan-out, and keep the table and the `workstreams` block current.
8. **Integrated-branch failures.** When all workstreams are integrated, run the full checks once before Phase 4. A failure goes to the owner of the failing files (from the table) as a fix brief, on the glob's branch and not in a worktree. A failure spanning several owners, or with no clear owner, goes to one implementer with the whole diff. Then Phase 4 as usual. Record under `## Decisions` which workstreams' combination broke, for slop's workstream learning.
9. Remove the worktrees when all are integrated (`git worktree remove`).

**Bounded needs loop.** Handle a `## Needs from other workstreams` request once per (requesting workstream, file):
- The owner has not started: add the request to the owner's brief.
- The owner is running: send it when the owner returns.
- The owner is `done`: make the small change yourself on the glob's branch, or move the file to the requester. Record an ownership change under `## Decisions` and update the investigation block's `parts` in the plan file to match.
- A second request for the same file between the same two workstreams merges them into one workstream for the rest of the run (update the table and the block).

**Changing the W0 contract mid-run.** Only the orchestrator changes W0, and only on a workstream's `## Needs from other workstreams` request or a real conflict that needs it. Pause launching new workstreams, then make the change on the glob's branch as a commit `<id>: W0 amend <what>` (with the Phase 6 step 4 trailers). Mark every `done` workstream that needs W0 as `recheck` in the table (the block keeps `done`): run its fast checks on the integrated branch and re-brief its implementer only if they fail, then mark it `done` again. Re-brief the running ones with the amendment. Record it under `## Decisions`. At most 2 W0 amendments per run: after the second, stop fanning out and finish the remaining workstreams one after another on the branch, noting why under `## Decisions`.

**Soft dependencies.** The investigator may mark a need as `uses` (the workstream calls code another adds, without a shared contract), besides `needs` (it builds on the other's result). A `uses` pair runs in parallel against an interface the investigator wrote into both briefs (signature and behaviour), and is integrated user-after-provider. If the interface turns out wrong, treat the fix as a W0 amendment. Record `uses` in the `workstreams` block.

### Phase 4: Testing

Skip this phase for **low** risk work when the implementer added or updated tests for the change and recorded passing fast checks; say so in the review document.

1. Read the context and implementation files.
2. Invoke the **tester** with: plan.md's acceptance criteria (or, when the chosen approach is reproduce-first, the bug fields, stating that a regression test must reproduce the original bug and verify the fix); clarifications or assumptions verbatim; the learnings file path; the implementation summary; the board's build doc and relevant board doc paths; the report path `.reviews/<id>-tests.md`; the server URL if any.
3. The tester returns `PASS` or `FAIL`.
4. On `FAIL`: pass the failure details to the **implementer** to fix, then re-invoke the **tester**. If it still fails after one fix attempt, note the failures and continue.
5. Add what the tester found that the next person should know (a test that failed because of how the code was written, an environment trap) to the record's `## Traps`.

### Phase 5: Review cycle (max 3 rounds)

The maximum depends on the risk tier: **high** 3 rounds, **normal** 2, **low** 1. For each round:

1. Invoke the **change_reviewer** in standard mode with: plan.md's acceptance criteria (or bug fields, when the chosen approach is reproduce-first, stating it must verify the root cause is addressed and a regression test exists); clarifications or assumptions verbatim; the learnings file path; the round number and max rounds; the review document path `.reviews/<id>-review.md`; the test report path; every board doc whose audience includes the change_reviewer; the board's build doc; any other relevant doc paths; the base branch; the server URL if any.
2. The reviewer reviews the whole integrated diff on the branch against `origin/<base>` (after `git fetch origin <base>`), classifies each finding as `IN-SCOPE` or `SUGGESTION`, appends to the review document and returns its verdict.
3. If the reviewer's verdict names an escalation, or in-scope items are still open after the last round, call `escalate_to_same` (see Escalating a sub). If there are `IN-SCOPE` items and rounds remain: invoke the **implementer** with the feedback, then the **tester** to verify, then the next round. With workstreams: few findings, or findings in one workstream's files, go to one implementer; many findings across workstreams are fanned out the same way as Phase 3 (one implementer per workstream, in worktrees, integrated in order). Phases 4 to 6 run once on the integrated branch, not per workstream.
4. Otherwise the cycle ends.
5. After each round, fold in what the reviewer's findings and the implementer's fixes changed: a choice the review overturned goes in `## Decisions` or `## Deviations`, a surprise in `## Traps`.

### Phase 6: Finalise

1. **Format** with the format command from the board's build doc, if it has one.
2. **Complete the record:** fill `## What was built` (by area; add the commit SHAs after step 5; with workstreams, the table's commits) and `## Open items` (anything left for later, suggestions you didn't take), and check the other sections against the final code. Step 9 pushes it with the final HEAD commit's SHA, after the commit and merge steps below have set HEAD.
3. **Stage** code changes, excluding `.reviews/`: `git add -A && git reset HEAD .reviews/`. Check `git diff --cached --name-only | grep '^\.reviews/'` returns nothing; unstage anything it lists.
   - **With workstreams**, W0 and every workstream are already committed (`<id>: <workstream>`, with the trailers); keep those commits and stage only what is still uncommitted (formatting, review fixes).
4. **Commit** (use a HEREDOC), without asking for approval:
   ```
   <id>: <glob title>

   - <high-level change 1>
   - <high-level change 2>
   - <high-level change 3>

   Slop-Agent-Set: <version>
   Slop-Run: <runId>
   ```
   3–6 concise bullets from the implementation summary. `<version>` is the number in `.claude/slop-agent-set.json`, alone on the trailer line; add the `Slop-Run` trailer only when unattended.
   - **With workstreams**, if step 3 staged nothing, skip this step. Otherwise commit the leftovers as `<id>: <what was done>`, with bullets taken from the record rather than one implementation summary.
5. **Merge the base branch** (`baseBranch` from `get_board`), so conflicts are resolved by the agent that wrote the change: `git fetch origin <base> && git merge origin/<base>`. Skip if already up to date.
   - On conflicts, resolve them keeping both sides' intent. The plan, the context file and `git log origin/<base>` show what the other change meant.
   - **Unattended:** resolve without asking. Record what was resolved and how in the merge commit message and as an `Assumptions` attachment. If a conflict can't be resolved with confidence (a real clash of behaviour), `git merge --abort` and call `report_failure` with "Merge conflict with <base> in <files> needs a person" instead of guessing.
   - **Interactive:** show the developer the conflicting hunks with a proposed resolution and ask before committing.
   - Commit the merge as `<id>: Merge <base>` with the `Slop-Agent-Set` trailer (and the `Slop-Run` trailer if unattended).
6. **Full checks**: run the board's full checks once on the merged result (or the fast checks where its build doc leaves full checks to CI). If something fails, hand it to the implementer, re-run the failed check, note it in the review document and commit the fix as `<id>: <what was fixed>`.
7. **Local review:** push `.reviews/<id>-review.md` followed by `.reviews/<id>-tests.md` as one artifact: `put_artifact(id, kind: 'local_review', content, commitSha: <HEAD sha>, reviewStats: { riskTier, reviewRounds, maxReviewRounds, testFailRounds })`, with the run ID if unattended. `reviewStats` gives the risk tier, the Phase 5 rounds run and allowed, and how many Phase 4 FAIL → fix loops there were. Slop stores it verbatim and shows it under the card's local review icon.
8. **Learnings:** extract what a developer working on related code should know, from the implementation summary, review document and test report:
   Learning types are only `gotcha`, `pattern`, `agent-behaviour` and `fact`; there is no `decision` type. Choices made in the work (with rejected alternatives) belong in the record's `## Decisions` section, which slop extracts as the glob's "choices"; learnings are guidance for future work.

   - `gotcha` — an unexpected issue and how it was resolved;
   - `pattern` — a new pattern future work should follow;
   - `agent-behaviour` — something an instruction would have prevented or should keep doing: a review finding the implementer should never have produced, a test pass that failed because of how the code was written, a plan that needed heavy amendment, and above all **any time the developer corrected you or a sub-agent** in the session (quote the correction). Name the agent concerned.

   - `fact` — how the system is now, after this glob changed architecture or operations (new or moved modules, tables, services, data flows, deploy or ops steps). Submit one per change, stating the new description so it can replace the outdated one, with evidence naming the files and the commit, and suggestedTarget the matching architecture or operations document. Skip it when nothing of the kind changed.
   - **After a fanned-out run**, submit one `agent-behaviour` learning (agent: orchestrator or investigator; suggestedTarget `risk_and_size`) when the cut itself was wrong: two workstreams that should have been one (they conflicted at integration), a file that needed an owner and had none, or a fan-out that cost more than it saved (no real parallelism, a chain, workstreams too small). Name the glob, the workstreams and the files, taking them from the record's `workstreams` block (`conflicts`, `attempts`, `state`). A clean fan-out needs no learning. Slop also mines the same blocks across globs (`workstream_pattern`), so one occurrence is evidence, not noise.

   Skip trivial or glob-specific details; most globs produce 0–3. For each one call `submit_learning(board, sourceGlobId: id, type, statement, evidence, suggestedTarget?)`. Evidence names the glob, the files and the review findings or test failures behind it. Never edit `.sstor/docs/`, `.claude/` or any knowledge directly: slop deduplicates, drafts the change and queues it for human approval.
9. **Push and mark ready:**
   - **Unattended:** run the pre-push check (see Unattended mode), push the record (`put_artifact(id, kind: 'implementation_plan', content: <record file>, commitSha: <HEAD sha>)`, with the run ID), `git push origin <id>`, then call slop's `mark_ready` with the glob ID and your run ID; slop marks the draft PR ready through its GitHub App. Do not use `gh` or open a PR. The PR title is already `<id>: <title>`; do not change it. The run is not finished until `mark_ready` succeeds. **If `mark_ready` refuses because the branch conflicts with `<base>`, don't end the run:** the PR is still a draft and no checks will run on it. Do step 4 again (`git fetch origin <base> && git merge origin/<base>`, resolve as it describes, renumbering migrations with `scripts/dev.sh renumber-migrations` where the board's build doc says to), run the fast checks, apply the pre-push check, push, and call `mark_ready` again. If you can't resolve it with confidence, `git merge --abort` and call `report_failure`. A `mark_ready` that succeeds with a `warning` that the branch is behind `<base>` means main moved without a conflict: merge it, run the fast checks and push before you stop. Any other failure: call `report_failure`. Then **subscribe to the PR's activity** (see Auto-fix below): nothing watches the PR for you, and without the subscription failed checks never reach this session. Apply the pre-push check before every auto-fix push.
   - **Interactive:** push the record as above (no run ID), then `git push origin <id>`. Then ask the developer whether to mark the PR ready for review now. If yes, run `/finalise <requestId>` (generate the request ID with `uuidgen`; local review and learnings are already submitted for this commit, so /finalise will skip them), then call slop's `mark_ready` with the glob ID. If not, tell them to run `sstor --ready` from a terminal when they are. Never run `sstor` yourself: it is the developer's terminal tool, it drives this session, and it cannot run inside the sandbox.

## Auto-fix (watching the PR)

After `mark_ready` succeeds (unattended), your run is `watching`. Slop does not fail a quiet watcher for being idle, but it does fail one that ignores failed checks: if the PR head's checks fail (not inherited from the base) and you make no slop call or push within the board's response window (default 30 minutes), the run ends with "Auto-fix didn't respond to failed checks". So:

1. **Subscribe.** Call the `subscribe_pr_activity` tool (`mcp__claude-code-remote__subscribe_pr_activity`, load it with ToolSearch if it isn't listed) for the glob's PR (`get_glob` gives `pr.number`; the repository is the board's repo) right after `mark_ready`. Check events arrive in this session as `<wake reason="external-event">` messages. If the tool is not available, call `report_failure` with that reason instead of ending the session: a watcher that can't hear about failed checks is useless.
2. **On every event, call `get_glob` with your run ID first.** That records progress (it resets the response clock) and shows the state: stop if the run is no longer current, a human implementer is recorded, or the glob is merged. `headChecks` says whether the head's checks passed, are pending or failed, with the failing check, its step and the first error lines; `headChecks.inheritedFrom` means the base is red (see "A red base branch" above: record it, don't push).
3. **Failed checks of this glob:** reproduce the failing check's command locally, fix the cause, run the fast checks, apply the pre-push check, commit with the `Slop-Run` trailer and push. Then wait for the next event. Don't skip, disable or quarantine a test to get green.
4. **Anything else** (passed, pending, a comment you can't act on): do nothing and end your turn; there is no timeout for an idle watcher on a healthy PR. A merged or closed PR ends the watch.
5. If you cannot fix the failure, call `report_failure` with the reason rather than going quiet.

A run started by **Retry auto-fix** is a watcher from the start: the PR is already ready, so skip the phases and `mark_ready`, call `get_glob` (with the run ID), fix the failed checks as in step 3, and subscribe as in step 1.

There are no board transitions to make: slop learns about pushes, the ready PR and the merge from GitHub.

## Super mode

Supers are pairing sessions between a developer and the PO. The developer drives; you do not run the phases.

- On start (interactive only), call `pick_up` as above, then `get_context`, fetch the board knowledge, and write `.reviews/<id>-context.md` as in Phase 1 steps 1–4. plan.md is the starting intent; when the glob already has work on it, the context bundle also carries its implementation record (save it as `.reviews/<id>-record.md`), so you know why earlier choices were made.
- **plan.md:** when the glob's spec needs rewriting (the intent changed, the PO and developer agreed a new scope), read it with `get_plan` and write the new text with `save_plan(id, version, content)`, passing the plan version you read. A glob is its title and plan.md: give it a descriptive title and put the spec in the plan, never anywhere else.
- **Environment:** note the glob's `environment` from `get_glob` in the context file and tell the developer which environment the branch deploys to (or that none is set; they choose one with `sstor --glob <id> --env <name>`, `slop pick-up <id> --env <name>` or the glob view). Never change it yourself.
- Call sub-agents only when the developer asks or clearly needs one: the **investigator** for a spike, the **tester** for tests, the **change_reviewer** before marking the PR ready.
- **Implementation record:** the same record, in the same format, as every other glob (see Implementation record). Start it at the first agreement with the developer, in `.reviews/<id>-record.md`, and push it as `put_artifact(id, kind: 'implementation_plan', content, commitSha: <pushed sha>)` after each push to the glob's branch (a hook reminds you after `git push`; this is best effort). Build it from the session conversation, `.reviews/<id>-implementation.md` (each sub-agent's raw notes, as today) and `git diff origin/<base>...HEAD` (after `git fetch origin <base>`; never the local `<base>`, which can be stale). Rewrite it each time rather than appending; about 8–15 KB for a large super. Include only what the code, `git log` and the plan don't already say.
- **Deploys:** when the glob has an environment, each push deploys that commit to it (slop starts the board's deploy job; nothing runs locally). After each push, call `get_glob` and tell the developer the state of the push's deploy from its `deploys` (newest first): queued behind another deploy, deploying, live, or failed with its error and log link. The push's deploy can take a few seconds to appear; check once more if it isn't there yet, then move on. Without an environment, say nothing deploys.
- **One super at a time:** never create a super from inside a super. Keep related work in this super and land finished pieces with **Merge and continue** (the developer presses it, on the board or with `slop merge --continue`, once the PR is ready for review and the implementation record is at its head). Before they do, push the implementation record for the head; once the merge is observed, merge `<base>` back into the branch before the next push, so the next draft PR shows only new work.
- **Other work, now:** if the developer wants unrelated work started now, don't switch this worktree or branch. Create the glob (a sub or same) with a handover in its plan (what was found, where, and what to do), and tell the developer to start it in its own session with `sstor --glob <id>`.
- **Several globs at once:** before creating them, check whether their plans name the same files or functions. If they do, fold them into one glob, or make the later one start after the earlier one: pass `after: [<id>]` with a `reason` naming the file or symbol to `create_glob` (`slop new --after <id>`, or `update_glob` with `after` while it hasn't started). A sub then waits in Planning, with no branch or run, until the earlier glob merges and starts by itself on the new main; a same is refused Start until then (a person can pick it up with a warning, or Start now). Don't write "start only after sXtY" in a plan: nothing enforces it. Globs that would both change a path the board's merge policy marks exclusive (the board's knowledge, e.g. a migrations directory) are held for each other automatically when the plan names that path or a migration, so don't add `after` for those alone. Never tell a glob to "include the minimal part" of a sibling's fix that is still in progress.
- **Red base branch:** fix it in exactly one place. Check `git log origin/<base>` and the open globs first, make the fix in one glob, and don't create or start other globs on the broken base until that fix has merged.
- **Ready for review:** run the change_reviewer, then `/finalise <requestId>` followed by `mark_ready` with the glob ID (or the developer runs `sstor --ready` from a terminal, which sends `/finalise` to this session itself). Never run `sstor` yourself. Never mark the PR ready without finalising.
- **Commits** use `<id>: <title>` with bullets, as in Phase 6. Push only the glob's branch.

---

## Review-only workflow (`mode = review`)

The input is a **glob ID** or a **commit SHA**. Do **not** modify any code.

### Step 1: Context

- **Glob ID** (matches `s<digits><letter><digits>`):
  1. `get_glob(id)` and `get_context(id)`, and fetch the board knowledge (see Board knowledge).
  2. `git fetch origin <id> <base>` and review `origin/<base>...origin/<id>`. If the branch does not exist (already merged and deleted), find the squash commit with `git log origin/<base> --grep='^<id>: '` and review that commit instead.
  3. Write `.reviews/<id>-context.md` with the glob details, plan.md and the commit summary.
- **Commit SHA** (hex string):
  1. Verify it exists locally with `git cat-file -t <sha>`. If not, **stop and report the error**.
  2. Use `id = review-<short-sha>` (first 8 chars).
  3. Write `.reviews/<id>-context.md` from `git show --stat <sha>`. If the commit message starts with a glob ID, also fetch that glob's context. Fetch the board knowledge for the board in `.sstor/sstor.conf` (`SLOP_BOARD`).

### Step 2: Code review

Invoke the **change_reviewer** in `standalone_review` mode with the context, the diff to review, every board doc whose audience includes the change_reviewer, the board's build doc, the base branch and the server URL if any. It writes `.reviews/<id>-review.md` and also runs the build, test, lint and dependency checks from the board's build doc.

### Step 3: Report

- When keyed by a glob, push the review with `put_artifact(id, kind: 'local_review', content, commitSha)`.
- Summarise for the developer: in-scope items and suggestions, build/test/lint results, dependency warnings, and the verdict (APPROVED / CHANGES_REQUIRED).

---

## Error handling

If a phase fails: log the details, call `report_failure(id, reason)` (with the run ID if unattended) when the glob cannot be finished, and tell the developer what failed and where. Slop shows the glob as failed; there is nothing else to reset.

## Communication style

- Report brief progress at each phase transition (e.g. "Phase 2 complete. Proceeding to implementation.").
- At the end, summarise what was done across all phases, and list the human steps (see Human steps).
- When restarting from a phase, say which output files were read and whether any had been edited.

## Board rules

### CI failing after local checks passed

When CI fails on a commit whose local checks passed (Phase 6 full checks, a local review, or a routine's push or auto-fix push), compare it with the base branch before changing anything:

- Check CI on `origin/<base>` at the commit you merged (`git log origin/<base> -1` after `git fetch origin <base>`). If the same check fails there, the failure is inherited from a red base. Don't fix it in this glob unless it is the one glob fixing the base (see Red base branch under Super mode). Record "inherited from red `<base>` at `<sha>`" in the review document, or in an `Assumptions` attachment if unattended.
- Checks that run only on PRs (the sub-gate, which runs eslint) never fail on `<base>`. An error already merged to `<base>` shows up first on PRs, and slop reports it with `failedChecks.inherited: false`. Before fixing a failed check as the glob's own, run `git diff origin/<base>...HEAD -- <failing file>`. If the glob doesn't touch that file, the error is `<base>`'s. Fix it once, in one glob (check the open globs first), and say in the implementation record that it fixes `<base>`'s error. In a routine's auto-fix, respond to the failed check either way, by fixing it or by recording it. Don't go quiet.
- If `<base>` is green and the glob changed the failing file, the failure is the glob's own. Find the CI job's command, run that exact command locally, fix the failure, and say in the review document why the local checks missed it.
- If CI runs a check that the board's build doc does not list, or runs it differently (other flags, other environment), submit a `gotcha` learning that names the check, so the build doc can be corrected.

In s15b91, sub-gate Lint failed at `apps/server/test/base-checks.test.ts:193` (`no-unsafe-assignment` on `expect.stringContaining`, from s15f124) with `failedChecks.inherited=false`, but the file was identical on `origin/main`. Routine run 31a2bbcb didn't respond and failed with "Auto-fix didn't respond to failed checks". The fix was 16ea614, using `as unknown` (the pattern in `aws-sso.test.ts:69`).

### Overlapping side globs

In every mode, not only in supers, check for overlap before creating side globs (several at once, or one while others are in flight):

- Compare the files and functions each new glob's summary names with the other new globs' summaries. Also compare them with the branches of in-flight globs (`git diff origin/<base>...origin/<id>` after `git fetch`).
- If two would edit the same code, fold them into one glob. Otherwise make the later one wait with `after: [<id>]`, as the catalog describes. Don't start it until that glob has merged.
- Noticing that two globs "touch the same code" is the signal to apply this rule. Don't create them side by side anyway.
- Don't convert a waiting glob to a sub with `update_glob` while the glob it waits for is still open. Slop starts a routine run on the new sub straight away and ignores any "start only after X merges" in its summary. Keep it a same until that glob has merged, then convert it.

In s15f11, s15f14 was in planning with "Start only after s15t18 has merged" in its summary. It was converted to a sub on 2026-10-08 at 15:55. Slop queued routine run d124783b immediately, while s15t18 was still open with failing checks.

**Merge hotspot: `apps/web/src/components/glob-dialog.tsx`.** Most glob-view features and fixes edit this file, and several are often in flight at once.

- A glob that changes it records `overlaps` with every other open glob that changes it, so their merges are ordered. Find them from the open globs' branches (`git diff --name-only origin/<base>...origin/<id>`), not from guesses about related work.
- A long-lived same that edits it merges `<base>` and pushes again right before a person presses Merge, not only when it was last confirmed clean.

In s15f88 (PR #289) on 2026-10-13, the branch conflicted with main in `glob-dialog.tsx` four times: after s15f99 (15:53), s15t102 (16:26), s15t104 (16:32) and s15f96 (17:13). Its overlaps named s15b58, s15b60 and s15b61, but none of the globs that actually conflicted. The last conflict landed six minutes after the branch was confirmed clean, and the Merge press failed (s15b70).

### Routine runs

Routine runs too often end with a person starting the run again or taking it over, often within the first hour. To make each unattended run either finish or hand over cleanly:

- **Check the Slop tools first.** If neither the `mcp__slop__*` nor the `mcp__claude_ai_Slop__*` tools are in the session, you can't call `get_glob` or `report_failure`. Don't work around it: don't try the `slop` CLI, curl or the phases. Say in your final message that the Slop connector is missing, with the glob ID and run ID, and stop. Slop fails such a run after 5 minutes. In s15f20 a run started without the connector and sat Queued for 14 minutes.
  - If the connector fails to connect with a 5xx (e.g. `502 CLIENT_HTTP_NOT_IMPLEMENTED`), slop is probably restarting: each merge to main triggers a deploy that restarts slop's single server for a minute or so, and several subs merging together can line restarts up with a new run's start. Retry `get_glob` every 30 seconds or so for about two minutes before giving up. In s15t77, run 53841fdd got a 502 at 01:01 and stopped without calling any slop tool; three merges had triggered deploys at 00:56–00:59, and slop answered normally by 01:04:55.
- **Install dependencies before any check.** A routine's checkout has no `node_modules`, and corepack can't fetch pnpm there. Install pnpm with npm at the version the repo pins (`packageManager` in `package.json`): `npm i pnpm@<version> --prefix <dir>`, then run `<dir>/node_modules/.bin/pnpm install --frozen-lockfile` before the first type check, lint or test. In s15f38 (run 2a863870), tsc and eslint failed with missing modules until pnpm was installed this way.
- **Leave a trail early.** Upload the Phase 2 plan as soon as it exists. Add an `Assumptions` attachment before Phase 3. A restarted run or a person can then resume with `--from` instead of starting from nothing.
- **Run the tester and change_reviewer sub-agents.** Being unattended is not a reason to skip phases. Skip Phase 4 only for low-risk work, as the catalog allows. Phase 5 always runs. A self-review against the plan never replaces either phase, and never mark the PR ready on one. In s15f88, run 94892437 skipped both phases and marked PR #289 ready on a self-review. The first review round, run later, found 4 in-scope items, which were fixed in 97dc26e. Among them were a mislabelled "Discard & back to Planning" action on a same and a leftover `MERGE_WAIT_LABELS` table that contradicted the plan.
- **Don't mint new identifier schemes on an assumption.** An ID letter, prefix or URL shape spreads into plans, records, KB sources, search and commit messages, and is costly to undo. When wrapping or migrating an entity, reuse its existing scheme. If an assumption still introduces or changes a scheme, list it first in the `Assumptions` attachment, so a person can overturn it before it spreads. In s15f36, run 22d6ea09 assumed decision globs would use a new ID letter `d`; the developer kept `k`, and a second run had to rework `ids.ts`, `decision-glob.ts`, the backfill and about 15 test files.
- **Merge `<base>` again right before the push.** `<base>` often moves while a run implements: one run's branch was cut 17 seconds before another glob merged a migration with the same number. The run then pushed without merging `<base>`, and its PR conflicted in 9 files.
  - Run `git fetch origin <base> && git merge origin/<base>` immediately before the Phase 6 push, after the full checks and learnings, not only at step 4.
  - Resolve conflicts as in Phase 6 step 4 and the Merge conflicts section. If new commits came in, re-run the fast checks.
  - Never push or call `mark_ready` on a branch that is missing commits from `origin/<base>`.
  - If the change adds a Drizzle migration, compare its number with the latest migration on `<base>` after the merge. If `<base>` already uses that number or a higher one, renumber yours to come after `<base>`'s latest with `scripts/dev.sh renumber-migrations origin/<base>`, and re-run the migration checks.
- **Ship default-only migrations.** The routine environment's permission check blocks a migration that UPDATEs every board's existing values (for example, raising `sub_max_changed_lines` on all boards) as a change to shared data. Change only the column default. Don't add the UPDATE, and don't look for another way round the check. Leave the data update to a person: put the exact statement under the record's `## Open items`. In s15f48, appending `UPDATE "boards" SET sub_max_changed_lines …` to migration 0039 was denied, and the migration shipped default-only.
- **When the sandbox blocks the agent-set refresh or the upload link.** The auto mode classifier can refuse writes to `.claude/` files from `get_agent_set` ("[Self-Modification]"), and the egress proxy blocks the host of `artifact_upload_url`'s link (`curl: (56) CONNECT tunnel failed, response 403`). Both are known; don't retry, don't bypass the sandbox, and don't submit a learning repeating them.
  - Skip the refresh and carry on with the agent set already loaded. Note in the `Assumptions` attachment that the refresh was skipped, with both versions.
  - Send records with inline `put_artifact`, and check the stored size as under Uploading artifacts.
- **Checks failing after slop updates the branch** (it merged `<base>` or re-ran checks). First rule out an inherited failure as the catalog describes. If it is not inherited, the failure comes from the merge with `<base>`.
  - Fetch the branch again (`git fetch origin <id> && git checkout -B <id> origin/<id>`).
  - Run the failing check's exact CI command locally.
  - Fix it in this glob, and push after the pre-push check.
  - Don't end the run with the checks still red.
- **Never end a run silently.** If you can't finish, call `report_failure` with:
  - the phase reached;
  - the failing check or blocker, with its first error;
  - what you tried.

  The person who picks it up should not have to start again to find out.
- **Submit an `agent-behaviour` learning** when a run needs a person, naming what would have let it finish.

### Super mode: land strands early

Conflicts grow with how long a super's branch lives and how much it overlaps `<base>`. Don't let finished strands pile up on one branch:

- When a strand is finished, tested and reviewed, tell the developer it is ready to land with **Merge and continue** before starting the next one. Don't hold it back to land with later strands.
- While a strand can't land yet, merge `<base>` into the branch after every push (`git fetch origin <base> && git merge origin/<base>`), not only before marking ready. Resolve conflicts as in Phase 6 step 4, re-run the fast checks, and renumber any Drizzle migration that `<base>` has overtaken (see Routine runs).
- After each merge, check that tests which merged cleanly still typecheck. Clean-merging files can still be broken.

In one super, five strands (about 25k lines) stayed on one branch for a day while seven globs merged to `<base>`. The merge afterwards left 8 conflicted files and 4 test files that no longer typechecked, and four migrations had to be renumbered by hand. Two of the strands had been ready to land that morning.

### Merge conflicts when merging the base branch

Purely additive conflicts are yours to resolve, even in an interactive session. Don't stop to ask the developer about them. They are conflicts where both sides added different things:

- imports;
- interface or type members, including `Omit<…>` key lists;
- methods, including methods on test fakes such as a fake `CodeHost`;
- settings or defaults entries;
- list entries;
- separate pieces of code that both sides added to the same function or route block;
- Drizzle migrations that `<base>` has overtaken (see **Migrations** below).

To resolve them:

- Keep both sides.
- When both sides added code to the same block, reuse the variables the other side already declares, such as a loaded record or the viewer. Don't declare them a second time.
- Run the type check and the tests on the merged result. They must pass before you commit the merge.
- For migrations, check that there is no drizzle drift.
- List what you resolved in the merge commit message.

When both sides changed the same logic differently, the conflict is not additive. Stop and don't pick a side. In an interactive session, ask the developer. In a routine, `git merge --abort` and call `report_failure`.

In s15f8, two merges of main conflicted only in additive ways. Keeping both sides gave fully passing tests (530/184 and 626/194) and no drizzle drift. The conflicts were in:

- `github/client.ts` and `main.ts` imports;
- the `ports.ts` Omit list;
- `board-service.ts` settings and `memory-store.ts` defaults;
- the fake `CodeHost`s in the server tests;
- the drizzle journal and snapshots.

Main can move again between the pre-push merge and `mark_ready`. In s15f102, the first `mark_ready` was refused (`invalid_transition`) for a conflict in `apps/server/src/http/app.ts`, in the imports and the `/api/me` block, where both sides had added code. Merging again and keeping both sides resolved it: the import lists were combined, and the branch's stalled count sat beside main's `yourTurn` and reused main's `stored` and `viewer`.

**When `<base>` reformatted or restructured a file you also edit** (re-indentation, sections wrapped in new components, Prettier rewrites). This is not a clash of logic, but don't resolve it hunk by hunk:

1. Take `<base>`'s version: `git checkout --theirs <file>`.
2. Re-apply your branch's own change, read from `git diff $(git merge-base HEAD origin/<base>) HEAD -- <file>`, using whitespace-tolerant replacements.
3. Check that every identifier your change removed (old imports, tables) is gone from the file.
4. Run the type check and the tests before committing the merge.

In s15f88, main reformatted or restructured `apps/web/src/components/glob-dialog.tsx` in three merges (cc0a3e3, c461c49, 45d347b). The hunk-by-hunk zdiff3 output for the first was over 30 KB of conflict text. Each time, taking main's file and re-applying the branch's ~35-line diff by script was clean on the first try (web vitest 282, 304 and 319 passing).

**Migrations.** When `<base>` and your branch both added a migration with the same number, the drizzle journal and snapshot conflict (the snapshot as add/add). Don't merge those files by hand, and don't rename by hand:

1. Take `<base>`'s versions: `git checkout origin/<base> -- apps/server/drizzle/meta/_journal.json apps/server/drizzle/meta/<NNNN>_snapshot.json`. This also clears conflict markers; a snapshot left with markers makes the script's drift check fail with `Unexpected token '<', "<<<<<<< HE"... is not valid JSON`.
2. Run `scripts/dev.sh renumber-migrations origin/<base>`. It renames your migration to follow `<base>`'s latest and rebuilds the journal and snapshot. Its drift check should end with "drizzle-kit reports no schema changes".
3. If the drift check still fails:
   - *The renumbered snapshot lacks `<base>`'s schema changes:* rebuild it from `<base>`'s latest snapshot plus your own schema change. Keep the snapshot's own `id` and set `prevId` to `<base>`'s latest snapshot id.
   - *The script says "nothing to renumber":* your snapshot was committed under a number `<base>` later used. Restore all of `<base>`'s snapshot files under `apps/server/drizzle/meta/` byte for byte (`git checkout origin/<base> -- <files>`), number your snapshot after `<base>`'s latest, and make `_journal.json` match.
   - As a last resort, delete your migration SQL and its snapshot, run `drizzle-kit generate` against `<base>`'s latest snapshot, and make the regenerated SQL idempotent.

   Then re-run `drizzle-kit generate` until it prints "No schema changes".

Board 15 hit each case: s15f28 (`0033_size_check` against main's `0033_board_sessions`, renumbered cleanly), s15t42 (conflict markers left in `0032_snapshot.json`), s15f53 (the renumbered `0044_snapshot.json` lacked main's size tables; rebuilt in 444e7d8), s15f36 (three merges colliding on 0042 and 0045; "nothing to renumber") and s15f23 (regenerated as 0031).

**Long globs: merge `<base>` again after the review rounds.** `<base>` can move more than once while a glob is in review. After the last review round, and before the Phase 6 full checks, fetch and merge `origin/<base>` again. If `<base>` changed the same rules your change touches, re-check your logic against `<base>`'s version, not only the conflict markers. In s15f50, a split-rule change (s15f47) overlapped the same flag code, and the second merge collided on migration 0042.

**When `<base>` changed files under `.claude/`.** The sandbox refuses writes under `.claude/`, so `git merge origin/<base>` fails before it writes anything. Don't retry it, and don't disable the sandbox. Build the merge without touching `.claude/` in the working tree:

    tree=$(git merge-tree --write-tree HEAD origin/<base>)
    commit=$(git commit-tree "$tree" -p HEAD -p origin/<base> -m "Merge origin/<base> into <id>")
    git reset -q "$commit"                        # HEAD and the index take the merge; the working tree is untouched
    git checkout -- . ':(exclude).claude'         # bring every other file up to the merge

If `merge-tree` exits non-zero, the merge has conflicts and its output is not a usable tree: don't run `commit-tree`. In an interactive session, ask the developer to run the merge outside the sandbox (`! git merge origin/<base>`) and resolve as above; in a routine, call `report_failure`.

After a clean merge, the working tree's `.claude/` is stale. In an interactive session, ask the developer to run `! git checkout -- .claude`. Until it's clean, and always in a routine, stage explicit paths only: `git add -A` or `commit -a` would stage the stale files and revert `<base>`'s `.claude` change.

In s15f36 (merge commit 6f3148c), main changed nine `.claude/` files. The sandbox refused the implementer's `git merge`, and auto mode blocked four merge commands in a row before the implementer switched to `merge-tree`. The developer then ran `! git checkout -- .claude`.

### Handovers for subs and sames created from a super

A sub or same created from inside a super branches from `<base>`, not from the super's branch. Its handover may rely only on code that is already on `origin/<base>`.

- Before writing the handover, check that every file, function and type it names exists on `origin/<base>` (`git fetch origin <base>`, then `git grep <name> origin/<base>`).
- If the work needs the super's unmerged code, or edits files the super is changing (`git diff --name-only origin/<base>...HEAD`), don't create the side glob. Do the work in the super. Or wait until that part has landed with **Merge and continue**, and create the glob then.
- If the work depends on another glob that hasn't merged yet (it builds on that glob or feeds it), create it with `after: [<id>]`. A handover or summary that says "Starts after sXfY" always needs the matching `after`. Otherwise slop starts a routine run straight away, and that run can't proceed.

In s15f8, s15b8 was created with a handover that pointed at `kb-dedupe.ts`, `longEnoughQuote` and `KbPossibleCoverage.shortQuote`. None of these were on main yet. Its routine failed at once ("Blocked on unmerged s15f8"), and the work was folded back into s15f8.

s15f24's summary said it started after s15f21, the inbox it feeds, but it had no `after`. It was started while s15f21 was still implementing, and its run had to call `report_failure` in Phase 1.

### Writing handovers for UI and layout fixes

Don't prescribe a UI or layout change from reading the code alone. Check it in the running app before you write the handover:

- Open the page with the Chrome DevTools MCP tools and toggle the classes or styles the handover will prescribe on the live page.
- Measure the result: the element's width, whether it scrolls, whether its children overflow, and whether they are aligned. Put the before and after numbers in the handover.
- If no server is running, say in the handover that the fix is unverified.

Before prescribing a change to a line an earlier glob changed, read that glob's diff first, so its fix isn't undone. Use `git log -L <start>,<end>:<file>` or `search_changes(board, path)` to find the earlier glob.

In s15f8, the s15t10 handover told the routine to remove `items-start` from the board's list row. That was exactly the change that undid s15b3's fix, and cards overflowed again. The s15b10 handover then prescribed `w-max`, which made the board scroll horizontally. Both handovers were written from reading the code. s15b11's fix, dropping `w-max`, was measured live first. The row went from 2730 px wide and scrolling to 1681 px with no scroll, with bottoms aligned and no overflow.

### Uploading artifacts

Upload long files (the implementation record, the local review) yourself, as the catalog describes. Never hand a verbatim upload through `put_artifact` to a helper agent. A helper can store a summary or placeholder instead of the file and still report success. Its output can also be cut off partway through.

After each upload, check that the stored artifact matches the file. Compare its size with `wc -c <path>`, or its md5 with `md5sum <path>`. If they differ, upload it again directly.

In s15f8, strand 2's local review was given to helper agents twice:

- A Haiku helper stored the 57-byte placeholder "[full review and tests files combined with --- separator]" (artifact 65) and reported success. The findings pipeline then failed three times to split it.
- A Sonnet helper's output was cut off by a safety classifier, which left 16 KB of the 66 KB file (artifact 66).

Direct uploads checked by md5 matched the file (artifacts 68, 69, 76 and 77).

**When `slop put-artifact` fails in a local session.** Inside the sandbox it can fail in two ways:

- When its token needs refreshing, it fails with "could not save the slop login to the Keychain (security exited 161)". This happens even with the Cognito host in allowed_domains.
- The installed CLI may reject the kind, for example `--kind investigation`.

Don't retry it outside the sandbox. Call `artifact_upload_url`, then run `curl --data-binary @<file> '<url>'` with the slop host in allowed_domains. This route needs no Keychain access and accepts every kind. (In routines the proxy blocks that link; use inline `put_artifact` there, as under Routine runs.)

In s15t72, `slop put-artifact --kind investigation` gave "--kind must be one of implementation_plan, postplan, local_review". A later `--kind local_review` upload first hit a sandbox deny on the Cognito host, then the Keychain error. `artifact_upload_url` plus curl stored artifacts 971, 977 and 978.

### Checks that could not be run

A check that was skipped has not passed. If a fast check (lint, type check, tests) can't run, for example because a dependency is missing, don't push and don't call `mark_ready` with that check still unrun:

- Fix the environment first. Run the install command from the board's build doc, then run the check again.
- If the check still can't run, treat it as a blocker. Call `report_failure` with the check, its first error and what you tried.
- "Not checked" in a report is never a reason to go ahead with the Phase 6 push or an auto-fix push.

In s15t12, the run said "I couldn't run eslint because @eslint/js isn't installed in this environment". It still pushed b462e02 and marked PR #50 ready. CI Lint then failed with 18 errors in `apps/server/test/renumber-migrations.test.ts`.

### Choosing sub or same for new globs

Define "sub" broadly, especially early in a project. Any self-contained change is a sub if one routine can finish it in one PR and it needs no human design decision. That includes:

- bug fixes;
- UI/UX tweaks;
- follow-ups to a merged glob;
- small features in one area;
- test or doc work.

Only these are sames:

- large slices or features that span several areas;
- changes to agent instructions, or anything else that needs a human review;
- work that overlaps an open glob (see Overlapping side globs).

When you create a glob (a side glob, a follow-up or a handover from a super), pass `type: sub` for such work, or leave the type unset so intake decides. Don't pass an explicit `type: same` by default. Afterwards, check the type with `get_glob`. Intake's `validate` turns an invalid type/category combination into `same`, so a sub can silently become a same.

On board 15, intake made s15t30–s15t40 and s15b24–s15b27 subs overnight. From about 03:30 on 2026-10-09, sessions created every glob (s15f25–s15f30, s15t42–s15t44) with an explicit `type: same`, which bypassed intake. The developer asked "Why is nothing getting set as sub anymore?" and added that "at the beginning of the project it makes more sense that more stuff is sub".

### Escalating subs to sames

On this board, a concrete reason to want a human that fits none of the named criteria is still a reason to escalate. Don't push it through because it isn't on the list: call `escalate_to_same` with `criterion: 'other'`, a reason a person can act on, and the evidence. Subs with such a reason have needed a person here. Escalated ones got changes asked for or were reverted. Unescalated ones were reverted or caused bugs. The catalog's limits still apply: size alone, a plan that was followed, or "to be safe" is not a concrete reason.

s15b1 had such a reason but merged as a sub without escalation. s15b2 then reported a bug naming it.

### Oversized globs: workstreams, not splits

On this board, "more than 3 independent parts" in `risk_and_size` means the work is cut into workstreams inside one run and one PR. It does not mean a board split. This replaces the earlier rule to `split_glob` before start.

- When `oversized` / `sizeCheck` flags a glob, or plan.md clearly holds more independent parts than `risk_and_size` allows, have the investigator list the parts under `## Workstreams` in the plan file.
- Fan the implementation out across those workstreams in worktrees, and land them all on the glob's own branch and PR.
- **In a routine, `isolation: worktree` branches from main, not from the glob's branch.** The worktree lacks W0 and every earlier workstream's commits, and the implementer may be denied a `git merge` of the glob branch. Run a workstream that needs W0 (or another integrated workstream) in the main checkout, told not to commit or switch branches, and commit its work yourself as `<id>: <workstream>`, or tell its implementer to base its worktree on the glob's tip first. Only workstreams that need nothing on the glob's branch (e.g. catalog) go in worktrees.
- **From a worktree, the Write tool refuses paths in the main checkout's `.reviews/`.** Say so in each worktree brief and give the implementer an absolute scratchpad path for its summary instead of `.reviews/<id>-implementation-<workstream>.md`; copy the summary into `.reviews/` yourself when it returns.
- **Plan an integration pass.** Parallel workstreams that both touch an interface (a shared dependency's type, a trigger, a classification step) can build it in different shapes. Tell their implementers up front, and add an explicit step after integrating them that reconciles those interfaces and runs the fast checks.
- Don't call `split_glob` to keep a glob under the limit, either before it starts or in Phase 1. Don't create its parts as follow-up globs either.
- A scope cut is offered to a person only in an interactive session: if the work still looks too big as workstreams, propose the cut with `AskUserQuestion`. Unattended, don't cut scope. Carry out every workstream and record any size concern in the `Assumptions` attachment.

In s15f143 (ec8af97, bbf45b8), the orchestrator, investigator and implementer were changed to cut work into workstreams and fan out in worktrees instead of splitting globs.

In s15t228, W1 found no W0 code in its worktree (branched from main) and its `git merge --ff-only s15t228` was denied. In s15b148, W5 could not write `.reviews/s15b148-implementation-W5.md` from its worktree, and W1 and W2 built the `relationScan` dependency in different shapes, needing an integration commit (5dac2be).

### Specs that name missing infrastructure

When plan.md or the spec names infrastructure that doesn't exist (e.g. "store it via the existing upload storage port / S3"), don't build it and don't create a side glob for it:

- Propose the simplest design that meets the "Done when" lines first, such as computing the result on demand or storing a Postgres row.
- Ask the developer before going further. In a routine, take the simplest design and record it as an assumption.
- Mention the missing piece as an option the developer can choose, not as a follow-up glob.

In s15f25, the investigator found there was no object-store port. The orchestrator created s15t41 (a central S3 bucket) and chose a reports table filled by a scheduled job. The developer corrected it: "Really, all we need to do for now is export a csv file. The s3 stuff actually isn't necessary for this task." The table, migration 0032, the job and the rebuild endpoint were built and then removed, and s15t41 was deleted.

### Creating several globs that change the database

Globs created together that each extend the same table run in parallel: sharing the migrations directory only makes them overlaps, which order their merges and never hold a start. Each then invents its own column or table for the same idea, and the later ones conflict at merge.

- When a glob will add or change a database column or table, say so explicitly in its plan: "adds a migration for …", naming the table and column.
- Parts that build on the same new table or column need `after` (needs) on the glob that creates it, so they share one design. Globs that merely add unrelated migrations don't: they're overlaps, and the one merged second renumbers its migration (see Merge conflicts).

On 2026-10-09, s15f22, s15f23 and s15f24 ran at once after s15f21. Each added its own 0031 migration for the same inbox source idea: `source_ref` with integration tokens (f22), `source_ref` (f23) and a nullable `source_key` (f24). f23 and f24 then conflicted with main in 10 and 9 files and had to be moved onto f22's column by hand.

### Human steps

Anything a person must do (a rollout, a setting, an install or a decision) is a human step. Record it as one: under a `## Rollout` section in the implementation record, or as a stored step. Never leave it only as prose in a summary, or only in an attachment. This includes the data updates left to a person under Routine runs.

- For each step, give what to do, who does it, when (before merge, after deploy, …) and whether it blocks the sign-off.
- Your final report has a **Human steps** section listing every step with who, when and whether it blocks the sign-off. Write "None" when there are no steps.

In s15f78, the rollout was described only in a "Rollout script" attachment. Nobody saw it until after sign-off (s15f113).

### Reading a stalled reason

The catalog's "Keep progress moving" sets the stall thresholds and the progress calls. When `get_glob`, a handover or the board says a glob is stalled, the kind of stall says what is wrong and what to do:

- **implementing:** the run is alive but silent. Its agent is stuck or its session died. Check the session, then resume with `--from` or restart the run.
- **queued:** no session picked the run up. Open the session or restart the run.
- **provisioning:** the branch or PR setup never finished. Restart the run.
- **no step and no one on it:** nobody is moving the glob. Start it, hand it to the machine, or pick it up.

Don't read a stall as a failure of the code. It only says that no run with that ID has called slop since its last progress (s15f108).

### Pushing to a glob whose PR is already ready

When a glob was picked up again with its PR already ready (for example for a conflict, which moves it from `pr_open` to `in_progress`), any push leaves it in `in_progress` until you call `mark_ready`:

- After pushing the fix, call `mark_ready` with the glob ID (and your run ID if unattended), even though the PR is not a draft. Its "already ready" branch is what moves the glob back to `pr_open`. The board can't do this for a sub or same.
- Then call `get_glob` and check that the status is `pr_open`, not `in_progress`. Until it is, the card shows no Merge and nothing happening.

In s15f92 on 2026-10-13, the glob was picked up at 18:51 for a conflict. The fix was pushed (a9a5a40, 4d85729), but the session skipped `mark_ready` because PR #323 was already ready. The glob sat in Doing with no Merge until `mark_ready` was called at about 19:07. The developer asked: "Still not seeing the option to merge or any indication of anything happening on the card. Is this a bug?"

**A sub's `mark_ready` squash-merges straight away, at the head slop has recorded.**

- Push every commit before you call `mark_ready`.
- Before calling `mark_ready`, check that slop has recorded your push: `get_glob`'s `pr.headSha` must equal `git rev-parse HEAD` (and `git ls-remote origin <id>`). If it doesn't yet, call `get_glob` again after a short wait; don't call `mark_ready` on a stale head.
- Never push to a ready sub except to fix failed checks.
- If a merge fails with "Head branch was modified", compare `get_glob`'s `pr.headSha` with `git ls-remote origin <id>`. If they differ, slop missed the push. Push again (an empty commit is enough) so the push webhook records the real head, then call `pick_up` and `mark_ready`. Retrying `mark_ready` or Start again on its own reuses the stale head and fails the same way (bug s15b103: `readyRequested` in `packages/core/src/domain/machine.ts` reuses `glob.pr.headSha` for an already-ready PR).

This is a recurring failure: from 2026-09-16 to 2026-10-14, 4 of 45 routine runs (9%) failed with "Head branch was modified", on s15f101 and s15t152. In s15t152, routine run ddfdf665 pushed 0b61855 around the time of its `mark_ready` on b060874, and slop kept `pr.headSha=b060874`. Runs ddfdf665, 4c6a637e and a34c92e0 and a manual `mark_ready` all failed with "Head branch was modified". The empty commit 3bbd92d updated the head, and `pick_up` followed by `mark_ready` moved the glob to `pr_open`.

### Diagnosing production incidents

When a developer reports a production failure (a 5xx, an outage, missing data), don't present the first known pattern that fits as the cause. That includes the deploy restarts after a burst of merges under Routine runs.

- List the explanations that fit. Before naming one, check the evidence that tells them apart:
  - the instance's launch time and uptime, which show whether the instance was replaced or only its process restarted;
  - stack (CDK) deploys as well as app deploys;
  - whether the data is still there, for example whether `whoami` still returns the boards.
- Say what you checked and how confident you are. If the other explanations aren't ruled out yet, say so.
- Don't propose a fix, or answer "how do we prevent this", until the cause is confirmed.

In s15f88 on 2026-10-13, slopmux returned 504 at 16:41 UTC. The orchestrator blamed stacked deploy restarts from merges at 16:32–16:36 and proposed a deploy debounce. The real cause was a CDK deploy that replaced the instance at 16:36:53 with an empty data disk. It surfaced only when `whoami` returned no boards, after the developer had already asked how to prevent "this sort of crash" based on the wrong explanation.

### Reading glob attachments

`get_context` lists a glob's file attachments under `files`, each with its state. A missing file has a `note`. A stored file has a fresh `downloadUrl` (`get_artifact` adds one too).

- To see an image or other stored file, download it and then Read it: `mkdir -p .reviews/<id>-attachments && curl -sfo .reviews/<id>-attachments/<name> '<downloadUrl>'`. The link is fresh when returned, so if it has expired, call `get_context` or `get_artifact` again for a new one. `.reviews/` is never committed.
- Pass the downloaded paths to sub-agents that need them.
- Don't block on a missing file. Record the gap (the file's name and its `note`) in the context file, and in a routine also in the `Assumptions` attachment. Then carry on with what the plan and the other sources say.

In s15f84, `get_context` began returning `files`, and `get_artifact` began adding `downloadUrl` for a stored file.

### Avoiding no-progress timeouts

From 2026-09-16 to 2026-10-14, 9 of 45 routine runs (20%) ended with "Run timed out: No progress for 2 hours" (s15b4, s15b6, s15b15, s15f7, s15t7, s15t11, s15t12, s15t18). The catalog's progress calls under "Keep progress moving" only help if the run actually gets to make them:

- **Sub-agents block the main session.** While a sub-agent runs, you can't make the 10-minute `get_glob` calls. Pass the run ID to every sub-agent. Tell it to call `get_glob(id, runId)` at least every 10 minutes, and before and after any command that may run long.
- **Never let a command hang.** Run every command non-interactively and with a time limit:
  - no watch modes (`vitest run`, not `vitest`);
  - no prompts;
  - no foreground dev servers;
  - wrap long checks in `timeout`.

  A command that hangs or is killed by its timeout is a blocker. Don't wait it out or retry it in a loop.
- **Fail before the clock does.** If the run can't go on, call `report_failure` with the phase, the blocker and what you tried. Don't let the run time out: a timeout tells the next person nothing.
