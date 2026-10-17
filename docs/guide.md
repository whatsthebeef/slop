# Slop guide

A short, practical guide to what slop does and when to use each part. The behaviour and architecture spec has the full detail; this guide says what each thing is and when you would reach for it.

## Globs and modes

A glob is one unit of work on a board. Every glob has an **actor** (a machine or a human) and a **mode**, which decides how the work flows. **Machine work** (a change, a fix, a piece of research) has the modes sub, same and super. **Human work** is done by a person and has the modes decision and action.

- **Sub:** a self-contained change one routine (an AI run) can build and merge in one pull request without a person making a design decision. It starts on its own and merges on its own when the sub review passes. Use it for bug fixes, small UI changes, follow-ups and small features that stay in one area. When in doubt, choose sub.
- **Same:** a standard task. It waits in Planning until someone presses Start (or picks it up), and a person merges the pull request. Use it when you want to look the work over before it merges. A routine can still do the implementing.
- **Super:** a person and a developer pairing on the work. It waits in Planning until a developer picks it up, no routine runs, and the developer implements it. Use it when the work needs a conversation.

By default only board admins choose sub or super; everyone else creates sames. You can change a type later while the glob is still parked in Planning (and sub to same at any point before it merges).

## Actor, mode, fix and work kind

When you create a glob you choose who does it (machine or human), then how (the actor's modes). There is no category picker.

| Actor | Modes |
| --- | --- |
| Machine | sub, same, super |
| Human | decision (something a person chooses, such as a learning to approve), action (something a person does, then marks done) |

The **fix flag** is worked out for you from the request and plan, shown as a small chip you can flip. It says the glob fixes something broken; it is a hint, and the agents decide from the investigation whether to reproduce first, find the root cause and write a regression test, or to build straight from the plan. A fix glob is never a super. The **work kind** (R&D or maintenance) is worked out silently and is only for the time report; an admin can correct it in the glob's details. Your correction sticks when the plan changes later. Nobody chooses between a feature and a task: all non-fix work is a task.

The ID letter is set at creation and never changes: `s1b3` for machine work with the fix flag, `s1t3` for every other machine glob, `s1k3` for a decision and `s1a3` for an action. Existing IDs keep their letters (old `s1f3` feature IDs stay as they are). The old category and type names still work in the MCP tools and API for one release; `feature` is accepted and stored as a task.

**Takes effect by deploying it or by doing it.** This is the dividing line between code work and an action. A change takes effect by deploying it when it ships through the pipeline and only works once deployed: that is a sub, same or super. It takes effect by doing it when someone has to run something against the live thing (an IAM grant, an account or GitHub setting, a one-off migration, a console change) and reverting the code would not undo or remove the need: that is an action. The **actor** is who finishes the glob: a machine's sub, same or super is finished by the machine, an action by a person. Intake, the New glob form and the investigation only suggest an action, because an action has no review gate; you confirm it.

An **action glob** has no pull request review, labels or environments. A plain one has no branch or run either. It is open until someone finishes it with Done (who and when are kept, with an optional note) or drops it with Dismiss (a reason is needed). A glob that must wait for it can hold on it, and either outcome lets that glob go. Its plan says Why, Do this (the script and the command to run), Permissions and Check it worked.

**A prepared action.** When an action's script, policy or document is itself work, create it with **Prepare it for me** (`prepare` in the API, `slop new --action --prepare`). A routine then does the preparation: it investigates, writes the script with a dry run and checks, reviews it locally and keeps it where you chose (**record**): a branch and PR in the repo (the default), a `rollout_script` artifact, or an attachment. It never runs the script, and never runs commands that change paid infrastructure or IAM. The card shows **preparing** (the machine, spinning) while it works and **ready to run** (a person) when it is done; the glob view shows the commands to run (`sstor --glob <id>` or `slop get-artifact <id> rollout_script` first). You run them, then press **Done** (who and when are kept, with an optional note) or **Failed…**, pasting the output (secrets are masked). Failed starts another preparation round in the same glob and on the same branch, and the routine reads your output first. A preparation that fails shows **preparation failed** with Retry. After Done, a branch record shows **recording** while slop merges the action's branch itself once the board's checks pass (no human review, no labels, no environments, no after-deploy steps), and then the action closes; an artifact or attachment record closes at once. Dismiss at any point closes the PR and deletes the branch without merging. An action that only runs a script another glob builds is not prepared: it waits for that glob to merge to the base branch, as before.

**When to use a once step instead.** If the change ships through the pipeline and also needs one one-shot command afterwards (a grant the new code needs), keep it a same with a **once** step on that glob, so the sign-off waits for it. If reverting the code would not remove the need, or nothing ships, it is an action.

**The revert test** (human steps versus actions). If this glob were reverted, would the work still be needed? No: it is a rollout step on this glob, a follow-up of this change that gates its sign-off. Yes, or it is about another repo or board, or it is optional setup: create an action glob (category `action`, no type: the human action mode) on the right board, with a relation if this change needs it first. Never file optional setup as a blocking step.

## Lists and statuses

The board has four lists: **Planning** (waiting to start), **Doing** (being implemented and reviewed in the pull request), **Reviewing** (merged and waiting for people to sign off) and **Signed off** (done). A glob moves by itself as things happen (a run starts, a pull request opens, it merges), and the buttons on the glob only appear when a manual move makes sense. The status on the card says exactly where it is, for example implementing, in progress, pull request open, merging, reviewing. When something holds a glob back, the status says what: "waiting · s15f145" for another glob, "waiting · decision s15k123" for a decision, "merge held · …" for a merge gate; a glob built in workstreams shows "working · 2/3 workstreams" (or the one that failed or waits for a decision), and a merged glob with open rollout steps shows "rollout" until they are done. The glob view shows the list beside the ID and the same status in its top right. **Arm system** (a rocket) marks a glob that needs a person at release; click it to filter the board to such globs. A failed run stays in Doing with a failed flag; slop never retries on its own.

## Sign-off labels: CR, QA and FR

After a glob merges it enters Reviewing with sign-off labels set to Required: **FR** (Functional Review), **CR** (Code Review) and **QA**. A sub gets QA only; a same or super gets all three. Each label is **Required** (waiting for the reviewer), **Added** (the reviewer added checklist items for the developer to work through) or **Approved**. The reviewer can draft items, send them, or approve. When every label is Approved the glob is signed off automatically. Use the labels to make sure the right person has looked at the result before the work counts as done. Labels are changed on the board, by people.

## Pick up, Start, Retry and Start again

These buttons answer "who works on this now?".

- **Start** starts a same that is waiting in Planning: slop opens the branch and pull request and queues a routine run. It is refused while something it waits for has not merged.
- **Pick up** makes you the implementer instead of a routine. Use it when a glob failed, or you want to do the work yourself. A super always waits in Planning until someone picks it up: Pick up (on the card or in the glob view) makes you the implementer, provisions the branch and copies `sstor --glob <id>`, which opens the pairing session on the branch once slop has created it (if the clipboard is refused, the notice shows the command to copy by hand). If a run is active, taking over asks for confirmation and ends that run. To pick up from a routine you own, use `sstor --glob <id>` (the *Continue locally* command on the run's row in the Activity log): sstor carries on the run's conversation in your terminal instead of starting afresh, and the cloud run stops. *Open in Claude* on the same row opens the run's session for viewing. When you pick up, slop writes a short hand-over note saying why a person is needed and what to do first.
- **Retry** runs a failed sub or same again on its existing branch.
- **Start again** (shown as Discard and restart) throws the current attempt away, closing the pull request and deleting the branch, and starts the glob from scratch. Use it when the existing attempt is the problem.
- **Start now** overrides a hold: use it to start a glob that is waiting for another glob when you know it is safe. An oversized flag is only advice and never holds a glob, so there is nothing to override for it.

## How slop merges

Slop squash-merges with the glob's ID in the title, one glob at a time: the merge line (a merge train). GitHub's merge queue isn't used.

- **Joining the line:** a glob joins when it is ready to merge: a sub whose checks and review passed with its merge armed, a same or super after you press Merge, or an agent-set glob. Nothing else is shown on the card for it: the Merge you pressed is done. Globs go in the order they joined, first come first served.
- **The head of the line:** only the glob at the front works. Slop updates its branch from the base branch (the repository's default branch) if it is behind, waits for the checks on the new head and squash-merges it. Then the next glob becomes the head. So each merge costs one round of checks, not one per glob ahead of it.
- **Waiting:** the others are not updated and their checks aren't rerun. The card reads "merging" for the head (or "running checks" while its checks run), "next to merge" for the second and "N ahead in the merge line" for the rest; hover it to see which globs are ahead. A new push to a waiting glob keeps its place, and the new head must pass before it merges.
- **When the head fails:** red checks, a conflict with the base branch (the glob goes back to the pull request as a conflict to resolve) or a merge GitHub refuses take the glob out of the line with the reason, and the next one goes. A head that gets no check result for 20 minutes is rechecked once, then leaves the line the same way. **Retry merge** puts a failed glob at the back of the line.
- **Relations:** a glob held by a `merge` relation or an open question isn't in the line and doesn't block the globs behind it. It joins, at the back, when it is released.
- **Cancel merge** (in the glob view's menu) takes a glob out of the line. The pull request stays open and Merge comes back.
- **Emergencies:** slop's GitHub App is on the ruleset's bypass list for emergencies only. The ruleset still requires the `checks` check on an up-to-date head, so main only receives commits whose checks passed.

## Relations and gates

A relation holds one glob back until another reaches a state. Each relation has a gate, which says what it guards:

- **start:** the glob cannot start until the other one has merged. This is "Start after" (also called a need: the glob uses code the other adds).
- **merge:** the glob cannot be merged until the other one has merged.
- **sign_off:** the glob cannot be signed off until the other one has.

Use a start relation when order matters, such as a glob that builds on another's code. Relations come from people, agents, and slop's own inference from the plans (which you can dismiss). Start now overrides inferred start holds only; it never overrides a merge or sign-off gate.

### What slop learns about relations

Slop keeps score of how often each kind of relation was right on your board, over the last 90 days. A relation was **needed** when the check after the merge finds the glob used code from the other one, a failed run says so, or you made a weak link a gate. It was **not needed** when someone forced it through (Start, Merge or Sign off anyway), dismissed it before it was met, or the post-merge check found nothing shared. A dependency was **missed** when a person added a relation later, two globs without one collided (a conflict, or a red main caused by both), or a run failed for code that was not merged yet.

A relation counts once: the first of an override, a dismissal, a promotion or the post-merge verdict is the one that is kept, and a group-wide hold is not counted as a missed dependency. From those counts slop works out precision (how many relations were needed) and recall (how many dependencies had a relation). If relations from **mentions** or **inference** are needed less than half the time, once there are at least five cases, slop stops making them hold anything back: they appear in Related under **May relate**, and **Make it a gate** turns one into a real relation in one click. If inference misses too many dependencies, it also suggests weak links for globs that touch the same modules. Relations from people, agents and failed runs always hold. With too little data slop keeps gating and says "not enough data".

Board settings, **Relations**, shows each source's numbers, window and posture, and why. Admins can pin a source to always gate or always make weak links, change the thresholds, the window or the minimum number of cases, and reset the pins; everyone else sees the numbers.

After a glob merges, slop checks each relation it had against the code and shows the verdict on the row in Related: "needed: uses `X` from s15t246", "not needed: no shared files, imports or symbols", or unsure. Git and the code index decide first; a model gives the verdict only when they cannot, at a small cost shown under the `relation_check` spend source.

## Breaking up a feature

A group is a name shared by several globs, such as the parts of a split. It has no status, branch or sign-off of its own: everything on its page comes from its globs.

- **The group page** (click the group label on a card or in a glob) shows progress as "3/5 merged", each glob with its status and type, who holds the move and what holds it, the relations between its globs (holding ones first, and ones that cross into another group flagged), and the open decisions that hold back a glob in it.
- **Progress on the card:** while a group has more than one open glob, its label reads "board-chat 3/5". The small filter button beside the label, or the board's filter pane, still shows only that group's cards.
- **Scope moves:** Add glob creates a glob in the group. Move out removes a glob from it and Move in adds one from the board; relations stay as they are, so a relation to a glob in another group shows as crossing. Rename changes the name on every glob; Merge moves all of them into another group.

## Splits and oversized globs

Slop checks the size of a glob when it is created or its plan changes. A glob is flagged **oversized** when it looks like more than one pull request of work and parts of it could be built at the same time. A serial plan stays whole, however long.

The flag **advises and never holds**. A flagged glob can start at once, and slop's proposal for it is a set of **workstreams**: shares of the work (a name, a goal, the files, its share of the plan and which workstreams it builds on) that the run builds in parallel inside the glob's one pull request. A glob is sized for review: one pull request, one QA pass and one sign-off. A flagged sub is made a same, so a person reviews it before it merges, and starts as usual. Slop learns the threshold from how flagged and unflagged globs turn out.

A **split** is a scope cut, not a way to parallelise: use it when the work holds pieces that could each ship alone. It turns one glob in Planning (no branch, run or pull request) into **independent globs**, each with its own plan, and with no parent. There is no gate between the parts and the original does not wait for them: part one keeps the original's ID and signs off on its own, like any glob. A part has needs only when you name them (the earlier parts it needs merged first); those are ordinary start relations that you can dismiss. Each part's plan says "Split from" the original; the glob view's Related section links them (the cards show nothing about a split).

## Questions, steps and decisions

Three records ask something of a person; use the one that fits.

- **Question:** a choice only this glob's work depends on (scope, approach, an assumption to confirm), with 2-4 options. Whoever raises it sets `blocking`: `start` holds the glob in Planning, `merge` lets the run go on but holds the merge, `none` is a notice. A question never holds sign-off, and its answer goes back into the glob's context.
- **Human step:** anything a person runs or does (commands, checks, pasting a result). A command to run is never a question; slop refuses a question from an agent or routine that tells a person to run a command in a code span with no options other than done or failed. A step's `blocks` say what it holds: `sign_off`, `reviewing` or `dependants`.
- **Decision glob:** a choice whose answer matters beyond this glob (a policy, a convention, something other globs follow or wait on). It is linked with a relation, and the relation's gate (start, merge or sign_off) says what it holds.

## Decision globs and Suggest

A decision glob (ID like `s1k4`) is a proposed change to what the project knows, usually a learning an agent submitted or slop found. It is not work: no branch, no pull request. A person decides it: accept, accept with edits, reject, or send it back for more work. Accepting changes the knowledge base or the agent set.

**Suggest** is a button for admins and product owners on a decision glob. It asks a model to read the proposal, its draft and related material, and recommend approve, approve with an edit, merge into another proposal, or reject, with a reason. **Apply** pre-fills the decide form with that recommendation. Nothing is decided until you confirm. Use Suggest when you want a second opinion before deciding.

## Learnings and the Knowledge page

A **learning** is a piece of guidance an agent or slop proposes: a gotcha, a pattern, a note on how an agent should behave, or a fact (how the system is now, after architecture or operations changed; approving it replaces the outdated description). Each one is a decision glob waiting for a person. When approved it is written into a knowledge document (project facts for agents to read) or an agent's own instructions. The **Knowledge page** shows the board's knowledge documents, the open proposals with their evidence and the diff they would make, and what was approved or rejected. Use it to review what the agents learned and keep the board's conventions accurate. Agents read approved knowledge at the start of each run.

**After every merge**, whoever built the glob, slop reads the merged diff and submits `fact` learnings for the architecture and operations changes it made (at most five; repeats of what a session already submitted are dropped). If the board lists its spec and guide files (`specPaths` in its merge policy) and the merge changed behaviour they describe without updating them, slop files one sub, "Update spec/guide for <glob>: <sections>", that holds back the glob's sign-off. Agent-set and docs-only merges are skipped, and the glob's history shows what the pass did ("post-merge: 2 facts submitted, spec drift: none").

## Settings and what slop has learned

**Settings** holds what you choose for the board, in six groups you can open and close (the page remembers which, for you): Board and repository, Members and access, Environments and deploys (the dev environments slop deploys glob branches to; the base branch is the repo's default branch on GitHub, not a setting), Automation, Reports, and System at the bottom (collapsed; what the server can do, read-only). Under each setting's name is a line saying what it does.

What slop has worked out for itself is not in Settings. It is on the **Knowledge page**, under **What slop has learned**, one panel per topic: Size, Subs, Risk areas, Escalation criteria, Dependency rules, Intake, Context tuning and Learning jobs. Open a panel to see the current value in plain words, the default it started from and, collapsed, the history of changes with their causes. Everyone on the board can read them; admins can also reset a value to its default or run its learning job now. Old links to these parts on the Settings page take you to the matching panel.

## Watch signals and effect checks

Slop looks for patterns in how work goes (for example the same kind of review finding appearing again and again) and raises a learning when one is frequent enough. That pattern is a **signal**.

An **effect check** is slop's follow-up after you approve such a change. It keeps measuring the same signal over the next globs that ran with the change. If the signal has not dropped after a set number of globs, or another signal got markedly worse, slop raises a proposal to revise or revert the change, with before and after figures. People still decide.

A **watch signal** is how you pick the signal to measure when you approve a submitted learning, one an agent wrote and slop did not mine. Choose one of the board's signals in the Watch signal field when approving, and slop starts an effect check for it. The default is none. Use a watch signal when the learning is meant to fix something that slop can measure, so you will find out whether it worked. A learning that already has a signal is checked on that signal, so there is nothing to pick. Some signals are not measured by effect checks (dependency signals and the knowledge page's correction signals), and they are not offered.

## Human steps

A human step is something only a person can do on a glob, and it is one of three kinds: **Decide** (a decision's outcome, or a QA/CR/FR review label), **Answer** (a question within the glob) or **Do** (a command or task, such as a rollout after a deploy). Merging, fixing a conflict, uploading a missing file, retrying or taking over a stuck run, and picking up a super are slop's own next moves: they are the glob's main button and its corner status, not steps. A glob waiting on a person shows one word top right (**question** for an Answer, **do** for a Do, **decide** for a Decide); the step's title and the count of the others are in the tooltip. Slop works the steps out from the glob's state and lists them in one place, including your turn view, so you can see what is waiting on you. You can also add your own steps to a glob with a title, who it is for and when it is due. A step can be done or dismissed with a reason. Use human steps to make manual work, such as a database change after deploy, visible instead of living in someone's head. A human step belongs to the glob that needs it and gates its sign-off; use an action glob instead when the work stands on its own, belongs to another repo or board, or is optional (see the revert test under Categories).

**Where a step runs.** Steps run on the glob's dev environment (the one slop deploys its branch to) or, when the glob has none, against the base branch (the repo's default branch). Board environments are only the dev environments; slop does not track deploys to int, staging or prod. A step that must also run as the change is released further carries the **downstream** flag. Slop then adds one more step, "Run on <the rest of the pipeline> as each is released: <title>", that blocks nothing (not sign-off, not dependants, not merge), keeps **Arm system** on the glob while it is open, even after sign-off (the glob stays in Signed off until it is ticked), and is ticked by you when you have run it. Steps after the merge hold back the sign-off and dependants; a step on a dev environment holds back nothing unless the step says so. A step in Merging never looks due: slop merges once checks pass, and the rollout comes after.

**Once steps, and steps that name an environment.** Work either takes effect by deploying it (shipped through the pipeline) or by doing it (someone runs it against the live thing: an IAM grant, an account or GitHub setting). A command that does not depend on an environment and is run one time is a **once** step: add it as `once` (or `due: once`), or end its title in the record's Rollout with `(once)`. A once step has no environment, is due as soon as its script is on the glob's branch (at once when it has no script), not after the merge or a deploy, holds back the sign-off until it is done or dismissed, and once done it stays done: a later step that fails and starts the glob's next generation does not bring it back. It shows in the "A step needs you" block with a **once** marker. Every other step is on a dev environment (`after_deploy:<environment>`), due when the glob's branch is deployed there (which can be before the merge), and the environment must be one the board lists: slop refuses any other, with the board's names in the message. A step in a record's Rollout naming an environment the board lacks is filed after the merge, says why in its detail, and can be dismissed. The glob view flags existing steps whose environment the board no longer has, so you can dismiss them and add them again for a real one.

The Human steps section shows steps that are due in the "A step needs you" block, and the others as quiet lines. The **Arm system** label shows on the glob while any rollout step is open, including a downstream step and even after sign-off; it reads plain "Arm system" (no environment name) and goes when every step is done or dismissed.

## Attachments

Attachments are extra context on a glob: text, links (such as a document or a chat thread, which slop fetches and keeps as a snapshot), or uploaded files. Agents read them with the plan, and they are searchable. Use them for designs, meeting notes, clarifications and assumptions, or logs. Files are uploaded through the board; links and text can also be added from a session. Attachments and the plan are versioned, so earlier versions are kept.

## The board chat

The chat panel, opened from the board, answers questions in plain words. It searches the board's records (plans, decisions, implementation records, reviews, knowledge and the board's live state) and slop's own help (this guide, the spec and the agent catalog), and cites each source with a number you can click. On a board with a repository it can also read the code.

- A **cited** answer comes from the sources it names.
- An answer under **Not from the board's records** has no source. Treat it as a best guess, not a fact about your board.
- When the first search finds nothing cited, the chat tries again before giving up, within a small step budget: a second search with other words and all time included, then the code (on a board with a repository), then the stronger model. It stops at the first cited answer, shows progress while it works ("Searching again…", "Looking at the code…") and lists each step under the answer.
- When nothing answers, the chat says what it searched and offers **Think harder** (one answer from a stronger model), **Look at the code** (on a board with a repository) and **Create a glob**.
- **Save to knowledge** turns a cited answer into a learning proposal. The Include history box makes a question search older and replaced material too.

Use the chat to find out why something was decided, what changed, what is open, or how a part of slop works. Each person's conversations are private to them.

## sstor basics

`sstor` is the command-line tool developers use on their own machine. `sstor init` fetches the board's agent set (agents, commands, hooks and settings) into a checkout and records its version. `sstor --new` creates a glob; add `--super` for a super. `sstor --glob <id>` opens a session working on a glob, and `sstor --ready` and `sstor --derge` wait for a glob's finalise step before marking it ready or merging. Use sstor when you want to implement or review a glob locally. Everything it does goes through the same slop rules as the board, so the two stay consistent.
