# Slop guide

A short, practical guide to what slop does and when to use each part. The behaviour and architecture spec has the full detail; this guide says what each thing is and when you would reach for it.

## Globs and modes

A glob is one unit of work on a board. Every glob has an **actor** (a machine or a human) and a **mode**, which decides how the work flows. **Machine work** (a change, a fix, a piece of research) has the modes sub, same and super. **Human work** is done by a person and has the modes decision and action.

- **Sub:** a self-contained change one routine (an AI run) can build and merge in one pull request without a person making a design decision. It starts on its own and merges on its own when the sub review passes. Use it for bug fixes, small UI changes, follow-ups and small features that stay in one area. When in doubt, choose sub.
- **Same:** a standard task. It waits in Planning until someone presses Start (or picks it up), and a person merges the pull request. Use it when you want to look the work over before it merges. A routine can still do the implementing.
- **Super:** a person and a developer pairing on the work. It goes straight to Doing, no routine runs, and the developer implements it. Use it when the work needs a conversation.

By default only board admins choose sub or super; everyone else creates sames. You can change a type later while the glob is still parked in Planning (and sub to same at any point before it merges).

## Actor, mode, fix and work kind

When you create a glob you choose who does it (machine or human), then how (the actor's modes). There is no category picker.

| Actor | Modes |
| --- | --- |
| Machine | sub, same, super |
| Human | decision (something a person chooses, such as a learning to approve), action (something a person does, then marks done) |

The **fix flag** is worked out for you from the request and plan, shown as a small chip you can flip. It says the glob fixes something broken; it is a hint, and the agents decide from the investigation whether to reproduce first, find the root cause and write a regression test, or to build straight from the plan. A fix glob is never a super. The **work kind** (R&D or maintenance) is worked out silently and is only for the time report; an admin can correct it in the glob's details. Your correction sticks when the plan changes later. Nobody chooses between a feature and a task: all non-fix work is a task.

The ID letter is set at creation and never changes: `s1b3` for machine work with the fix flag, `s1t3` for every other machine glob, `s1k3` for a decision and `s1a3` for an action. Existing IDs keep their letters (old `s1f3` feature IDs stay as they are). The old category and type names still work in the MCP tools and API for one release; `feature` is accepted and stored as a task.

An **action glob** has no branch, pull request or run. It is open until someone finishes it with Done (who and when are kept, with an optional note) or drops it with Dismiss (a reason is needed). A glob that must wait for it can hold on it, and either outcome lets that glob go. Its plan says Why, Do this (the script and the command to run), Permissions and Check it worked.

**The revert test** (human steps versus actions). If this glob were reverted, would the work still be needed? No: it is a rollout step on this glob, a follow-up of this change that gates its sign-off. Yes, or it is about another repo or board, or it is optional setup: create an action glob (category `action`, no type: the human action mode) on the right board, with a relation if this change needs it first. Never file optional setup as a blocking step.

## Lists and statuses

The board has four lists: **Planning** (waiting to start), **Doing** (being implemented and reviewed in the pull request), **Reviewing** (merged and waiting for people to sign off) and **Signed off** (done). A glob moves by itself as things happen (a run starts, a pull request opens, it merges), and the buttons on the glob only appear when a manual move makes sense. The status on the card says exactly where it is, for example implementing, in progress, pull request open, merging, reviewing. When something holds a glob back, the status says what: "waiting · s15f145" for another glob, "waiting · decision s15k123" for a decision, "merge held · …" for a merge gate; a glob built in workstreams shows "working · 2/3 workstreams" (or the one that failed or waits for a decision), and a merged glob with open rollout steps shows "rollout" until they are done. The glob view shows the list beside the ID and the same status in its top right. **Arm system** (a rocket) marks a glob that needs a person at release; click it to filter the board to such globs. A failed run stays in Doing with a failed flag; slop never retries on its own.

## Sign-off labels: CR, QA and FR

After a glob merges it enters Reviewing with sign-off labels set to Required: **FR** (Functional Review), **CR** (Code Review) and **QA**. A sub gets QA only; a same or super gets all three. Each label is **Required** (waiting for the reviewer), **Added** (the reviewer added checklist items for the developer to work through) or **Approved**. The reviewer can draft items, send them, or approve. When every label is Approved the glob is signed off automatically. Use the labels to make sure the right person has looked at the result before the work counts as done. Labels are changed on the board, by people.

## Pick up, Start, Retry and Start again

These buttons answer "who works on this now?".

- **Start** starts a same that is waiting in Planning: slop opens the branch and pull request and queues a routine run. It is refused while something it waits for has not merged.
- **Pick up** makes you the implementer instead of a routine. Use it when a glob failed, or you want to do the work yourself. On a super parked in Planning the button reads Pick up to pair. If a run is active, taking over asks for confirmation and ends that run. When you pick up, slop writes a short hand-over note saying why a person is needed and what to do first.
- **Retry** runs a failed sub or same again on its existing branch.
- **Start again** (shown as Discard and restart) throws the current attempt away, closing the pull request and deleting the branch, and starts the glob from scratch. Use it when the existing attempt is the problem.
- **Start now** overrides a hold: use it to start a glob that is waiting for another glob when you know it is safe. An oversized flag is only advice and never holds a glob, so there is nothing to override for it.

## Relations and gates

A relation holds one glob back until another reaches a state. Each relation has a gate, which says what it guards:

- **start:** the glob cannot start until the other one has merged. This is "Start after" (also called a need: the glob uses code the other adds).
- **merge:** the glob cannot be merged until the other one has merged.
- **sign_off:** the glob cannot be signed off until the other one has.

Use a start relation when order matters, such as a glob that builds on another's code. Relations come from people, agents, and slop's own inference from the plans (which you can dismiss). Start now overrides inferred start holds only; it never overrides a merge or sign-off gate.

## Breaking up a feature

A group is a name shared by several globs, such as the parts of a split. It has no status, branch or sign-off of its own: everything on its page comes from its globs.

- **The group page** (click the group label on a card or in a glob) shows progress as "3/5 merged", each glob with its status and type, who holds the move and what holds it, the relations between its globs (holding ones first, and ones that cross into another group flagged), and the open decisions that hold back a glob in it.
- **Progress on the card:** while a group has more than one open glob, its label reads "board-chat 3/5". The small filter button beside the label, or the board's filter pane, still shows only that group's cards.
- **Scope moves:** Add glob creates a glob in the group. Move out removes a glob from it and Move in adds one from the board; relations stay as they are, so a relation to a glob in another group shows as crossing. Rename changes the name on every glob; Merge moves all of them into another group.

## Splits and oversized globs

Slop checks the size of a glob when it is created or its plan changes. A glob is flagged **oversized** when it looks like more than one pull request of work and parts of it could be built at the same time. A serial plan stays whole, however long.

The flag **advises and never holds**. A flagged glob can start at once, and slop's proposal for it is a set of **workstreams**: shares of the work (a name, a goal, the files, its share of the plan and which workstreams it builds on) that the run builds in parallel inside the glob's one pull request. A glob is sized for review: one pull request, one QA pass and one sign-off. A flagged sub is made a same, so a person reviews it before it merges, and starts as usual. Slop learns the threshold from how flagged and unflagged globs turn out.

A **split** is a scope cut, not a way to parallelise: use it when the work holds pieces that could each ship alone. It turns one glob in Planning (no branch, run or pull request) into **independent globs**, each with its own plan, and with no parent. There is no gate between the parts and the original does not wait for them: part one keeps the original's ID and signs off on its own, like any glob. A part has needs only when you name them (the earlier parts it needs merged first); those are ordinary start relations that you can dismiss. Each part's plan says "Split from" the original; the glob view's Related section links them (the cards show nothing about a split).

## Decision globs and Suggest

A decision glob (ID like `s1k4`) is a proposed change to what the project knows, usually a learning an agent submitted or slop found. It is not work: no branch, no pull request. A person decides it: accept, accept with edits, reject, or send it back for more work. Accepting changes the knowledge base or the agent set.

**Suggest** is a button for admins and product owners on a decision glob. It asks a model to read the proposal, its draft and related material, and recommend approve, approve with an edit, merge into another proposal, or reject, with a reason. **Apply** pre-fills the decide form with that recommendation. Nothing is decided until you confirm. Use Suggest when you want a second opinion before deciding.

## Learnings and the Knowledge page

A **learning** is a piece of guidance an agent or slop proposes: a gotcha, a pattern, or a note on how an agent should behave. Each one is a decision glob waiting for a person. When approved it is written into a knowledge document (project facts for agents to read) or an agent's own instructions. The **Knowledge page** shows the board's knowledge documents, the open proposals with their evidence and the diff they would make, and what was approved or rejected. Use it to review what the agents learned and keep the board's conventions accurate. Agents read approved knowledge at the start of each run.

## Settings and what slop has learned

**Settings** holds what you choose for the board, in six groups you can open and close (the page remembers which, for you): Board and repository, Members and access, Environments and deploys, Automation, Reports, and System at the bottom (collapsed; what the server can do, read-only). Under each setting's name is a line saying what it does.

What slop has worked out for itself is not in Settings. It is on the **Knowledge page**, under **What slop has learned**, one panel per topic: Size, Subs, Risk areas, Escalation criteria, Dependency rules, Intake, Context tuning and Learning jobs. Open a panel to see the current value in plain words, the default it started from and, collapsed, the history of changes with their causes. Everyone on the board can read them; admins can also reset a value to its default or run its learning job now. Old links to these parts on the Settings page take you to the matching panel.

## Watch signals and effect checks

Slop looks for patterns in how work goes (for example the same kind of review finding appearing again and again) and raises a learning when one is frequent enough. That pattern is a **signal**.

An **effect check** is slop's follow-up after you approve such a change. It keeps measuring the same signal over the next globs that ran with the change. If the signal has not dropped after a set number of globs, or another signal got markedly worse, slop raises a proposal to revise or revert the change, with before and after figures. People still decide.

A **watch signal** is how you pick the signal to measure when you approve a submitted learning, one an agent wrote and slop did not mine. Choose one of the board's signals in the Watch signal field when approving, and slop starts an effect check for it. The default is none. Use a watch signal when the learning is meant to fix something that slop can measure, so you will find out whether it worked. A learning that already has a signal is checked on that signal, so there is nothing to pick. Some signals are not measured by effect checks (dependency signals and the knowledge page's correction signals), and they are not offered.

## Human steps

A human step is something only a person can do on a glob: merge a ready same, resolve a conflict, decide a decision, sign off, pair on a super, upload a missing file, or run a rollout after a deploy. Slop works these out from the glob's state and lists them in one place, including your turn view, so you can see what is waiting on you. You can also add your own steps to a glob with a title, who it is for and when it is due. A step can be done or dismissed with a reason. Use human steps to make manual work, such as a database change after deploy, visible instead of living in someone's head. A human step belongs to the glob that needs it and gates its sign-off; use an action glob instead when the work stands on its own, belongs to another repo or board, or is optional (see the revert test under Categories).

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
