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
bun evals/run.ts --judge    # also run the phase-3 LLM judge (extra model calls)
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

## LLM judge (phase 3, TAV-115)

`analyzeSession`'s lints are mechanical — they catch shape violations (a batched
`ask_user`, a create with no rationale) but can't judge whether the clarifying question
was the *right* question, or whether a created task is actually well-scoped. `judge.ts`
closes that gap: it grades each `EvalOutcome` against a small rubric using the same
real, configured provider, via a `submit_score` tool call (forcing a structured 1-5
score + one-sentence rationale rather than free text).

Rubric criteria (`JUDGE_CRITERIA` in `judge.ts`) each declare which outcomes they apply
to, so an ORIENT case (which neither asks nor creates) is skipped rather than scored:

- **clarify-question-quality** — outcomes where the agent called `ask_user`: was the
  question specific to the missing acceptance criteria / metric / owner?
- **task-scoping-quality** — outcomes where the agent called `tracker_create_task`: does
  the created task carry clear acceptance criteria, a target metric, and an owner?

Enable with `--judge`; it's opt-in because it doubles the model calls for the cases it
grades. Scores are attached to the `--json` output as a top-level `judge` array
alongside the existing `outcomes` array (see `evals/run.ts`).
