---
catalog: environments_template
version: 4
area: environments
audience: [implementer, tester, change_reviewer]
description: The board's dev (branch-deploy) environments and what each is for, plus the rest of the pipeline. Template — replace every <placeholder> in your board's copy.
---

# Environments

What each of this project's dev environments is for, so agents know where a glob's work runs and what they may touch. Board environments are the dev environments that take glob branch deploys; their names and deploy projects are set in board settings, and this document says what they mean. Agents never deploy by hand: slop deploys a glob's branch to its dev environment on each push, through the board's deploy integration and the repo's `.sstor/deploy.sh <env>`. The base branch is the repo's default branch on GitHub.

## Dev environments

Each takes glob branches; the last successful deploy is what runs there, and another glob's push can replace it.

| Environment | Used for | Shared with | Data | Notes |
| --- | --- | --- | --- | --- |
| <dev1> | <a developer's own work> | <nobody / the team> | <dev database, seeded> | <e.g. reset nightly> |
| <dev2> | <another dev environment> | <routines> | <dev database> | |

Rest of the pipeline: <int, staging, prod> (listed in release order; slop doesn't deploy to or track them, and a step flagged `downstream` is worded with these names).

## Off limits

<Anything agents must never do to an environment: e.g. run migrations against production, write to shared buckets, change DNS.>

## Checking a deploy

<How to tell a deploy worked: URLs per environment, health checks, logs.>
