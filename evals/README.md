# Evals

Phase 2 (TAV-114): does the real model, running under `SYSTEM_PROMPT`, actually follow
the operating rules — not just "does the wiring work given a scripted response" (that's
what `tests/integration/agent.integration.test.ts` already covers with pi's faux
provider).

Each case in `cases.ts` sends one prompt through `buildAgent` against the real,
configured provider and grades the resulting trace with `analyzeSession` (the same
linter `src/trace/extract.ts` runs over production session traces). Most cases exercise
CLARIFY: does the model ask ONE clarifying question on an under-specified request, or
does it guess a task into the backlog?

## Running

```
bun evals/run.ts            # human-readable report
bun evals/run.ts --json     # machine-readable
```

Requires:
- `ppm` on `PATH` (real memory backend — same requirement as the integration tests).
- A real API key for the configured provider (`ANTHROPIC_API_KEY` by default; see
  `src/config.ts` for `PPMA_PROVIDER`/`PPMA_MODEL` overrides).

Tracker (`dbxcli`) and ProteOS calls are pointed at a binary that always fails — no live
Linear/ProteOS credentials are needed. An attempted call still shows up in the trace as
an errored tool call, which is enough to grade "did it try to act instead of asking";
downstream tracker/ProteOS success is out of scope for this suite.

## Why this isn't in `bun test` / CI

It costs real tokens, hits a live model, and is non-deterministic — a flaky eval
failure is a signal to look at, not a broken build. Run it manually, or wire it into a
scheduled job if you want a trend line.
