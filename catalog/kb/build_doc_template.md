---
catalog: build_doc_template
version: 1
area: build
audience: [implementer, tester, change_reviewer]
description: The board's build, test, lint, format and dependency-check commands. Template — replace every <placeholder> in your board's copy.
---

# Build, test and lint commands

The commands agents use for this project. Agents never guess these: if something is missing here, they work it out from the repo, say so in their reports, and submit a learning proposing the addition. Run every command from the repo root unless it says otherwise.

## Install

```bash
<install command, e.g. pnpm install --frozen-lockfile | uv sync --frozen>
```

## Build

```bash
<full build>
```

## Test

```bash
<full test suite>
<targeted test run for one file or test, with an example>
```

Notes: <slow suites to avoid running in full, required services (e.g. a database in Docker), environment variables tests need>

## Format

Run before committing:

```bash
<format command>
```

## Lint and type check

```bash
<lint command>
<type check command, if separate>
```

## Dependency checks

```bash
<vulnerability audit, e.g. pnpm audit | pip-audit>
<lockfile-in-sync check, e.g. pnpm install --frozen-lockfile | uv lock --check>
```

Lockfile: `<lockfile path>`. Changes to it on a branch must be expected.

## Local server

```bash
<command to run the app locally, if any>
```

## Notes

- <package manager or toolchain version requirements>
- <known quirks, e.g. caches to disable or flags needed on some platforms>
