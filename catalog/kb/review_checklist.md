---
catalog: review_checklist
version: 1
area: review
audience: [change_reviewer]
description: Language-agnostic code review checklist for the change_reviewer. Add project-specific items to your board's copy.
---

# Review checklist

Applies to every changed file, in any language. The board's conventions documents add language and framework rules on top; check those too. Add project-specific items (framework patterns, house rules) to your board's copy as new sections.

## Requirements

- [ ] Every acceptance criterion ("Done when" line) is met, or its absence is explained.
- [ ] Bugs: the root cause is fixed, not only the symptom, and a regression test reproduces the original bug.
- [ ] Nothing beyond the glob's scope was changed without a recorded reason (plan amendment).

## Correctness

- [ ] Edge cases: empty, missing, duplicate, very large and boundary values.
- [ ] Error paths are handled where they can be, and propagate with context where they can't.
- [ ] Concurrency: no races on shared state; retries are idempotent.
- [ ] Time and dates: time zones explicit, no reliance on the server's local time.

## Security and privacy

- [ ] Input from users, files, the network and third parties is validated at the boundary.
- [ ] No injection (SQL, shell, template, path), XSS or unsafe deserialisation.
- [ ] Authorisation is checked for every new operation, on the server side.
- [ ] No secrets in code, config, logs or test fixtures.
- [ ] Personal data is not newly exposed, logged or retained beyond what the feature needs.

## Design and consistency

- [ ] Follows the project's existing patterns, layering and naming; no parallel way of doing something that already has one.
- [ ] No dead code, commented-out code or leftover debugging.
- [ ] Public interfaces changed deliberately, with callers updated.

## Tests

- [ ] New behaviour has tests at the level the project uses for it (unit, integration, end to end).
- [ ] Tests are deterministic and test behaviour, not implementation details.
- [ ] No tests were deleted or weakened to make the build pass.

## Performance

- [ ] No queries or network calls inside loops where a batch would do; indexes exist for new query patterns.
- [ ] No unbounded loads into memory.

## Dependencies

- [ ] New dependencies are justified, maintained and licence-compatible.
- [ ] Manifest and lockfile changes are expected and in sync.
