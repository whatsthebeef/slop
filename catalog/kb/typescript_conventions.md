---
catalog: typescript_conventions
version: 1
area: conventions
audience: [implementer, change_reviewer]
description: Baseline TypeScript conventions: compiler strictness, typing, errors, async code, modules and tests. Edit your board's copy to match the project.
---

# TypeScript conventions

A baseline for TypeScript projects. Your board's copy is yours: change anything that doesn't match the project, and add project rules (formatting, frameworks, naming) as new sections. Where the project's formatter or linter config disagrees with this document, the config wins.

## Compiler and tooling

- `strict: true`, plus `noUncheckedIndexedAccess` and `noImplicitOverride` where the codebase allows.
- The formatter (e.g. Prettier) and linter (e.g. ESLint with `typescript-eslint`) are the authority on style. Don't hand-format against them, and don't disable a rule inline without a comment saying why.
- No new `// @ts-ignore`. If a suppression is unavoidable, use `// @ts-expect-error` with the reason.

## Types

- No `any`. Use `unknown` for untrusted input and narrow it before use.
- No type assertions (`as`, `<T>`) or non-null assertions (`!`) to silence the compiler. Parse or narrow instead. Assertions are acceptable only where a validated boundary has already guaranteed the type, with a comment.
- Validate data at system boundaries (HTTP bodies, environment, files, third-party responses) with a schema (e.g. zod) and use the inferred type inside.
- Prefer `type` aliases and discriminated unions for domain states; make impossible states unrepresentable rather than guarded at runtime.
- Use `readonly` for data that shouldn't change, and `as const` for literal tables.
- Exported functions declare their return types.
- Don't widen types to make code compile; fix the type or the code.

## Naming

- `camelCase` for variables and functions, `PascalCase` for types, classes and components, `UPPER_SNAKE_CASE` only for true constants.
- Names say what something is in the domain's own words; avoid abbreviations except well-known ones (`id`, `url`).
- Booleans read as predicates (`isReady`, `hasAccess`).

## Errors

- Throw `Error` subclasses (or return typed result values where the codebase does), never strings or plain objects.
- Catch only where you can handle, add context to, or translate the error. No empty `catch` blocks.
- Keep error messages specific: what failed and with which identifier, without leaking secrets or personal data.

## Async code

- Every promise is awaited, returned or explicitly handled; no floating promises.
- Run independent work concurrently (`Promise.all`); keep dependent steps sequential.
- Pass `AbortSignal` or timeouts to network calls that can hang.

## Modules and structure

- One responsibility per module; keep side effects out of module top level.
- Named exports over default exports.
- Respect the project's layering (e.g. domain code doesn't import framework or infrastructure code). If a change needs to cross a layer, it belongs in the outer layer.
- No circular imports.

## Tests

- Tests sit where the project puts them and use its test framework's APIs only.
- Test behaviour through public interfaces, not private members.
- Tests are deterministic: fake timers and clocks, no real network, no reliance on test order.
- Test data is typed like production data; no `any` in fixtures or mocks.
