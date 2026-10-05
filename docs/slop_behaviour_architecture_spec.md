# Slop — Behaviour & Architecture Spec

Oct 2, 2026 · @John

## Overview

Slop replaces a team's separate planning tool and issue tracker: it owns planning, the board, shared records and the agent system, and exposes endpoints (MCP and REST) that implementation tools pull from and push to. This document is authoritative for slop's lifecycle, contracts and rules; the sessionator document is authoritative for local command behaviour.

- **Slop** turns any input into a plan, manages globs on the board, tracks PRs, commits, builds, tests and deployments, and produces time reports.
- **Implementation** is done by Claude Code routines for subs and sames, and by sessionator (or any equivalent developer tool) for supers. Sessionator keeps workspace management (tmux, worktrees, branches); agent management moves into slop.
- **Planning has no repository access.** Slop captures intent; the implementation system investigates the code.
- **Hexagonal architecture.** A framework-free `core/` holds the glob domain, rules and prompts. Everything external (MCP, REST, GitHub, CodeBuild, storage, LLM, notifications) is an adapter behind a port. A lint rule forbids the core importing adapters.
- **Writes go through the core; reads can come straight from the store.** Every change, from any entry point, calls the same application services.

**Project profiles (genericity):** everything project-specific is per-board configuration, not code: the list of environments (each glob's environment is chosen at creation or pick-up); optional integrations (CodeBuild results, deploy tracking, ATF), whose indicators and checks only appear when enabled; sensitive paths; routine prompts; which labels apply. Anything reporting as a GitHub check run works for any project. No project's environment names, integrations or conventions are hard-coded in slop or its public repo; each board's profile and knowledge are entered in slop, and slop's own development runs as a board with a sparse profile.

## Globs

A glob is one unit of work on a board. It has a slop type (how the work flows) and a category (what the work is, for time tracking).

**IDs** are `s<board><type><n>`: `s1f1` feature, `s1t1` task, `s1b1` bug, `s1h1` hotfix, `s1k1` knowledge-base item. Each board has an atomic counter per type; creation is a conditional write, so a collision errors instead of overwriting. IDs are immutable: the letter reflects the category at creation, even if the category later changes. Hotfixes are deferred; the h type is reserved only.

**Slop types**

- **Sub:** small bug fixes and minor UI/UX tweaks. The input is the plan. Implementation starts automatically and merges to master without human review if the sub review passes.
- **Same:** standard non-pairing tasks. Planned by loading the glob with context (plan.md, meeting notes, Slack threads, designs). Triggered manually unless the input says otherwise. PRs are merged by the developer once satisfied with the reviews and results. A routine can optionally implement a same (chosen at creation or pick-up).
- **Super:** PO + developer pairing. In Doing on creation; the developer implements and marks the glob's draft PR ready for review; sessionator maintains a living postplan.

**Categories:** features are RnD; tasks and bugs are maintenance.

| Category | Sub | Same | Super |
| --- | --- | --- | --- |
| Feature (RnD) | No | Yes | Yes |
| Task (maintenance) | Yes | Yes | Yes |
| Bug (maintenance) | Yes | Yes | No |

The matrix is a core invariant. Sub-to-same conversion is always valid.

**Group** is a plain string attribute, given in the MCP message or inferred by slop from the input. Inference prefers existing group names. Names are normalised for matching; the label colour is derived from a hash of the name.

**Sign-off labels** FR (Functional Review), CR (Code Review) and QA are set to Required automatically when a glob moves to Reviewing: subs get QA, sames and supers get FR, CR and QA. After that, only humans change them. Each label has three states and carries a review checklist: **Required** (waiting for the reviewer, initially and whenever the developer resubmits), **Added** (the reviewer added checklist items for the developer to work through) and **Approved** (the reviewer is satisfied, with or without items). The reviewer either submits one or more items (Required → Added) or approves (Required or Added → Approved); the developer ticks and unticks items while the label is Added and resubmits it for review at any time, even with items unticked (Added → Required, items and ticks kept). Items are never removed, so each review round adds to the same list; once the glob is signed off they are read-only. An approved label can be re-opened (→ Required). Anyone on the board may act on a label for now. The card shows each label as a coloured chip (Required outlined brown, Added clay, Approved green) with a popover for a quick Approve or Re-open; the glob view holds the checklists. The glob lights up when its last label is approved. Who did what and when goes in the event log.

Labels only appear on a card once the glob is merged (Required, Added or Approved).

**Artifacts** (plan.md, postplan.md, local review.md, context attachments) live in slop as versioned records with glob ID, type, version, commit SHA where relevant, and provenance (human, sessionator, or model + prompt version). Binaries go to S3; the glob holds references.

**Implementation plan:** the implementing tool (routine, sessionator or equivalent) generates an implementation plan as an artifact on the glob, with an amendments section. Edits to plan.md after triggering are allowed; the run simply continues, with no lock or special state.

## Board and lifecycle

Globs move through four lists: Planning, Doing, Reviewing, Signed Off. Reviewing means merged to master and awaiting human sign-off; PR review happens while a glob is in Doing.

|  | Planning | Doing | Reviewing | Signed Off |
| --- | --- | --- | --- | --- |
| Sub | Skipped | Automatic on creation; routine starts | Automatic when sub review passes and it merges; QA Required | Automatic when all labels are Approved |
| Same | Starts here | Start button or pick-up (glob view or sstor); a routine runs if chosen | Automatic when the developer merges the PR; FR, CR, QA Required | Automatic when all labels are Approved |
| Super | Skipped | On creation | Automatic when the developer merges the PR; FR, CR, QA Required | Automatic when all labels are Approved |

**Moves** happen through buttons in the glob view, enabled only where a manual move makes sense. Everything else is driven by events, including human events outside slop (a developer merging a PR in GitHub). Manual and automated moves go through the same core transitions.

**Failures:** a failed or timed-out run stays in Doing with a failed flag. No automatic retry.

**Sub to same conversion** happens when the sub review flags the change; the branch, work and PR are kept, and the developer merges it once satisfied. A sub whose rebase hits a conflict does not convert: it stays in Doing as failed, and the planner finds a human implementer.

**Start again** returns a glob to its starting status (sub: Doing with a new routine run; same: Planning; super: Doing with its creator), closing its PR and deleting its branch (a sub or super is re-provisioned at once; a same gets a new branch when it next starts); see the transition table for everything it resets. **Delete** shows a strong warning, then removes the glob, its branch, its S3 artifacts and its events (so its time leaves the reports). No archive.

**Signed Off** globs drop off the board after 2 weeks (computed on display) and remain in a paginated list view.

**Card display:** small visual differences per slop type with filtering; group label; FR/CR/QA switches; artifact icons (plan, postplan, commits, local review, remote review, tests, deployments) that open the relevant view; planner shown until a human implementer picks it up, then the implementer; failed flag; deployment indicators for release environments; a colour that shifts from neutral to amber to red as the glob passes 2 calendar days in Doing without merging, plus a "PR still draft" indicator.

**Routine run on the card:** a run indicator shows the current run's state (queued, active, watching, ended: completed, failed or superseded), its routine owner and triggerer, when it started and when it last made progress (its last slop call or push). The glob view lists the run history and, for the current run, an *Open in Claude* link to the cloud session at claude.ai/code and a copyable *Continue locally* command (`sstor --teleport <id>`). Slop stores each run's cloud session ID and URL from the routine fire response (to verify in slice 4; fallback: the routine reports them on its first MCP call). Only the routine owner can teleport into a run; for everyone else the link is view-only.

**Live updates:** every save publishes a small hint (`kind`, `globId`, `version`) through the notifier port. The server streams it to every open board over server-sent events; the board refetches that glob (unless it already holds that version), and reloads the whole board after reconnecting. The exception is `glob.artifacts`, sent when an artifact is added: artifacts are versioned on their own and the card reads them from the artifact records, so adding one doesn't bump the glob's version (which would turn concurrent client writes into conflicts), and its hint carries no version; the board always refetches that glob, and any open artifact view. Each glob carries a version number and every write is conditional on it, so simultaneous moves resolve cleanly.

**Changing type, category and group:** category and group can be changed at any time (the type/category matrix still applies; IDs keep their original letter). Type changes are limited to what the current execution mode supports: sub to same at any point before merge (the developer then merges instead of auto-merge); same and super interchangeably only in `in_progress` or `pr_open` with no run queued, active or watching, since both are human-driven there; same to sub only from `planning`, which is a transition (row 26) and starts work. No other type changes are allowed, and apart from row 26 a type change never moves the glob. Reports use the category at report time.

## State machine

The core tracks a status per glob; the four lists are a projection of it, and every move, manual or automatic, is one of the transitions below.

| Status | List | Meaning |
| --- | --- | --- |
| `planning` | Planning | Same being planned; nothing running |
| `implementing` | Doing | A routine run is working on the glob |
| `in_progress` | Doing | A human is implementing (supers, or a picked-up glob) |
| `failed` | Doing | A run failed, timed out, hit a merge conflict, or its PR was closed unmerged |
| `pr_open` | Doing | The PR is ready for review, awaiting the sub gate or the developer's merge |
| `merging` | Doing | Slop is rebasing, rerunning checks and squash-merging |
| `reviewing` | Reviewing | On master, awaiting FR/CR/QA sign-off |
| `signed_off` | Signed Off | All required labels Approved |

**Transitions**

| # | From | To | Trigger | Types | Guard | Side effects |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | — | `planning` | Create (board, MCP or sstor) | Same | Valid type/category | Intake; planner recorded. No branch yet: it is provisioned when the glob enters Doing |
| 2 | — | `implementing` | Create | Sub | Valid type/category | Provision branch, empty first commit and draft PR with labels; queue a routine run for the triggerer (fallback: default routine owner) |
| 3 | — | `in_progress` | Create (`sstor --new --super` or MCP) | Super | Valid type/category | Provision as 2; implementer = creator |
| 4 | — | `implementing` | Create with `autoTrigger` | Same | Instruction explicit | As 2 |
| 5 | `planning` | `implementing` | Start (button or `start_glob`) | Same | — | Provision as 2; queue a routine run |
| 6 | `planning`, `failed` | `in_progress` | Pick up | All | No run active or watching | Implementer = picker; provision as 2 if the glob has no branch yet; a queued run is cancelled together with its launch job |
| 7 | `pr_open` | `pr_open` | Pick up | All | No run active or watching | Implementer = picker; status unchanged; a queued run is cancelled with its launch job |
| 8 | `in_progress`, `pr_open` | unchanged | Pick up by the current implementer | All | — | No-op (idempotent) |
| 9 | `in_progress`, `pr_open` | unchanged | Pick up by someone else | All | No run active or watching | Implementer changes; a queued run is cancelled with its launch job |
| 10 | `implementing`, `pr_open` | `in_progress` (from `implementing`) or unchanged | Take over (`pick_up` with `takeOver`) | Sub, same | Run queued, active or watching | Run superseded (a queued run's launch job is cancelled); generation increased; implementer = picker |
| 11 | `implementing`, `in_progress` | `pr_open` | Draft PR marked ready for review | All | PR head branch = glob ID | Record PR; an active run moves to watching |
| 12 | `pr_open` | `merging` | Sub gate passes on the current head commit | Sub | Type is still sub | Slop squash-merges |
| 13 | `pr_open` | `pr_open` | Sub gate flags the change | Sub | — | Type becomes same; the developer now merges |
| 14 | `pr_open` | `merging` | Merge button on the glob | Same, super | Checks pass on the current head | Slop squash-merges |
| 15 | `planning`, `merging`, `pr_open`, `in_progress`, `implementing`, `failed` | `reviewing` | Merge observed (slop's own merge response or the `merged` event, whichever arrives first; the second is a no-op) | All | Glob's PR merged | Labels set Required (sub: QA; same/super: FR, CR, QA); run ended |
| 16 | `merging` | `failed` | Conflict, or checks fail after update | All | No merge observed | Failure reason recorded |
| 17 | `implementing` | `failed` | `report_failure` with the current run ID, or run timeout | Sub, same | Run ID is current | Run failed; reason recorded |
| 18 | `in_progress` | `failed` | `report_failure` from an interactive session | All | — | Reason recorded |
| 19 | `pr_open` | `failed` | PR closed without merging | All | — | Run ended; reason recorded |
| 20 | `failed` | `implementing` | Re-trigger | Sub, same | No run queued, active or watching | Generation increased; human implementer cleared; closed PR reopened (or a new draft PR opened if the branch was deleted); new run queued on the existing branch |
| 21 | `reviewing` | `signed_off` | Last required label approved | All | All required labels Approved | Signed-off date recorded |
| 22 | `signed_off` | `reviewing` | An approved label re-opened (→ Required) | All | — | Signed-off date cleared; checklist items kept (re-opening while `reviewing` only changes the label) |
| 23 | Any except `reviewing`, `signed_off` | `implementing` (sub), `planning` (same), `in_progress` (super) | Start again | All | — | Generation increased; current run superseded; pending jobs of the old generation cancelled; human implementer cleared (super: reset to the creator); PR closed and branch deleted; a sub or super is re-provisioned at once, a same when it next enters Doing; sub queues a new run |
| 24 | Any | deleted | Delete, after warning | All | — | Run superseded; pending jobs cancelled; branch, PR, S3 artifacts and events deleted |
| 25 | `pr_open` | `pr_open` | `report_failure` with the current run ID, or watching timeout | Sub, same | Run is watching; run ID is current | Run failed and auto-fix ended; failure shown on the card; status unchanged |
| 26 | `planning` | `implementing` | Type changed from same to sub | Same | Valid category for sub | Type becomes sub; provision as 2; queue a routine run (acts as Start) |
| 27 | `reviewing` | unchanged | Reviewer submits checklist items on a label | All | Label Required; at least one item | Label → Added; items recorded with who added them and when |
| 28 | `reviewing` | unchanged, or `signed_off` (row 21) | Reviewer approves a label | All | Label Required or Added | Label → Approved, with or without items, ticked or not |
| 29 | `reviewing` | unchanged | Developer ticks or unticks a checklist item | All | Label Added | Item done flag, who ticked it and when |
| 30 | `reviewing` | unchanged | Developer resubmits a label for review | All | Label Added | Label → Required; items and ticks kept, unticked ones included |

**Rules across all transitions**

- Every command and event loads the glob's current state and is checked against this table; anything not listed is refused.
- Writes are conditional on the glob's version, so simultaneous events resolve cleanly.
- Changing type, category or group is not a transition: it never moves the glob, only changes which rows apply next.
- Draft PRs are recorded on the glob without changing status.
- Time attribution follows the planner until a human implementer picks the glob up, then the implementer; triggeredBy only chooses whose routine runs.

**Provisioning and reliability**

- **Provisioning:** a glob gets its branch, empty first commit and draft PR when it enters Doing: at creation for subs, supers and auto-started sames; on Start or Pick up for a same in Planning. Planning stays free of GitHub, and nobody can work on a branch before the glob is started or picked up. Provisioning is queued before any routine run, and a routine is only fired once its glob is provisioned. `create_glob` takes an idempotency key and returns once provisioning has been attempted (`provisioning: none` for a same in Planning). If GitHub fails, the glob is still saved with a provisioning-failed flag and the response returns its ID and provisioning status, so a retry with the same key never creates a second glob; a background job retries, and sstor reports the problem instead of checking anything out.
- **Routine runs** have their own lifecycle, independent of the glob's status: queued → active (the routine has called slop) → watching (its PR is ready and auto-fix is running) → ended (completed, failed, superseded). A run ends when the glob is merged, picked up, taken over, started again, closed or deleted. Each run has a run ID, passed in the fire payload and returned with its artifacts and `report_failure`; results carrying a superseded run ID are recorded but ignored.
- **Generation:** each glob has a generation number, increased by re-trigger, take over and start again. Every outbox job carries the generation it was queued under and is re-checked before it executes; jobs from an older generation are cancelled.
- **Commit-specific results:** check, review, build and ATF results are tied to a commit SHA; results for commits that are no longer the branch head do not drive transitions.
- **Deduplication:** GitHub deliveries are deduplicated by delivery ID, other webhooks by their source event ID. Incoming events are applied against the glob's current version inside the handler; only client writes carry an expected version.
- **Outbox:** side effects (firing routines, GitHub provisioning, CodeBuild deploys) are written to an outbox table in the same transaction as the state change and executed by the job queue with retries and idempotency keys, so partial failures resume.
- **Routine ownership:** slop stores `triggeredBy` and `routineOwner` separately. `triggeredBy` chooses whose routine runs; commits, PRs and Claude usage belong to the routine owner (e.g. the board's default routine owner on fallback); time follows the planner until a human picks the glob up.
- **Routines and humans (cooperative):** pick-up is refused while a run is active or watching; Take over supersedes it. Routines check the glob through the MCP before every push and stop if their run is superseded, a human implementer is recorded, or the glob is merged. Because the check and the push are separate operations, a late push is still possible: routine commits carry a `Slop-Run: <runId>` trailer, and a push from a superseded run is flagged on the glob so the developer can revert it. Slop deletes any glob branch recreated by a late push after merge.

**Flags shown alongside status** (not states): failure reason, ATF failure, deployment state per environment, aging colour, "PR still draft".

**Domain events** written to the log: `GlobCreated`, `FieldsChanged`, `StatusChanged` (from, to, actor), `RunTriggered`, `RunFailed`, `BranchCreated`, `CommitPushed`, `PROpened`, `PRReadyForReview`, `PRClosed`, `SubReviewCompleted`, `ReviewReceived`, `Merged`, `MergeFailed`, `LabelChanged`, `LabelItemTicked`, `PickedUp`, `ArtifactAdded`, `DeployStarted`, `BuildCompleted`, `ATFCompleted`, `Deployed`, `GlobDeleted`.

**Run failure detection (row 17)** uses both mechanisms: the agent calls `report_failure` when it recognises a failure, and slop fails a run that shows no progress (no slop call or push) for a per-board number of hours (default 2), or that has not marked its PR ready within a longer per-board limit (default 8 hours). A watching run (auto-fix) can also fail or time out: the glob stays in pr\_open and the card shows the run failure (row 25). Watching ends when the run ends.

## Contracts

Slop has four kinds of interface: MCP tools for agents and the Claude app, REST for the board, inbound webhooks and events, and outbound calls. All of them call the same application services and enforce the same state machine and role rules.

**Common rules**

- **Auth:** the board uses a server-side session after Cognito login; MCP and REST accept Cognito access tokens, so every call acts as a real person with their board role; webhooks and ingest are verified by per-integration secrets or signatures.
- **Versions:** every client write to a glob carries the version it read; a stale version returns a conflict with the current glob. Exceptions: put\_artifact and report\_failure are append-style records guarded by run ID (for routines) rather than glob version, since artifacts are versioned on their own and a failure report must not be lost to a concurrent edit.
- **Errors:** `forbidden` (role), `not_found`, `version_conflict`, `invalid_transition` (with current status and allowed actions), `invalid_combination` (type/category matrix).

**MCP tools**

| Tool | Input | Returns | Used by |
| --- | --- | --- | --- |
| `whoami` | — | user, boards, role per board | Sessionator, Claude app |
| `create_glob` | board, input, idempotencyKey; optional title, summary, type, category, group, environment, links, autoTrigger | `{ id, version, branch, provisioning: none \| ok \| failed, status, type, category, group, environment, summary }` (same glob returned for a repeated key) | All |
| `get_glob` | id | full glob: status, version, generation, fields, labels, PR, current run (state, runId, owner, triggeredBy, started, last progress, cloud session ID and URL), run history, flags, artifact list | All |
| `get_context` | id | assembled context bundle with citations | Routines, sessionator |
| `list_globs` | board; optional status, type, group, person | glob summaries | Claude app |
| `update_glob` | id, version; optional title, summary, type, category, group, environment | updated glob | All |
| `attach` | id, version, text or link, label | attachment reference | All |
| `ingest_text` | board, text, title; optional glob id | communication id | Claude app |
| `start_glob` | id, version | updated glob (same: `planning` → `implementing`) | Claude app |
| `pick_up` | id, version; optional takeOver | updated glob, or `run_active` if a run is active or watching and takeOver is not set | Sessionator, Claude app |
| `put_artifact` | id, kind (`implementation_plan`, `postplan`, `local_review`), content; optional commitSha, runId | artifact version (ignored if runId is superseded) | Routines, sessionator |
| `mark_ready` | id; runId for routines | updated glob (moves to `pr_open` when GitHub confirms) | Routines, sessionator |
| `merge` | id, version | updated glob (row 14: `pr_open` → `merging`; slop updates the branch, waits for checks on the new head and squash-merges, as the Merge button does) | Sessionator (`slop merge`); denied to agents in the agent set (with `gh pr merge`, `gh api`, `slop merge` and `slop call merge`); slop can't tell an agent from its developer, since both use the developer's sign-in, so the deny rules are the guard |
| `review_label` | id, version, label (FR, CR, QA), kind (`submit_items`, `tick`, `resubmit`); items for `submit_items`; itemId and done for `tick` | updated glob (rows 27–30) | Claude app, sessionator; approving and re-opening a review stay on the board (sign-off is human, like merging) |
| `report_failure` | id, reason; runId for routines; optional agentSetVersion | updated glob | Routines, sessionator |
| `get_board` | board | board settings: repo, base branch, environments, enabled integrations | Agents, sessionator |
| `get_agent_set` | board | the board's agent set (agents, commands, hooks, settings, CLAUDE.md section) with its version | Sessionator (`sstor init`), routines |
| `get_conventions` | board; optional area | without an area: the knowledge index (each document's title, area, description and audience, meaning the agents that must always be given it) plus approved learnings; with an area: that area's documents | Agents |
| `search_text` | board, query; optional mode (current / all time), date range, source types | matching chunks with citations | Agents, chat |
| `search_semantic` | board, query; same options | matching chunks with citations | Agents, chat |
| `search_changes` | board, query or file path; optional date range | change summaries, newest first | Agents, chat |
| `get_plan` | id; optional version | plan or postplan, with version history | Agents, chat |
| `get_change` | id; optional includeDiff | change summary, files, optionally the diff | Agents, chat |
| `get_build_results` | glob, commit or environment | build failures | Agents, chat |
| `get_test_results` | glob, commit or environment | test runs and failures | Agents, chat |
| `import_knowledge` | board, documents (name, content, optional frontmatter) | imported document ids; admins only | Claude in a session |
| `submit_learning` | board, source glob id, type (decision, gotcha, pattern, agent-behaviour), statement, evidence; optional suggested target, agentSetVersion, runId, and `document` (name, area, audience, description, content: a whole new-document proposal from `/kb-bootstrap`, for which the source glob is optional) | KB item id (`s1k3`) | Agents |
| `get_review_guide` | repo | the board's review guide | CodeRabbit, review agents |

All tools sit behind OAuth. There is no public MCP endpoint: CodeRabbit, the Claude app, Claude Code and routines all connect through the OAuth connector.

**REST endpoints (board)**

| Area | Endpoints |
| --- | --- |
| Boards | `GET /boards`, `POST /boards`, `GET /boards/{b}`, `PATCH /boards/{b}/settings` |
| Members | `GET /boards/{b}/members`, `POST /boards/{b}/members`, `PATCH /boards/{b}/members/{email}`, `DELETE /boards/{b}/members/{email}` (admins only) |
| Globs | `GET /boards/{b}/globs`, `GET /globs/{id}` (both with each glob's artifact summaries: latest version per kind, version count, commit SHA, provenance, no content), `POST /boards/{b}/globs`, `PATCH /globs/{id}`, `DELETE /globs/{id}` |
| Intake | `POST /boards/{b}/intake` — processes text and attachments, returns proposed fields without saving |
| Actions | `POST /globs/{id}/actions/{start, retrigger, pick-up, start-again}` |
| Labels | `POST /globs/{id}/labels/{FR, CR, QA}` with version and a command: `submit_items` (items), `approve`, `tick` (itemId, done), `resubmit` or `reopen` |
| Artifacts | `GET /globs/{id}/artifacts`, `GET /globs/{id}/artifacts/{kind}?label=` (every version of one artifact, for the viewer), `GET /artifacts/{artifactId}` (presigned URL), `POST /globs/{id}/attachments` (text or link), `POST /globs/{id}/uploads` (presigned upload URL) |
| Signed Off | `GET /boards/{b}/signed-off?cursor=` |
| KB | `GET /boards/{b}/kb`, `GET /catalog/kb` (catalog entries), `POST /boards/{b}/kb/catalog-imports` (import chosen catalog entries), `POST /boards/{b}/kb/uploads` (upload docs or a folder), `GET /boards/{b}/kb/proposals?status=` (KB items), `GET /boards/{b}/kb/agent-set/file?path=` (one agent-set file's stored content, for editing it while applying a KB item) |
| Inbox | `GET /inbox`, `POST /inbox/{meetingId}/attach`, `POST /inbox/{meetingId}/create-glob`, `POST /inbox/{meetingId}/discard` |
| Reports | `GET /boards/{b}/reports?period=2026-09` — presigned CSV URL |

**Further write endpoints:** `POST /globs/{id}/actions/merge` (Merge button), `POST /globs/{id}/actions/deploy-now`, `POST /globs/{id}/actions/take-over`, `PUT /globs/{id}/plan` (edit plan.md), `POST /kb/{itemId}/approve` (as a learning, as an edit to a document or agent-set file, or as the proposed document) and `POST /kb/{itemId}/reject` (with a reason) (admins). Every write, through REST or MCP, carries the glob or item `version` it read.

**Inbound**

- `POST /webhooks/github`: GitHub App events `push`, `pull_request`, `pull_request_review`, `pull_request_review_comment`, `issue_comment`, `check_run`, `check_suite`; verified with `X-Hub-Signature-256`.
- `POST /ingest/communications`: the canonical ingest format, authenticated with the user's ingest secret (Apps Script, pasted text, scripts).
- `POST /webhooks/slack`: the Slack app's shortcut and reaction events, verified with its signing secret.
- `POST /webhooks/aws`: CodeBuild and CodePipeline state changes from an EventBridge API destination, authenticated with an API key header.

**Outbound**

- **Routine fire:** POST to the triggerer's routine URL with text naming the glob ID and instructing the agent to call `get_context`.
- **Live hints:** server-sent events on `/boards/{b}/events`, payload `{ kind: "glob.changed" | "glob.deleted" | "board.changed", globId, version }`, or `{ kind: "glob.artifacts", boardId, globId }` (no version; refetched regardless) when an artifact is added.
- **GitHub App:** create and delete branches, update a branch (rebase), squash merge with title `<id>: <title>`, create each glob's branch with an empty first commit and open its draft PR with labels, compare commits, read check runs, post the CodeRabbit review command. CodeBuild: StartBuild for glob-branch deploys through the Deployer port.
- **Bedrock:** intake inference, meeting classification, embeddings and board chat through the LLM port.

**Implementation tool contracts**

- **Routine (sub, same):** call `get_context`; check out the glob's branch from origin (cloud sessions start on the default branch) and push only to it; `put_artifact` the implementation plan with its amendments section; call `mark_ready` (slop marks the glob's draft PR ready through its GitHub App, so the routine needs no `gh`); call `report_failure` if it cannot finish. It passes its run ID with every artifact and failure, adds a Slop-Run: \<runId> trailer to every commit, and checks the glob through the MCP before each push.
- **Sessionator (super):** `whoami`, then `create_glob` (type super) and check out the returned branch. On each push to the feature branch, `put_artifact` the postplan with the commit SHA. After local review, `put_artifact` the local review. Mark the PR ready for review in GitHub (no slop call). Submit learnings with `submit_learning`.

## Implementation and agents

Subs and sames are implemented by Claude Code routines owned by whoever triggered them; supers are implemented by the developer through sessionator or an equivalent tool.

**Routines**

- Each developer creates one routine in their own claude.ai account, used for both subs and sames, from a shared prompt and command. The prompt stays thin and identical: fetch the glob from the slop MCP and follow its instructions using the agents in `.claude/`.
- Each developer stores the routine's fire URL and token in Secrets Manager at `slop/routines/<userId>`; slop builds the path from the triggerer. If the triggerer has no routine, slop falls back to the board's default routine owner.
- A routine's cloud environment has a fixed set of repositories, so a developer can also store one routine per board (`slop/routines/<userId>/<boardId>`, as Secrets Manager names can't hold `#`; locally `<email>#<boardId>` in `.routines.json`), used before their default. Either way the routine's environment must include the board's repository, with the Claude GitHub App installed on it. The fire text names the board's repository, and a session that doesn't have it, or can't push to it, reports a failure instead of working in another repository.
- The triggerer is the person whose session created the glob, where slop can determine it.
- Usage, the daily run cap, commits and PRs belong to the routine owner; time follows the planner until a human picks the glob up (slop stores both). Only the routine owner can teleport into a run.
- Sessionator's sstor --routine-setup command handles routine setup and storing the secret.

* **Seats:** every Team seat includes Claude Code according to Anthropic's help center; Premium seats add higher usage. Standard-seat users can own routines but will hit limits sooner.

**Agent system**

- **The agent set is board knowledge.** Each board's agent definitions, commands, hooks and Claude settings are KB items of kind `agent`, versioned and changed through approved proposals like any other document. The board's **agent-set version** increases with every approved change to any of them.
- **Catalog origin:** a new board imports (forks) the generic agent set from slop's public repo under `catalog/agents/`, exactly as it imports KB catalog entries. When the catalog's agent set changes, each board gets a proposal with the diff since its import; the admin merges it around the board's own changes.
- **Delivery:** `sstor init` fetches the board's agent set with `get_agent_set(board)` with sstor's own sign-in (the developer's OAuth login through sstor's Cognito app client), writes it into the checkout and records the version in `.claude/slop-agent-set.json`. The files are committed in the project repo, so every checkout, including a routine's cloud checkout, has the agents registered from the start. Updates ride along in the next glob commit.
- **Routines** use the committed copy. At the start of an unattended run the orchestrator compares the committed version with `get_agent_set`; if slop's is newer it writes the new files and commits them with the glob, and they take effect from the next session (files written during a session only register in the next one). Routines need no session-start hook.
- **What goes in a definition and what goes in a document:** short rules that always apply to one agent go in that agent's definition, whether generic or project-specific (they are always present and carry system-prompt weight). Bulky or situational knowledge (conventions, architecture, testing guides) goes in documents, loaded by area and passed to agents by their audience.
- The knowledge base is searchable at runtime through MCP tools such as `get_conventions`, `search_text` and `search_semantic`, and agents submit learnings with `submit_learning`.
- **KB catalog:** generic, non-sensitive starter documents in slop's public repo under `catalog/kb/` (to start: TypeScript conventions, Python conventions, a generic review checklist and a build-doc template), each with the same frontmatter as any KB document (`area`, `audience`, `description`) plus a catalog ID and version. When a board is created, an admin picks the entries to import, with suggestions pre-ticked from the repo's languages (GitHub's languages API). Importing **forks** the entry: the board gets its own versioned copy, records its source (`catalog:typescript_conventions@3`) and can edit it freely. When a catalog entry changes, every board that imported it gets a KB proposal with the diff since its import, approved or rejected like any other proposal; nothing is overwritten.
- **Other ways in:** a project's existing docs are uploaded on the board's KB page (files or a folder; frontmatter sets area and audience, otherwise Haiku suggests them and the admin confirms), or imported from a session with the admin-only `import_knowledge` MCP tool. Knowledge only the code holds is drafted by the `/kb-bootstrap` command, which runs in a checkout, reads the repo and submits the missing documents (build doc, conventions as practised, architecture overview) as new-document proposals. All three paths end as KB documents or proposals, so admin approval still governs what agents receive.
- **Script catalog:** slop keeps reusable scripts and config templates; boards select the ones they use, and builds and setup fetch them from slop's public endpoint. Claude Code generates the initial set during the build: a CodeBuild buildspec for PR checks that reads the glob labels; a buildspec that deploys a branch to the glob's environment; an ATF trigger buildspec; the sub gate GitHub Action; `.coderabbit.yaml` and `review-guide.md` templates; a PR-Agent configuration template; and the Google Meet Apps Script. The `sstor` changes are specified in the sessionator document.

**Self-improvement (KB items)**

Each proposal is an `s<board>k<n>` KB item linked to the globs that produced it, and nothing reaches the knowledge base or the agent set without human approval.

- **Provenance:** every run, artifact, failure report and learning records the board's agent-set version it ran with (from `.claude/slop-agent-set.json`), alongside the model. Slop can then compare signals before and after any change.
- **Capture (self-reports):** at the end of each run (orchestrator phase 6 for sames and subs, `/finalise` for supers, the end of each routine run) the orchestrator calls `submit_learning` once per learning with type (decision, gotcha, pattern, agent-behaviour), statement, evidence (glob, files, review findings or failures) and an optional suggested target. `agent-behaviour` learnings report something an instruction would have prevented: a review finding the implementer should never have produced, a test pass that failed because of how the code was written, and above all a developer correcting the agent in the session. Agents never edit the knowledge base or the agent set directly.
- **Signals slop mines (weekly job, marked as mined):** review findings are classified by Haiku as they arrive (e.g. "missing test for changed function", "unhandled error path") so they can be counted.
  - Recurring classes of local-review or CodeRabbit findings: the implementer isn't preventing them.
  - Classes CodeRabbit finds on a commit whose local review missed them: a change_reviewer blind spot.
  - Heavy amendments to implementation plans, or plan.md edited before a `--from` rerun: the investigator's planning.
  - Review cycles reaching the round cap, and tester FAIL→fix loops: the implementer or tester.
  - Recurring `report_failure` reasons, and routine runs ending in take-over or start-again: usually an orchestrator gap, especially in unattended mode.
  - Frequent sub-to-same conversions, and CI failing after local checks passed: local checks or scope control not matching the project.
  - New libraries or frameworks appearing across change summaries with no conventions yet: a missing document.
- **Processing (slop background jobs on a Postgres-backed queue such as pg-boss):**
  1. *On submission (Haiku):* classify, choose the target and deduplicate by semantic search against active knowledge, open proposals and rejected proposals. Near-duplicates add evidence to the existing proposal; matches to rejected proposals are dropped; contradictions with active entries are flagged.
  2. *Routing:* a project fact goes to a document for the relevant audience (e.g. "generated files live in `src/gen/`"), unless it is a short rule that always applies to one agent, which goes in that agent's definition (e.g. "never edit `src/gen/`"). Process behaviour goes to the agent's definition (e.g. "write the regression test before the fix"). Anything that would hold for any project is also flagged as a catalog candidate, shown to admins as a suggested PR to slop's `catalog/`.
  3. *Drafting (Sonnet):* once a proposal recurs, or once for a strong signal such as a gotcha behind a failed run or a developer's correction, slop drafts the concrete change with rationale and evidence links: a diff to an existing document, section or agent definition, or a full draft for a new document (with a suggested area and audience, after an overlap check against existing documents).
  4. *Weekly consolidation:* merge proposals that are the same idea, retire stale ones, order the queue by evidence count.
- **Review:** the KB view shows each proposal's diff, rationale, evidence and occurrence count; for now only board admins approve, edit then approve, or reject with a reason (this may be opened up later). Approval creates a new document version in Postgres (and a new agent-set version for agent items), picked up by the next `sstor init` or routine run. Rejections are kept to suppress repeats.
- **Effect check:** after an approved change, slop watches the signal that triggered it (e.g. the rate of "missing test" findings per glob) over the following globs that ran with the new version. If it hasn't dropped after a per-board number of globs (default 10), or another signal got markedly worse, slop raises a proposal to revise or revert the change, with the before and after figures. Humans still decide.
- **Data:** a `kb_proposals` table (ID, status, type, statement, target, draft diff, evidence, occurrence count, embedding, conflicts, source submitted or mined, catalog candidate, decision and reason, triggering signal and effect-check result) alongside versioned knowledge documents and agent items, and a `review_findings` table of classified findings per glob and commit.
- **Cost:** one Haiku call per submission and per review finding, plus Sonnet drafts for proposals that cross the threshold; cents per glob.

Approved changes are served on the next fetch; no PR is needed.

## Review, merge and GitHub

From now on the team works with a branch and PR per glob, replacing direct commits to master. Slop links everything in GitHub to globs by one convention: the branch name is the glob ID, and slop creates that branch itself.

**Sub review** runs as a GitHub Action and reports back to slop. It starts with basic checks (lint, type check, tests). Each board has a sensitive-paths setting, empty for now. A flagged sub converts to a same.

**Merging**

- Squash merge only. The commit message starts with the glob ID, e.g. `s1t4: Fix login timeout`; PR titles use the same format.
- Repository rules enforce the merge guarantees for every entry point (GitHub UI, gh, sstor, slop): required checks must pass on the PR's current head commit and the branch must be up to date with master, so a stale passing result can never merge newer changes. For merges slop starts (subs and the Merge button), slop updates the branch, waits for the checks and squash-merges; a conflict leaves the glob failed in Doing. Merges done anywhere else are observed through the merged event.
- Branch protection requires passing checks but no approvals; direct pushes to master are not allowed. For sames and supers, merging is the approval: the developer reviews the results on the glob and clicks Merge (on the glob or in GitHub). Slop merges subs once the sub gate passes.
- GitHub's "automatically delete head branches" setting is on. No other git cleanup for now.

**GitHub App**

- Slop reaches the repository through a `CodeHost` port (provision, labels, close, reopen, delete branch, merge state, squash merge); the GitHub App is its only adapter, and a host-specific webhook adapter turns deliveries into the same state-machine events. Another host (GitLab, Forgejo) would mean a new adapter pair, but routines and Claude's auto-fix only work with GitHub today, so that is the real lock-in.

- Slop's GitHub operations (branches, PRs, merges, check results) use the app's installation tokens, acting as `slop[bot]`. The private key lives in Secrets Manager.
- The app is allowed by branch protection to merge subs to master once required checks pass.
- One board maps to one repo.

**Webhooks:** the app subscribes to `push`, `pull_request`, `pull_request_review`, `pull_request_review_comment`, `issue_comment`, `check_run` and `check_suite`. A webhook adapter verifies the signature, reads the glob ID from the branch and calls the core, which records commits, PR ready and closed, merges, check results and review comments, and starts the glob's deploy when a push arrives and an environment is set. The glob stores references only. No reconciliation job; missed deliveries are redelivered by hand from the app settings.

**Review and CI results** attach to the glob through the branch name, with or without a PR. The sub review and other Actions report as GitHub check runs; slop receives them through the GitHub App's existing check webhooks and reads summaries and annotations from the Checks API. No slop credential is stored in the repo, and a crashed Action still arrives as a failed check. A REST callback remains for results that are not GitHub checks. The MCP and REST endpoints are separate driving adapters on the same application services.

## Review and testing

The repo's build scripts decide which checks run, using the PR labels; slop displays results on the glob. Every glob in Doing has a PR, opened as a draft by slop's GitHub App when the glob enters Doing, so CI, reviewers, labels and auto-fix can attach. Because GitHub cannot open a PR on a branch identical to master, slop creates each glob's branch with an empty first commit (\<id>: start), which the squash merge removes.

| # | Stage | Where | Sub | Same | Super | Blocks merge? |
| --- | --- | --- | --- | --- | --- | --- |
| L1 | Lint, type check, unit tests | Local (routine or sessionator) | Before PR is ready | Before PR is ready | Before ready for review | No (self-check) |
| L2 | Local AI review against plan and conventions, run by the implementer (routine or sessionator) on every project; pushed to slop with put\_artifact as the local review artifact and shown under its own local review icon on the card, separate from the remote review, to support the human CR | Local | Light | Full | Developer-triggered | No (self-check) |
| R1 | CI: lint, type check, unit and integration tests | CodeBuild or Actions, reported as checks | Yes | Yes | Yes | **Yes** |
| R2 | Sub gate: static checks, size, sensitive paths, scope vs plan | GitHub Action | Yes | — | — | Converts to same if flagged |
| R3 | Independent AI code review of the changed code only: logic errors, newly introduced bugs, departures from conventions and patterns. Tool: CodeRabbit to start (paid plan with MCP connections). CodeRabbit connects to slop's MCP through its OAuth connector; its usage guidance tells it to fetch the review guide for `{repo}` before every review. Nothing is committed to the repo apart from an optional `.coderabbit.yaml` turning off automatic reviews, in which case slop posts `@coderabbitai review` only when the board has a review guide. Slop adds the plan summary to the PR description. CodeRabbit's summary, review and inline findings reach slop through the GitHub App's pull\_request\_review, pull\_request\_review\_comment and issue\_comment webhooks (filtered to CodeRabbit's bot) and are stored verbatim on the glob (summary text, and each inline comment's file, line, text and link) without interpreting them. The glob shows a review icon with a comment count that opens the PR review in GitHub, and the stored text is indexed for search, chat and context bundles. PR-Agent output would arrive the same way. Later option, if reviews must stay inside AWS or structured severity data is wanted: a custom reviewer script or PR-Agent in CodeBuild posting structured JSON to slop, with a summary comment on the PR. PR-Agent in CodeBuild on a non-Claude Bedrock model (code stays in AWS, rules fetched from slop with an integration credential, tokens only) | GitHub app on the PR | Yes, non-blocking; findings may arrive after merge | Yes | Yes | No |
| R4 | Security and privacy review of the changed code: vulnerabilities, and privacy meaning behaviour changes that expose user data | Part of R3 or a separate check | Via R3 | Yes | Yes | No; developer decides |
| R5 | Deploy to the glob's environment and run ATF | CodeBuild | After merge (integration environment) | Slop deploys the branch to the glob's environment on each push, if one is set; ATF before merge | Deployed on each push to the developer's environment; ATF on ready for review | No (flagged) |
| R6 | Merge | Slop (subs) or developer | Slop, after R1 and R2 | Developer | Developer | — |
| — | FR, CR, QA sign-off | Board | QA | FR, CR, QA | FR, CR, QA | Post-merge |

- **Auto-fix:** routine PRs (subs, sames) use Claude's auto-fix: the routine's cloud session watches the PR and pushes fixes for CI failures and review comments, asking first when ambiguous. It uses the routine owner's subscription. Supers rely on the developer or an `@claude` mention.
- **Routines on sames:** the routine works on the glob's branch (e.g. `s1t4`), and a developer who picks the glob up works in the same branch, branching off it only if ever needed. Pick-up is refused while a routine run is active; Take over supersedes the run. After a human picks up, the routine's auto-fix stands down.
- **Release review:** not planned for now.

## Environments and deployment

Each environment is represented by the commit it runs, and a glob counts as deployed there if its squash commit is an ancestor of that commit.

- **Environment roles** (board settings): *branch-deploy* environments receive glob branches (`allowBranchDeploy`); the *integration* environment is deployed by the base branch's own pipeline; *release* environments run release branches cut from the base branch, and one of them may be marked *production*. A board can have any mix, including none.
- **Release branches:** release environments run release branches cut from master. The ancestry check covers everything up to the cut point and ignores unrelated commits, so commits without globs never break tracking. Rollbacks resolve the same way.
- **On each deploy event,** slop rechecks all recent globs, including those previously marked deployed so rollbacks are handled, using GitHub's compare API, and stores the result on each glob. The board reads stored values and never calls GitHub while rendering.
- **Hotfixes** are `h` globs with their own counter (deferred: the design below is a sketch, not part of the first build). They are worked on a branch off the release branch and merged into it. The same ancestry check shows where they are deployed. When brought back to master, the commit message uses the hotfix ID (e.g. `s1h3: backport`).
- **Indicators:** the card shows when deployment action is required for a release environment. Production deployment is manual. Deploying to production before sign-off is allowed but should be discouraged with a warning.
- **Slop observes integration and release deployments; it only starts deploys of glob branches to their assigned environment (see Environment assignment).** Build and deploy events come from CodeBuild and CodePipeline through EventBridge. An EventBridge API destination posts them to slop's webhook endpoint with an API key header, where a driving adapter translates them into domain commands such as `BuildCompleted`, and the core never sees EventBridge.
- **Build and ATF results:** branch builds attach to the glob named by the branch. ATF runs against the integration and release environments and attach to the commit that environment was running, so every glob in that environment shows them. Details are fetched on demand through a `TestResultSource` port backed by the CodeBuild reports API.
- **Release name:** the board can optionally show which release a glob shipped in. Not needed for now.

**ATF failures:** any failing test counts as a failure. A failure is flagged clearly on the card but never blocks PR creation, PR approval, sign-off or production deployment, including ATF runs against feature branches.

**Environment assignment for product work:** each board has an enumerated list of environments; the default is a single environment, main (enough for slop's own development). A glob's environment is chosen at creation (MCP input, board form or `sstor --new`) or at pick-up and can be edited in the glob view at any time. **Slop starts the deploy:** when a push to a glob branch arrives through the GitHub webhook and the glob has an environment set, slop calls CodeBuild's `StartBuild` (through a `Deployer` port, using its IAM role) with the branch and target environment as parameters. If none is set, nothing deploys. Each environment has an allowBranchDeploy flag, and the core rejects assigning a glob to an environment without it. Deploys run one at a time per environment: each is pinned to an exact commit SHA (StartBuild with that SHA, never a moving branch), and while one is running only the newest pending request for that environment is kept. The environment's live state is recorded from the deploy that actually succeeded, so the board always reflects what is running. A changed environment applies on the next push, or immediately with a *Deploy now* button. Slop records which glob is live in each environment, so the card shows when another glob's deploy has replaced it in a shared environment. The base branch's own pipeline still deploys merged work to the integration environment, and release environments remain observe-only. Slop's GitHub App also puts the glob's type and environment on its PR as labels (e.g. `slop:sub`, `env:dev`) for the repo's build scripts, which decide which checks and tests run.

## Time tracking and reports

Time counts only during working hours, and only toward each person's single active glob.

- **Event log:** an append-only record of every board event (moved, assigned, picked up, PR opened, merged, label changed), stored as rows per glob. Reports and aging are derived from it.
- **Active glob:** the one the person most recently moved into Doing or picked up; one active glob per person across all boards. Counting for a glob stops when it leaves Doing or another glob becomes the person's active one; an older glob does not resume automatically, only when it is re-entered or picked up again. Example: Ana picks up s1t4 at 10:00 and s1b2 at 14:00, so s1t4 gets 4 hours and s1b2 counts from 14:00. Example: a glob entered Doing on Friday at 16:00 and merged on Monday at 10:00 counts 2 hours (Friday 16:00–17:00 and Monday 09:00–10:00).
- **Working hours:** 9:00–17:00 in one configurable time zone for everyone, defaulting to UTC and shown on the board. Servers often run in UTC, so the time zone is a setting rather than the server's. Weekends are excluded; holidays are ignored.
- **Attribution:** the planner until a human implementer picks the glob up, then the implementer.
- **Reports:** monthly and yearly % RnD (features) vs maintenance (tasks, bugs) per developer. A scheduled batch job scans the event log and builds each report whole.

**Report output:** the batch job writes a CSV to S3 and the board offers it as a download. Columns: developer, period, RnD hours, maintenance hours, % RnD.

## Data, auth and infrastructure

Slop is one portable Docker image running as a single instance, backed by Postgres. AWS-specific services sit behind adapters, so the image can move to any host; sign-in is the one remaining AWS tie.

| Concern | Choice |
| --- | --- |
| Hosting | One container (Node with Hono or Fastify) on a small EC2 instance with an IAM instance role, run with Docker Compose alongside Postgres. The same Compose file runs locally. |
| Frontend | Vite + React + TypeScript, Tailwind + shadcn/ui, dnd-kit, served by the same container. The board is built from scratch rather than adapting an open-source kanban app; community shadcn-based kanban components can serve as a starting point |
| API | REST, MCP, webhooks and live updates all served by the one server |
| Database | PostgreSQL with full-text search and pgvector, holding globs, events, communications and search. Runs in Docker (official Postgres image with pgvector) on the same EC2 instance. Aurora Serverless v2 is the managed alternative if point-in-time restore is ever needed. |
| Migrations | Drizzle, run on deploy |
| Live updates | Server-sent events from an in-process notifier |
| Artifacts | S3-compatible storage with bucket versioning, served via presigned URLs |
| LLM and embeddings | Amazon Bedrock behind the LLM port (Claude Haiku 4.5 to start); a direct Anthropic API adapter is possible |
| Sign-in | Cognito federated to IAM Identity Center |
| GitHub | GitHub App with installation tokens; source stays on GitHub |
| CodeBuild events | EventBridge API destination posting to slop's webhook with an API key header |
| Secrets | Environment variables for configuration; Secrets Manager for sensitive credentials (GitHub App key, routine fire tokens), read via the EC2 instance role |
| Infrastructure | CDK for the AWS resources (Cognito, S3, IAM, EventBridge, host) |

**Auth**

- **Board:** the server handles the Cognito login (federated to Identity Center) and keeps a server-side session cookie (30 days). The OAuth `state` is signed by the server and bound to the browser by a nonce cookie, which stops login CSRF. A plain-http `localhost` dev server can accept the signed state without the cookie, because Chrome drops it on the cross-site return from Cognito; that exception is off unless the server is started with `LOCAL_SIGN_IN_WITHOUT_COOKIE=true` (`scripts/dev.sh` sets it), so a proxy rewriting `Host` to `localhost` can't open login CSRF on a deployed slop.
- **Claude app connector and routines:** Cognito is the OAuth authorization server, using a pre-registered app client whose ID and secret go in the connector's Advanced settings, with callback `https://claude.ai/api/mcp/auth_callback`. Routines use the account's connector.
- **Claude Code:** OAuth login against Cognito via `claude mcp add --client-id`, once in the browser, then automatic refresh.
- **Sessionator (the slop CLI):** the same public client as Claude Code, with its own callback (`localhost:7780`): `sstor login` runs the authorization code flow with PKCE once in the browser, keeps the tokens in the macOS Keychain and refreshes automatically. sstor calls slop's `/mcp` directly with the access token; it never starts a Claude session to reach slop.
- **Slop verifies Cognito JWTs** with `aws-jwt-verify`, checking issuer and client ID, and publishes the protected-resource discovery document pointing clients at Cognito.
- **Integrations** use per-integration secrets, not user sign-in: a per-user ingest secret for the Apps Script (it also identifies the user), the Slack app's signing secret, the GitHub App webhook secret, and an API key on the EventBridge connection. **Public endpoints:** only the script catalog is served without authentication; it is board-agnostic and contains nothing sensitive or project-specific. The agent set is board knowledge, fetched through the authenticated MCP. Everything specific to a board, including its knowledge, settings and review guide, stays behind OAuth. There is no board token.
- **Roles live in slop.** Identity Center only answers who someone is; email is the stable user ID, with Cognito's user ID and the GitHub username stored against it.
- **Offboarding:** removing someone from Identity Center blocks new logins; a deactivate action in slop rejects their requests immediately.
- **Cognito plan:** Lite. Federated users are free up to 50 monthly active users.
- **Local development:** a dev Cognito pool in CDK with native test users; agents get real tokens with `aws cognito-idp initiate-auth`, and slop validates them exactly as in production.
- **Fallback:** if the connector checks fail, slop becomes its own authorization server (MCP SDK helpers, with dynamic client registration) and Cognito handles login only; Keycloak in the Compose file is the alternative.

**Token lifetimes:** access tokens last one hour and refresh silently; the Cognito app clients for the Claude connector and Claude Code use the maximum refresh token lifetime (10 years), so each person logs in once. Every MCP request is still authenticated. A leaked refresh token is handled by slop's deactivate-user action (slop rejects deactivated users regardless of token) and by revoking the person's tokens in Cognito.

**Search**

- **Communications** (meeting notes, chat threads) are an entity: metadata and text in Postgres, raw files in S3, linked to any number of globs.
- **Ingest** uses one canonical format, `IngestCommunication { source, sourceId, author, occurredAt, title, text, participants }`, on a generic endpoint authenticated by the per-user ingest secret. Scripts (Apps Script, exporters) send that format; only sources with fixed formats, such as the Slack app, get a dedicated adapter. Repeats are ignored by `sourceId`.
- **Indexed content:** communications, glob summaries and plans, postplans and KB entries, with board, glob, source, person and date as metadata. Search is per board.
- **Keyword** search uses Postgres full-text search; **semantic** search uses pgvector with Bedrock embeddings. Both sit behind the `SearchIndex` port and update when data is saved.
- **One chat-style input on the board:** the question goes to Claude via Bedrock with `search_text`, `search_semantic` and `get_glob` tools scoped to the board; Claude chooses the searches and answers with links to the globs and meetings it used. Responses stream.

**Not chosen:** Lambda, DynamoDB, AppSync, Amplify Gen 2 backend tooling, Bedrock Knowledge Bases on S3 Vectors (semantic search only), OpenSearch Serverless (minimum cost), Supabase, Firestore, PocketBase, Convex, Keycloak (kept as fallback), Aurora Serverless v2 and Neon (Postgres on the VM chosen), Fargate, Lightsail (no instance IAM roles), Google Workspace sign-in, CodeCommit, and App Runner (closed to new customers since 30 April 2026).

## Operations

Slop has two environments: a developer's laptop (Docker Compose) and production on EC2. Only production is backed up.

- **Backups:** a nightly `pg_dump` to S3 kept for 30 days by a lifecycle rule; a weekly EBS snapshot via AWS's snapshot scheduler; artifacts protected by S3 bucket versioning. One test restore after setup. Cost is well under a dollar a month.
- **Deploying slop:** CodeBuild, triggered by pushes to main, builds the image, pushes it to a registry, and updates the EC2 instance through SSM Run Command (no SSH, no stored keys). Migrations run when the app starts. CodeBuild is preferred wherever it fits.
- **System page:** the last \~100 errors (stored in Postgres, with time, task and message); when each automatic input was last received (GitHub and AWS webhooks, each person's Apps Script, the Slack app); the last routine run per person; the last report run; the indexing backlog. Anything silent for longer than expected shows amber.
- **Uptime:** a free external uptime checker pings the server and emails when it is down.
- **LLM spend:** slop multiplies its own token usage by a price table and shows month-to-date spend as a small line on the board. An AWS Budgets email alert is the backstop. No per-user caps for now.
- **Data retention:** everything is kept by default. Any item can be deleted, and a "remove everything from this source or person" action handles departures and requests. Each deployment should check its personal-data retention obligations under the data-protection law that applies to it.

## Testing

Slop will get little human review, so automated checks act as its reviewers.

**Slop's own code**

- Strict TypeScript and linting, including the boundary rule that keeps adapters out of the core.
- Unit tests for core rules: the category/type matrix, transitions, sub-to-same conversion, label rules, ID generation, ancestry-based deployment status and time calculation. The core runs against in-memory fakes, so these are fast.
- A few Playwright smoke tests: load the board, move a glob, open an artifact.
- A short human look at the security surface even so: Cognito and Identity Center setup, IAM grants in CDK, and the GitHub App's permissions, especially its right to merge to master.

**Test results for the repos slop manages**

- Tests and snapshot or golden files are committed; run output is not.
- CodeBuild report groups hold the results (JUnit XML, LCOV or Cobertura), with raw files exported to S3 for longer retention.
- Slop reads results through the CodeBuild reports API and shows them via the glob's test icon. Branch results attach to the glob; ATF results attach to the environment's commit.
- A failure summary is posted on the PR so reviewers and Claude's auto-fix can act without AWS access.

**Local environment**

- Docker Compose runs the app and Postgres; Claude Code can start it, run tests and drive the board with Playwright.
- A dev Cognito pool with native test users provides real tokens; local Claude Code connects to the local MCP with one.
- GitHub and AWS events are tested by replaying saved real payloads; anything that creates branches or PRs uses a test GitHub App on a sandbox repo.
- Storage and Bedrock use real dev resources with a dev AWS profile. In-memory fakes are used only for core unit tests.

## Supers

Pairing work is at the developer's discretion, including up to 2 days before marking the PR ready; the aging colour applies as for any glob.

- The developer works on the glob's own branch throughout. Each push deploys it to the glob's environment (normally a branch-deploy environment the developer uses), started by slop.
- The local review runs in sessionator using the slop-delivered agents and is pushed to slop as the `local_review` artifact.
- The glob's draft PR exists from creation (supers start in Doing). Marking it ready for review (`sstor --ready`) triggers ATF and the remote review; results reach slop through the existing webhooks and EventBridge.
- Developers choose the glob's environment from the board's branch-deploy environments. Slop tracks no environment claims; the card shows when another glob's deploy has replaced this one in a shared environment.
- **Branches:** every glob has its own branch, always created from master. No stacking: if reviews send back serious problems, work does not continue on a new glob until they are resolved.
- `sstor --new --super` creates the glob (through `create_glob`, which returns `{ id, branch }`) and opens a session on its branch.
- **Postplan:** sessionator updates the postplan from the code changes and the session conversation on each push (best effort) and always at sstor --ready and --derge, and sends it to slop. When the meeting ends and its Gemini notes arrive through the Apps Script, slop suggests attaching them to the developer's active super, a person confirms, and slop then runs one more pass merging the meeting's decisions into the postplan.

## Roles and permissions

Board roles are admin, dev, QA and PO.

- Roles are per board, stored on the membership record (user + board).
- Anyone can create a board; its creator is its admin. New members default to dev.
- Only admins add users and set roles; admins can do everything.
- Anyone on the board can delete globs. FR, CR and QA can only be switched on the board, not through the MCP.
- QA and PO can create subs and sames, but not supers, and they cannot pick up (or take over) sames.
- Users are added by email and linked to their account on first sign-in.
- **Board settings:** repo, base branch (e.g. master or main), sensitive paths, time zone, default routine owner, environments with their allowBranchDeploy flags, members and roles. Wherever this document says master, it means the board's base branch.
- **MCP access:** slop's MCP is a claude.ai custom connector with Cognito as the OAuth server (see Auth). The Claude app and routines act as the signed-in person with their board role; Claude Code and sessionator log in the same way.
- No notifications outside the app for now.

## Planning inputs and intake

- **Attach** through the MCP as inline text or links; on the board as text, links or file uploads. Links (Google Drive, Slack) are fetched by a `SourceFetcher` port and stored as snapshots. Files are only uploaded through the board.
- **Meeting inbox:** every meeting arrives through its source's adapter and is stored once. An LLM suggests attaching it to existing globs, across boards, or creating new globs from its action items; a person confirms. One meeting can attach to several globs. No automatic attachment to start with. Meetings come from Google Meet notes.
- **Related meetings:** intake searches slop's stored meetings by keyword (semantic search later), not the meeting tools directly.
- **Artifact history:** S3 bucket versioning, with a current-version pointer on the glob. No git.
- **LLM:** Amazon Bedrock via the Converse API, called with slop's IAM role behind the LLM port; prompts live in the core. Claude Haiku 4.5 for intake and meeting classification to start.
- **Intake inference** returns name, summary, type, category, group (existing preferred) and `autoTrigger` with a reason, validated against the matrix with safe defaults. Through the MCP, explicit fields win. Sames auto-trigger only on an explicit instruction in the input.
- **Create on the board:** a free-text box with attachments and a Process button; the LLM fills a structured form (name, summary, type, category, group, auto-trigger) that the user checks and edits before Create. The form can also be filled directly.

* **Meeting sources:** Google Meet notes via Apps Script. Each person's script uses their own ingest secret. Meetings arrive without a board, in a shared inbox every slop user can see; once attached to a glob they also appear on that glob's board. Attachment is always confirmed by a person. The inbox has a discard action for meetings that don't belong.
* **Other sources** (Slack threads, pasted text, legacy docs) post the canonical ingest format; see Knowledge and context.

## Knowledge and context

Slop is a context manager: it holds what is known about the work, decides what is current and relevant, and serves curated context to people and agents.

**Knowledge sources**

| Source | Stored | Chunking | Best queried by |
| --- | --- | --- | --- |
| Meetings | Gemini notes; transcripts too for formulation meetings | Notes by section; transcripts in \~500-token windows | Text and semantic search, by date and participants |
| Slack threads | The thread with author names kept in every window, plus an LLM summary of its conclusion and each participant's position | Summary as one chunk, plus windows of consecutive messages | Text and semantic search |
| Plans and postplans | Every version; older versions marked superseded | By heading | `get_plan` with history; search |
| Code changes | Per merged glob: commit SHA, PR link, changed file paths and an LLM summary of what changed and why; full diff fetched from GitHub on demand | One chunk | `search_changes` (summaries plus trigram match on paths, by date); agents also use `git log -S` / `-G` |
| Build failures | Only the error messages and what failed, written by an LLM from the tail of the failing build log and the test report | One chunk plus structured rows | `get_build_results` |
| Test runs | Structured rows: glob, commit, environment, counts, failing test names and messages | Not chunked | `get_test_results` |
| Legacy Jira issues | Description, comments, linked commits and a "why this changed" summary | One chunk, split if long | Search (legacy tier) |
| Legacy Google Docs | The document | By heading | Search (legacy tier) |
| Decisions | Their own items, linked to their source | One chunk | Search; shown on globs |
| Knowledge base | Lives in slop, versioned in Postgres, per board. Each document has an area and an audience (the agents that must always be given it). Served only through MCP tools; agents save what they fetch under `.reviews/` for the session. Slop indexes it directly | By heading | `get_conventions`; search |

**Knowledge delivery:** slop is the source of truth. `sstor init <board>` runs before Claude starts whenever sessionator creates or syncs an instance: it fetches the board's agent set with `get_agent_set`, using sstor's own sign-in, and writes it into the checkout, where it is committed (see Agent system). On a first install it writes the slop server entry into `.mcp.json` from sstor's own configuration (slop's URL and the Claude Code client ID, neither sensitive), so Claude Code can authenticate. Routines use the committed agent set and refresh it from the orchestrator. The board ID comes from an argument, an environment variable, or `.sstor/sstor.conf` (`SLOP_BOARD`). If slop is unreachable, the committed copy is used with a warning. All other board knowledge (build commands, conventions, architecture, decisions, history) and the board's settings are fetched at run time through the MCP tools (`get_board`, `get_context`, `get_conventions`, the search tools), authenticated by the connector's OAuth. Existing project docs (e.g. a project's `.sstor/docs/`) are imported into the board's knowledge base once, then removed from the project repo. Review guides are also served from slop rather than the repo (see Review and testing). Details are in the sessionator document.

- **Card search and content search are separate.** Board filters find globs by structured fields; the chat and agent tools search content. The chat can use both.
- **The current codebase is not indexed.** Agents with a checkout use grep and git; slop holds the history of changes, not the code. GitHub's own MCP server can complement slop's tools for code and PR search.
- **Raw diffs are not indexed.** Change summaries are generated with one cheap LLM call per merged glob.

**Order of authority** when sources disagree: merged code and the postplan, then the approved plan.md, then active decisions (newest first), then older discussion. Context bundles state which source won.

**Decisions and supersession**

- On ingest, an LLM extracts decisions from each communication (statement, topic, date, source) and compares them with existing decisions on the same topic.
- A contradicting newer decision marks the older one `superseded`, linked to its replacement. Superseded items are not hidden: they are heavily down-ranked and labelled "superseded by…" with a one-line reason, so readers and the LLM see both the history and what is current. Supersession is judged by an LLM comparing a new decision with the most similar active decisions on the board; plan versions supersede each other automatically.
- Decisions appear on the glob with their sources. Anyone can mark a decision superseded or wrong.
- Newer material ranks higher when relevance is equal.

**Context assembly**

- A core use case, `assembleContext(glob, purpose, tokenBudget)`, returns a cited bundle: the plan (or postplan for supers), active decisions linked to the glob or its topic, the most relevant recent communication excerpts, related past globs with their change summaries, current test results and relevant conventions.
- It serves routines and sessionator (`get_context`), plan drafting for sames, glob generation from inbox meetings, and the board chat.
- Two modes: slop pushes a curated bundle; agents pull anything further through the search tools.

**In the architecture**

- Core modules alongside the board: **Knowledge** (sources, decisions, supersession), **Context** (assembly and ranking) and **Generation** (globs and plans), using the existing `SearchIndex` and LLM ports.
- Postgres holds it all: a `knowledge_items` table with `source_type`, `occurred_at`, `created_at`, glob links, `status` and `superseded_by`, and a chunks table with full-text, trigram (`pg_trgm`, for identifiers) and vector indexes.
- Added MCP tools: `get_test_results` (by glob, commit or environment) and `get_change` (summary, files and optionally the diff for a glob).

**Build order**

1. Glob, plan and communication search, plus a basic context bundle ranked by authority and recency.
2. Code change summaries and test result tools.
3. Decision extraction and supersession.

**Search modes:** searches take a mode. **Current** (default) favours recent material, heavily down-ranks superseded items and ranks legacy last. **All time** removes recency weighting and includes superseded and legacy items, labelled with date and status. An optional date range applies to both. The chat switches to all-time mode when a question implies older discussion; the board has an *Include history* toggle; the MCP search tools take the same parameter.

**Chat**

- Conversations, messages, tool calls and citations are stored in Postgres per user per board. Recent turns are sent each time; older turns are summarised.
- Chat answers are never indexed automatically; a *save to knowledge* button lets a person keep one.
- The agent loop is plain code in the container using Anthropic's TypeScript SDK with its Bedrock client, so it can switch to the direct Anthropic API by configuration. AgentCore is not used.

**LLM usage and cost**

| Workload | Model | Expected cost |
| --- | --- | --- |
| Embeddings | Bedrock Titan Text Embeddings V2 | Negligible, including the backfill |
| Ingest processing (decisions, change summaries, classification, intake) | Haiku 4.5 | A few dollars a month |
| Chat and context assembly | Haiku by default; Sonnet for plan drafting or on request | Tens of dollars a month, depending on use |

- Prompt caching for the chat's system prompt and tools; a cap on tool steps and retrieved tokens per question; batch inference for the backfill; usage tracked per feature with an AWS Budgets alert.
- No self-hosted LLM. A small open embedding model on CPU in the container is an option if portability ever outweighs quality.
- Search quality levers: structure-aware chunking, a source/title/date/glob header on each chunk, and a reranker (e.g. Cohere Rerank on Bedrock) if needed. ParadeDB's `pg_search` adds BM25 ranking if Postgres full-text ranking proves weak.

**Inputs**

- **Paste:** an *Add to knowledge* box on the board and an `ingest_text` MCP tool, so the Claude app can save a conversation, optionally linked to a glob.
- **Google Meet notes:** the Apps Script polling each person's Drive for Gemini notes and transcripts.
- **Slack:** a small Slack app with a *Send thread to slop* message shortcut (or a `:slop:` reaction); each thread is one communication. Channel-level ingestion can come later. A workspace admin approves the app's installation.
- **Legacy Google Docs:** a one-off Apps Script import, tagged legacy.

**Backfill (legacy tier)**

- Import every issue from the team's previous issue tracker (Jira is the first importer), with descriptions and comments, and the commits linked to each issue, as knowledge items, not globs.
- Generate one "why this changed" summary per issue from its text and linked commits, in batch.
- Skip commits without an issue link; agents find them with `git log`. Skip CodeBuild history.
- Legacy items keep their original dates, rank lowest, are excluded from context bundles unless nothing newer covers the topic, and are never used for decision extraction. The import window is chosen per board (e.g. the last 12–18 months).
- Decision extraction runs only on recent communications (about the last three months).
- All imports go through the canonical ingest endpoint via scripts, oldest first.

**Storage and search configuration** (starting point, to be tuned on real data)

- **Tables:** `knowledge_items`, one row per source item (board, `source_type`, title, `occurred_at`, `created_at`, authority tier, status, `superseded_by`, linked globs, external reference, text or S3 key for large originals); `chunks` (item, position, header, text, full-text, trigram and vector indexes); structured `test_runs`, `test_failures` and `build_failures` tables.
- **Chunk headers** contain only stable facts known at ingest: source type, date, title and section, e.g. `[Meeting · 2026-09-14 · "Sync retry design" · Decisions]`. Missing titles are written by the ingest LLM pass. Glob links are filterable metadata, not header text, so linking never forces re-embedding.
- **Chunk sizes:** about 300–600 tokens; Slack threads kept whole up to about 1,000 tokens.
- **Language:** English full-text configuration. Content in other languages still matches exact words and works in semantic search (Titan V2 is multilingual).
- **Embeddings:** Titan Text Embeddings V2, 1024 dimensions, cosine similarity, HNSW index in pgvector.
- **Keyword search:** Postgres full-text search plus a trigram index for identifiers, error strings and file paths.
- **Ranking (current mode):** recency decay with a 90-day half-life; authority weights; superseded items heavily down-ranked and labelled; legacy demoted. All-time mode removes recency decay.
- **Board search box:** reciprocal rank fusion of keyword and semantic results. **Chat:** Claude chooses among the tools; Cohere Rerank on Bedrock reorders the top 50 to the best 10.
- **Retrieval budget:** at most about 10 chunks or 8,000 tokens per search call.
- **Chat and agent tools:** `search_text`, `search_semantic`, `search_changes`, `get_glob`, `get_plan` (with versions), `get_change`, `get_build_results`, `get_test_results`.
- **Volume:** sized for a small team, around 7 hours of meetings a week; ingest costs stay at a few dollars a month.

## Build plan

Slop is built in vertical slices, each usable on its own. The checks above are verified as part of slice 1, and board mockups (card, glob view, System page) are produced at the start.

1. **Foundation and board:** Docker Compose with Postgres, Cognito sign-in, the MCP connector auth checks, globs, the state machine, manual moves and SSE live updates. *Done when:* a signed-in user creates a glob on the board, moves it, and a second browser sees the move live; the Claude app lists it through the MCP.
2. **GitHub App:** provisioning (branch, empty commit, draft PR with labels), webhooks with deduplication, PR and commit awareness, aging, observed merges, the outbox. *Done when:* a glob entering Doing gets a draft PR, and merging it in GitHub moves the glob to Reviewing.
3. **Minimal knowledge delivery:** `get_agent_set`, `sstor init`, the agent set imported from `catalog/agents/`, the knowledge base with the KB catalog, uploads and `import_knowledge` (a project's existing reference docs as the first import), `get_board`, `get_conventions` and a basic `get_context` (plan and attachments only). *Done when:* `sstor init` installs the agents into a fresh checkout and an agent reads a glob's plan and the board's build doc through MCP.
4. **Subs end to end:** intake, routine trigger with run IDs, the routines' agent-set refresh, sub gate, auto-merge, Reviewing with QA. *Done when:* a sub created from the board is implemented by a routine, passes the gate, merges and shows QA Required.
5. **Sames and sessionator:** start and pick-up rules, take over, `sstor --glob` / `--new` / `--ready` / `--merge`, local reviews, KB items, `/kb-bootstrap`. *Done when:* a same is picked up with sstor, implemented, marked ready and merged.
6. **Supers:** super mode, postplans, slop-started branch deploys. *Done when:* a super's pushes deploy to the developer's environment, and the postplan is updated at least at sstor --ready.
7. **Builds, ATF and deploys:** EventBridge, build failures, test results, environment indicators and ordering, CodeRabbit results. *Done when:* a failing build shows its error on the card and a deploy to a release environment is reflected on the globs it contains.
8. **Search, chat and context:** indexing, search modes, decisions and supersession, the full `get_context`, the board chat, the self-improvement pipeline (finding classification, mining, routing, effect checks). *Done when:* the chat answers "why did we decide X" with a cited source.
9. **Ingest and backfill:** Apps Script, Slack app, paste, legacy issue-tracker (Jira) and Google Docs import. *Done when:* a Meet note arrives in the inbox and attaches to a glob.
10. **Time tracking and reports:** event-log calculation and CSV downloads. *Done when:* the worked examples in Time tracking produce the expected hours.

## Open questions

No open questions block the first build. These are later considerations:

- [ ] **Environments:** boards start with their existing environments and add more later to make testing easier. Per-glob preview stacks sharing the dev database remain the leading idea: Lambdas, EventBridge and WebSocket API spun up via a CDK stage named after the glob, deployed on ready-for-review and destroyed on merge or delete, with additive data changes, per-stack event filtering and glob-prefixed test data.
- [ ] **QA coding agent (reminder):** discuss with the QA engineer as soon as there is something working to show. An agent that runs QA before or after changes reach master, building on the current QA process.
- [ ] **CodeRabbit (reminder):** buy a plan that includes MCP connections (Essentials or above) and connect it through the OAuth connector. Everything works without it until then.

**Verify while building slice 1 (each becomes an early implementation task)**

- [x] Claude app connector logs in through Cognito with a pre-registered client and calls an MCP tool (verified 2026-10-03). Two things were needed: the connector client allows both `https://claude.ai/api/mcp/auth_callback` and `https://claude.com/api/mcp/auth_callback` (claude.ai now uses the latter), and slop publishes its own authorization-server metadata pointing at Cognito's endpoints, because Cognito's discovery document omits `code_challenge_methods_supported`.
- [x] A routine calls the same tool through the account's connector (verified 2026-10-03: `list_globs`).
- [x] The routine fire response returns the cloud session ID and URL (`claude_code_session_id`, `claude_code_session_url`; verified 2026-10-04 when slop fired a routine).
- [x] Claude Code completes OAuth against Cognito with `--client-id` and `--callback-port` (verified 2026-10-03 against the dev pool: `whoami` over MCP).
- [x] A headless `claude -p` call to `create_glob` works with that login (covers sessionator; verified 2026-10-03, and a repeated idempotency key returns the same glob).
- [x] Cognito accepts the `resource` parameter MCP clients send, and slop accepts the resulting tokens by client ID (verified with Claude Code).
- [ ] Cowork works with a pre-registered client, if Cowork will be used.
- [ ] CodeRabbit connects to slop's MCP through its OAuth connector and calls the review-guide tool during reviews.
- [ ] A routine's cloud checkout registers the committed agent set at the start of its session, and the orchestrator's `get_agent_set` refresh writes and commits a newer version.
- [x] Slop's GitHub App can create a branch with an empty first commit and open a draft PR with labels (verified 2026-10-04 on a sandbox repo, through to an observed merge moving the glob to Reviewing).
- [ ] Run one test restore of the nightly Postgres backup.
- [ ] Search quality on a sample of real meetings and globs.
- [x] Bedrock: Haiku 4.5 available in the region and reliable for structured intake output (verified 2026-10-04: valid JSON in 2–4 s, about 500 tokens per intake).
