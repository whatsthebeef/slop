---
catalog: review_guide_template
version: 1
area: review_guide
audience: []
description: What an automated PR reviewer should check on this project, served by get_review_guide. Template — replace every <placeholder> in your board's copy.
---

# Review guide

What a PR reviewer should look for on this project. Slop serves this document through the `get_review_guide(repo)` MCP tool.

This is not the change_reviewer's checklist (area `review`); keep the two consistent, but this one is written for a reviewer that only sees the PR.

## Architecture rules

- <e.g. domain code imports nothing from frameworks or infrastructure>
- <e.g. every write goes through an application service>

## Things that must never happen

- <e.g. secrets, tokens or personal data in logs or error messages>
- <e.g. a migration that isn't idempotent>

## Project conventions worth flagging

- <naming, error handling, test placement>

## Spec and guide drift

- A change to behaviour that the project's spec or guide (<e.g. docs/spec.md, docs/guide.md>) describes must update the matching section; flag a missing or stale update and name the section.

## Out of scope for review comments

- <e.g. formatting the formatter owns; generated files under <path>>
