# Contributing to ppmagent

Thanks for your interest in contributing! This document covers how to get set
up, the quality bar, and how to propose changes.

By participating you agree to abide by our [Code of Conduct](CODE_OF_CONDUCT.md).

## Getting started

You'll need [Bun](https://bun.sh) ≥ 1.1 and [Task](https://taskfile.dev). For
running the agent end-to-end you'll also need the [`ppm`](https://github.com/ipedrazas/ppm)
and `dbxcli` binaries — but they are **not** required to build, typecheck, lint,
or test the codebase.

```sh
git clone https://github.com/ipedrazas/ppmagent
cd ppmagent
bun install        # or: task install
task check         # typecheck + lint + test — should be green
```

## Development workflow

1. Create a branch off `main`.
2. Make your change. Keep it focused — one logical change per PR.
3. Run the local gate before pushing:
   ```sh
   task check      # typecheck + lint + test
   task format     # apply Biome formatting
   ```
4. Add or update tests for behaviour you change. Pure modules (`config`, the
   `ppm` envelope parser, tool wiring) are unit-tested with `bun test`.
5. Open a pull request and fill in the template.

CI (GitHub Actions) runs the same `typecheck → lint → test` gate on every push
and PR. PRs must be green to merge.

## Code style

- **Language:** TypeScript on Bun, ES modules, explicit `.ts` import specifiers.
- **Formatting & linting:** [Biome](https://biomejs.dev) — `task format` fixes
  most things; `task lint` is the gate.
- **Types:** `strict` is on, plus `noUncheckedIndexedAccess`. Avoid `any` where a
  real type is knowable; the `pi` tool payloads are the documented exception.
- Match the surrounding code's naming, comment density, and idioms.

## Architecture conventions (please preserve)

These invariants come from the design docs in [`plans/`](plans) and keep the
agent from degrading into a "dumping ground":

- **Memory holds _why_; the tracker holds _what + status_.** Never mirror tracker
  status into memory.
- **Memory writes are type-addressable** over a closed set of entry types. Don't
  add a free-form write path.
- **Tracker vocabulary stays neutral** (task/project/status). Keep Linear/Jira
  names inside `src/tracker/databox.ts` so a tracker swap touches only that file.
- The agent **shells out to `ppm`**; it never writes memory files directly.

When in doubt, read [`plans/implementation-plan.md`](plans/implementation-plan.md).

## Commit messages

Write clear, imperative commit subjects ("Add tracker get-task tool"). Reference
issues where relevant. Conventional Commits are welcome but not required.

## Reporting bugs & requesting features

Use the GitHub issue templates. For anything security-sensitive, follow
[SECURITY.md](SECURITY.md) instead of opening a public issue.
