---
catalog: review_guide_template
version: 1
area: review_guide
audience: []
description: What an automated PR reviewer (CodeRabbit) should check on this project, served by get_review_guide. Template — replace every <placeholder> in your board's copy.
---

# Review guide

What a PR reviewer, such as CodeRabbit, should look for on this project. Slop serves this document through the `get_review_guide(repo)` MCP tool. A board that has a document in the `review_guide` area counts as having a review guide: when the repo's `.coderabbit.yaml` turns CodeRabbit's automatic reviews off (`reviews.auto_review.enabled: false`), slop posts `@coderabbitai review` on each PR once it is ready for review.

This is not the change_reviewer's checklist (area `review`); keep the two consistent, but this one is written for a reviewer that only sees the PR.

## Architecture rules

- <e.g. domain code imports nothing from frameworks or infrastructure>
- <e.g. every write goes through an application service>

## Things that must never happen

- <e.g. secrets, tokens or personal data in logs or error messages>
- <e.g. a migration that isn't idempotent>

## Project conventions worth flagging

- <naming, error handling, test placement>

## Out of scope for review comments

- <e.g. formatting the formatter owns; generated files under <path>>
