---
catalog: python_conventions
version: 1
area: conventions
audience: [implementer, change_reviewer]
description: Baseline Python conventions: tooling, typing, errors, structure, async code and tests. Edit your board's copy to match the project.
---

# Python conventions

A baseline for Python projects. Your board's copy is yours: change anything that doesn't match the project, and add project rules (frameworks, layout, naming) as new sections. Where the project's formatter, linter or type-checker config disagrees with this document, the config wins.

## Tooling

- The project's formatter and linter (e.g. Ruff, or Black plus Flake8) are the authority on style. Don't hand-format against them, and don't add `# noqa` without the rule code and a reason.
- Type-check with the project's checker (e.g. mypy or Pyright) in strict mode where the codebase allows. No new `# type: ignore` without the error code and a reason.
- Dependencies are declared in the project's manifest (e.g. `pyproject.toml`) and locked; never install ad hoc in code or scripts.

## Typing

- Annotate every public function, method and class attribute; private helpers too where it helps.
- Avoid `Any`. Use `object` or a `Protocol` for "anything with this shape", and narrow before use.
- Use `dataclasses`, `TypedDict`, `Enum` or the project's model library (e.g. Pydantic) for structured data instead of loose dicts and tuples.
- Validate data at system boundaries (HTTP bodies, environment, files, third-party responses) and use typed objects inside.
- Prefer `X | None` over implicit `None` returns.

## Naming

- `snake_case` for functions, variables and modules; `PascalCase` for classes; `UPPER_SNAKE_CASE` for module constants.
- A leading underscore marks anything not part of a module's public interface.
- Names say what something is in the domain's own words.

## Errors

- Raise specific exception types (the project's own or built-in ones), never bare `Exception`.
- Catch only what you can handle; never `except:` or `except Exception: pass`. Re-raise with `raise ... from err` to keep the cause.
- Use `with` for anything that must be closed or released.
- Log with the `logging` module, not `print`, and never log secrets or personal data.

## Structure

- One responsibility per module; no work at import time beyond definitions.
- Respect the project's layering (e.g. domain code doesn't import web framework or database code).
- No mutable default arguments; no global mutable state.
- Prefer pure functions and explicit dependencies (passed in) over hidden singletons.

## Async code

- Don't call blocking I/O inside `async` functions; use the async client or run it in a thread.
- Every coroutine is awaited or scheduled with its task kept and handled.
- Set timeouts on network calls.

## Tests

- Use the project's test framework (e.g. pytest) and its fixtures; tests sit where the project puts them.
- Test behaviour through public interfaces.
- Tests are deterministic: no real network, frozen time where it matters, no reliance on test order.
- Parametrise instead of copying tests with small differences.
