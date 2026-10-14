---
catalog: risk_and_size
version: 1
area: risk_and_size
audience: [investigator, orchestrator, change_reviewer]
description: The board's one definition of risk tiers, risk areas, escalation criteria and what counts as a separate part. Agents and intake read it instead of carrying their own copies; edit it to change how the board judges risk and size.
---

# Risk and size

The investigator, the orchestrator (risk tier and escalation steps), the change_reviewer and intake's size check all read this document. Change a rule here and the next investigation, review and size check follow it.

## Risk tiers

The risk tier is set in Phase 2 and recorded in the plan file and the investigation block. It decides how many review rounds run (**high** 3, **normal** 2, **low** 1) and whether the tester runs.

- **high**: the change touches a risk area below, or auth, tokens or secrets, permissions, data and migrations, money, concurrency, or public endpoints.
- **normal**: everything else that changes behaviour.
- **low**: docs, copy, styling, config-only, tests-only, or a small isolated change.

When two tiers fit, take the higher one.

## Risk areas

Kinds of work that need a human to look. A change whose files match one is in the area: list it in `riskAreas` and treat the change as **high** risk. Slop learns this list from outcomes (reverted subs, bugs, failed deploys, subs that needed fixes), so the board's own list may be longer than this starting one.

- **Auth, tokens and secrets**: sign-in, sessions, API tokens, credentials, anything read from or written to a secret store.
- **Permissions**: roles, access checks, who may see or change what.
- **Data and migrations**: schema changes, migrations, backfills, deletes of existing data.
- **Money**: billing, pricing, payments, quotas.
- **Concurrency**: locks, queues, retries, ordering, anything run by more than one worker.
- **Public endpoints**: routes, webhooks and MCP tools callable from outside.
- **Agent instructions**: `.claude/`, the agent set and the catalog's agents.

<!-- Add board-specific areas as: **Name**: what it covers (path globs). -->

## Escalation criteria

A sub merges on its own once its checks and the gate pass, so escalate only with a concrete reason. **The default is to push through.** Escalate (or, for the investigator, set `needsHuman`) when:

- the change makes a product or design decision the plan didn't settle;
- it touches one of the risk areas above and the plan didn't settle it;
- it rewrites existing data (migrations, backfills, deletes);
- it changes auth, permissions or secrets handling;
- a test had to be weakened or deleted to get green;
- it changes agent instructions or the agent set;
- scope grew well beyond the plan;
- in-scope review findings remain after the allowed rounds.

Don't escalate for size alone (a large mechanical change, a rename across many files), for a plan that was followed, or "to be safe".

## What counts as a separate part

A part is a piece of the work that could ship and be reviewed on its own: it has its own files, its own "Done when", and the rest of the work doesn't need it merged first, or only needs it merged first (then it `needs` that part).

- Count separate parts for the investigation block's `parts` and for `## Workstreams`. Work that only makes sense as one change is **one part**, however many files it touches.
- Server, web and LLM work in one plan, several migrations, or large sections with no "Done when" are usually separate parts.
- **Too big for one PR**: more than 3 independent parts, or more than 5 tasks. Cut it into workstreams under `## Workstreams` (built in parallel inside one run and one PR; not a board split).
- Parts that share files or build on one another are chained with `needs`; parts that touch different code run in parallel.
