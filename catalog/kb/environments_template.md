---
catalog: environments_template
version: 3
area: environments
audience: [implementer, tester, change_reviewer]
description: The board's environments and what each is for (branch deploys, integration, release, production). Template — replace every <placeholder> in your board's copy.
---

# Environments

What each of this project's environments is for, so agents know where a glob's work runs and what they may touch. Environments themselves (names, which take branch deploys, the default for subs) are set in board settings; this document says what they mean. Agents never deploy by hand: slop deploys a glob's branch to its environment on each push, through the board's deploy integration and the repo's `.sstor/deploy.sh <env>`.

## Branch-deploy environments

Each takes glob branches; the last successful deploy is what runs there, and another glob's push can replace it.

| Environment | Used for | Shared with | Data | Notes |
| --- | --- | --- | --- | --- |
| <dev1> | <a developer's own work> | <nobody / the team> | <dev database, seeded> | <e.g. reset nightly> |
| <dev2> | <subs (the default for subs)> | <routines> | <dev database> | |

## Integration

<The environment the base branch's own pipeline deploys after each merge, e.g. staging. Slop observes it; it never deploys glob branches there.>

Give it the `integration` role in board settings. Its pipeline reports each deploy with `.sstor/report-deploy.sh <environment>` (from the slop catalog), and slop then shows the environment on every glob whose merge commit the deployed commit contains.

## How deploys are known

Each observed environment (one with a role) says in board settings how slop learns of its deploys:

- **Pipeline** (the default): the pipeline reports each deploy with `report-deploy.sh`. An environment that has never reported says so on the board, with the line to add.
- **Manual**: nobody's pipeline deploys it, so a person records each release in slop (**Record a deploy to <env>** in the board header's environments panel, or on the environment's settings row), choosing a branch, tag or commit. Slop then treats it as a reported deploy: contained globs show the environment on their cards and their `after_deploy:<env>` steps fall due. A glob's own **Mark deployed to <env>** stays for one-offs.

Say here which of your environments are manual. When you write a rollout step for a manual environment, remember it falls due only once someone records the release, not when a pipeline finishes.

## Release and production

<Release environments and how releases are cut. Production deploys are manual; say who may run them and how.>

Give each the `release` role in board settings, and mark the production one. Their pipelines report deploys with `.sstor/report-deploy.sh` too, or, when the release is cut by hand, set the environment to manual and record each release in slop. Deploying to production before a glob is signed off is allowed, but its card warns about it.

## Off limits

<Anything agents must never do to an environment: e.g. run migrations against production, write to shared buckets, change DNS.>

## Checking a deploy

<How to tell a deploy worked: URLs per environment, health checks, logs.>
