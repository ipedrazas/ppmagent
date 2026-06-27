# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **Phase 5 — Telegram adapter + durable session.** A minimal fetch-based
  Telegram Bot API client, a file-backed `SessionStore` (sessionId + active
  project + transcript), and a real `TelegramBot` run loop: each message →
  `agent.prompt`, replies are the assistant text or the `ask_user` question,
  `/project <slug>` switches the active project, compaction runs after each turn,
  and the session is restored on restart. New config: `PPMA_SESSION_FILE`.
  Integration tests (faux model + fake client) cover `/project`, the clarify
  flow over Telegram, and restart continuity; client/store have unit tests.
- **Phase 4 — compaction trigger + flush.** `src/compaction.ts`: a token-threshold
  policy (`shouldCompactNow` via `estimateContextTokens`), `maybeCompact`
  (trigger → flush durable facts → summarize older transcript, keep recent tail),
  an injected `Summarizer` (model-free default + a `generateSummary`-backed one).
  An integration test proves spike claim 4: a decision recorded before compaction
  is absent from the summarized transcript yet still recalled via
  `transformContext` from `ppm`, and the flush writes a durable checkpoint.
- **Phase 3 — real DataboxPPM tracker adapter.** Replaced the `dbxcli` stubs
  with a verified adapter: `list`/`search`/`get`/create over the live datasource,
  in neutral `TrackerTask` vocabulary. Pinned the create contract
  (`action invoke create_issue_linear` → `result.{identifier,issue_id,url}`,
  needs a team); `get`-by-ref lists+filters on `identifier` because Databox
  search only matches title/description. The agent sends no `team_id` — Databox
  pins/injects it on the action server-side. New config: `PPMA_DBXCLI_DATASET`,
  `PPMA_DBXCLI_CREATE_ACTION`. Pure mapping/param tests always run; live read +
  **simulated** create tests run locally and skip in CI.
- **Phase 2 — agent + clarify-and-stop.** `buildAgent` takes an optional model
  override (for tests). Faux-provider integration tests prove the Step 2 bar: a
  vague prompt drives `ask_user`, which records an OPEN question in `ppm` and
  terminates the turn (one model call); the question reappears in the next
  injected slice; and the agent loops through a `memory_write` tool call and
  finishes — all deterministic, no API key.
- **Phase 1 — memory layer wired over `ppm`.** Verified the real `ppm` CLI
  payloads and typed them (`PpmEntry`, `ProjectShape`, `ShapeEntry`, `SearchHit`,
  `ContextData`); `PpmClient` methods now return typed success envelopes. The
  `memory_*` tools and the `transformContext` slice injection are exercised
  end-to-end by an integration suite that runs against the real binary (skipped
  when `ppm` is absent; CI installs it). Pure `buildWriteArgs` mapping is
  unit-tested.
- Project scaffold: Bun + TypeScript, Biome, strict `tsconfig`.
- Implementation plan (`plans/implementation-plan.md`) derived from the handover
  and supporting docs.
- TypeScript skeleton: typed config, `ppm` subprocess wrapper + envelope parser,
  `memory_*` / `tracker_*` / `ask_user` tool definitions, `transformContext`
  memory-injection seam, agent wiring, and a token-threshold compaction trigger.
- Taskfile (`task install|typecheck|lint|test|check|dev|start`).
- GitHub Actions CI (typecheck → lint → test) and Dependabot.
- Open-source artifacts: README, CONTRIBUTING, CODE_OF_CONDUCT, SECURITY, issue
  and PR templates.
- Containerization: multi-stage `Dockerfile` that builds both external CLIs from
  source — `ppm` (Go) and `dbxcli` (Rust) — onto a Bun runtime, plus
  `compose.yaml`, `.dockerignore`, and a `release` workflow that publishes images
  to GHCR (`ghcr.io/ipedrazas/ppmagent`).

[Unreleased]: https://github.com/ipedrazas/ppmagent/commits/main
