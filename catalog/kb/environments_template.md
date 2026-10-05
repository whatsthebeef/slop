---
catalog: environments_template
version: 1
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

## Release and production

<Release environments and how releases are cut. Production deploys are manual; say who may run them and how.>

## Off limits

<Anything agents must never do to an environment: e.g. run migrations against production, write to shared buckets, change DNS.>

## Checking a deploy

<How to tell a deploy worked: URLs per environment, health checks, logs.>
