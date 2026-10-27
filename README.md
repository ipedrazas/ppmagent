# ppmagent

A **Project / Product-Owner agent** that talks to one user over **Telegram**,
turns vague requests into well-scoped tracker tasks, **asks a clarifying question
when scope is unclear**, and keeps **structured, human-readable memory** so it
stays coherent over long, compaction-surviving runs.

It is built on the **pi durable** runtime (`@earendil-works/pi-durable` over
`pi-ai`): every turn, model response and tool call is committed to a SQLite
store before it is acted on, so a crash, deploy or OOM kill mid-turn **resumes
from the last checkpoint** instead of losing the work. It delegates two capabilities rather than reimplementing them:

- **Memory** → the [`ppm`](https://github.com/ipedrazas/ppm) CLI, which owns the
  on-disk Markdown memory format. The agent shells out to it; it never writes
  memory files directly.
- **Tracker** → **DataboxPPM** (Linear today, repointable at Jira), reached via
  the `dbxcli` CLI behind neutral tools. It exposes tasks (issues) and projects
  as read+write, and teams as read-only reference data (used to resolve the
  owning team when creating a project).

```
Telegram ⇄ Agent (pi durable runtime ── SQLite: conversations, turns, tool calls)
                ├── memory tools     → exec `ppm …`   (JSON envelope)
                ├── tracker tools     → exec `dbxcli …` (DataboxPPM)
                └── beforeRequest     → exec `ppm context …` (shape-aware slice)
```

> **Status: feature-complete PoC, pending a live demo.** All five build-order
> steps are implemented and tested against the real `ppm` and DataboxPPM:
> the memory layer + context injection, the agent + clarify-and-stop, the
> tracker adapter, compaction (trigger + flush), and the Telegram run loop with
> a durable session. What remains is the live end-to-end demo with a real
> Telegram bot token and Anthropic key (and the first real, non-simulated
> tracker create). See [`plans/implementation-plan.md`](plans/implementation-plan.md).

## Telegram commands

Any message that isn't one of these is handled as an agent turn. Commands are
handled locally (no model call, no token cost):

| Command | What it does |
|---|---|
| `/project <slug>` | Switch the active project used for memory injection. |
| `/context` | Report current context usage — estimated tokens, message count, and how close you are to the compaction threshold. |
| `/compact` | Force a compaction now: durable summarizes the older transcript (keeping a recent tail verbatim) and the summary is flushed to project memory as a checkpoint. |
| `/new [name]` | Start a fresh session: clears the transcript (optionally naming it) while keeping the active project. Memory in `ppm` is untouched — the clean slate is how you check what the agent recalls from memory alone. |
| `/name <name>` | Give the current session a human-readable label. |
| `/session` | Show the current session: short id, name, active project, and message count. |
| `/describe [on\|off]` | Toggle describe mode. With no argument, flips the current state. When on, a reasoning-detail prompt is prepended to each message asking the agent to narrate why it's calling each tool, what it expects, and what it learned from the result. |
| `/tools` | List the external CLIs the agent shells out to (`ppm`, `dbxcli`, `proteos`) with the version of each installed build. |
| `/resume [id\|name]` | With no argument, list saved sessions. With a short id or name, switch back to that session (the current transcript is saved first). |

A session is a small JSON file (name, active project, link to its durable
conversation) under the session directory derived from `PPMA_SESSION_FILE`, with
a `current` pointer; the transcript itself lives in the durable store
(`PPMA_DURABLE_DB`). `/new` starts a fresh conversation, which makes it easy to
purge a conversation and confirm the memory system still carries the project
forward.

## Durable runtime and crash recovery

The agent runs on [pi durable](https://github.com/earendil-works/pi/blob/main/packages/durable/README.md).
One durable *conversation* backs each session, in a single SQLite file
(`PPMA_DURABLE_DB`, default `durable.sqlite` beside the session file — put it on
a persistent volume).

- **Turns are persisted before they run.** A Telegram message is committed as a
  submission with request id `tg:<chatId>:<updateId>`, then generated, tool-called
  and answered as checkpointed durable tasks.
- **Resume on start.** Opening the store resumes unfinished work; the bot then
  waits for each interrupted turn to settle and sends its reply, prefixed
  "↩️ Recovered a turn that was interrupted by a restart". Redelivered updates
  carry the same request id and join the existing turn — nothing runs twice.
- **Tool replay is safe by default.** A read-only tool interrupted mid-call is
  simply re-run. A tool that writes state (tracker/memory writes, git, dispatch,
  reminders, `ask_user`) is **not** re-run: the model is told the call was
  interrupted and may have partially run, so it can check the outcome instead of
  repeating a side effect (see `NON_REPLAYABLE_TOOLS` in `src/agent.ts`).
- **Shutdown does not abort work.** `SIGTERM` closes the store; an in-flight turn
  stays at its last checkpoint and continues on the next start. `/cancel` is the
  only thing that aborts a turn.
- **Model errors are retried** by durable (backoff, `retry` settings) before a
  turn is reported failed.

The recovery path is exercised end to end by `tests/durable-recovery.test.ts`,
which SIGKILLs a real child process mid-tool-call and resumes its store.

## Requirements

- [Bun](https://bun.sh) ≥ 1.4 (pi durable stores to `node:sqlite`, which older Bun releases lack)
- The [`ppm`](https://github.com/ipedrazas/ppm) binary on `PATH`
- [`dbxcli`](https://github.com/tavon) for the tracker (DataboxPPM)
- An Anthropic API key and a Telegram bot token

(For the container path below you only need Docker — both `ppm` and `dbxcli` are
built into the image.)

## Quick start

```sh
bun install                # or: task install
cp .env.example .env       # then fill in the secrets
task check                 # typecheck + lint + test
task dev                   # run the agent in watch mode
```

## Run with Docker

The image bakes in both the `ppm` memory CLI (Go) and the `dbxcli` tracker CLI
(Rust), built from source on top of the Bun runtime. It's published to **GHCR**
at `ghcr.io/ipedrazas/ppmagent`.

```sh
cp .env.example .env       # fill in the secrets

# Build locally and run:
docker compose up --build

# Or run the published image:
IMAGE_TAG=latest docker compose pull && docker compose up
```

Memory persists in the `memory` named volume. `dbxcli` is baked in but still
needs its DataboxPPM config/token at runtime — supply it via `.env` or mount a
config file (see the commented volume in [`compose.yaml`](compose.yaml)).

Images are built and pushed by the [`release`](.github/workflows/release.yml)
workflow on pushes to `main` (tagged `latest` + the commit SHA) and on `v*` tags
(semver tags).

## Tasks

This repo uses [Task](https://taskfile.dev). Run `task --list`:

| Task | What it does |
|---|---|
| `task install` | Install deps (frozen lockfile) |
| `task deps` | Install everything needed to develop and run the project (Node deps, Biome, tsc) |
| `task setup` | One-time project setup — `deps` plus a local `.env` from `.env.example` |
| `task typecheck` | `tsc --noEmit` |
| `task lint` | Biome lint + format check |
| `task format` | Apply Biome fixes |
| `task test` | Run the Bun test suite |
| `task check` | typecheck + lint + test |
| `task dev` / `task start` | Run the agent |

The equivalent `bun run` scripts exist in `package.json` for CI and editors.

## Configuration

All configuration is environment-driven; see [`.env.example`](.env.example) for
the full, documented list. Secrets (Anthropic key, Telegram bot token, Databox
auth) stay in the environment and are never committed.

### Telegram chat allowlist (required)

The bot **fails to start** unless you tell it which chat it may answer. This is
a deliberate safety gate: the agent can create tracker issues, dispatch coding
agents, and push code, so it must never be open to whoever discovers the bot's
handle. Missing this is the most common first-run crash:

```
Missing required environment variable: PPMA_TELEGRAM_ALLOWED_CHAT_ID
(or set PPMA_ALLOW_ANY_CHAT=true to explicitly run the bot open to all chats)
```

Set exactly one of:

| Variable | Meaning |
|---|---|
| `PPMA_TELEGRAM_ALLOWED_CHAT_ID` | The single chat id the bot answers to. Group chat ids are negative (e.g. `-1001234567890`). |
| `PPMA_ALLOW_ANY_CHAT=true` | Explicit opt-in to answer **any** chat. Only for throwaway/local testing — never in production. |

#### How to find your chat id

Message the bot (or add it to your group and send a message), then read the id
back from Telegram's API. Using your bot token:

```sh
curl -s "https://api.telegram.org/bot<YOUR_BOT_TOKEN>/getUpdates" \
  | grep -o '"chat":{"id":[-0-9]*'
```

The number after `"id":` is your chat id — positive for a direct message with
the bot, negative for a group. Put it in `PPMA_TELEGRAM_ALLOWED_CHAT_ID`.

Alternatively, from the **mobile or desktop Telegram app**:

1. Start a chat with [`@userinfobot`](https://t.me/userinfobot) (or
   `@getidsbot`) and send any message — it replies with your numeric user id,
   which is the chat id for a 1:1 conversation with your bot.
2. For a **group**, add `@getidsbot` to the group; it posts the group's chat id
   (the negative number). You can remove it afterwards.

> Tip: `getUpdates` only returns messages received after the bot last started
> and while no webhook is set. If it comes back empty, send the bot a fresh
> message and retry.

### Session files in a bucket (optional)

Set `PPMA_SESSION_BUCKET` to copy every session file to an S3-compatible bucket
(Tigris, S3, MinIO) so [casa](https://github.com/tavon-ai/casa) can analyse
them: `casa analyze t3://bucket/ppmagent/`, or `casa server --bucket
t3://bucket/`, whose Bucket tab groups files by their first folder.

```sh
PPMA_SESSION_BUCKET=t3://my-sessions/ppmagent/
AWS_ACCESS_KEY_ID=tid_...
AWS_SECRET_ACCESS_KEY=tsec_...
```

Objects are `<prefix><sessionId>.json`, the same redacted JSON written locally,
which casa reads as a pi session. The local files stay the source of truth: an
upload runs after each save, off the turn's path, and a failure is logged and
never breaks the turn. Retention never touches the bucket: a session deleted
locally after `PPMA_SESSION_RETENTION_DAYS` stays in the bucket, so casa can
still analyse it (use a bucket lifecycle rule if you want it to expire). Credentials and endpoint come from the same variables casa reads:
`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION` and
`AWS_ENDPOINT_URL_S3` / `AWS_ENDPOINT_URL`. `t3://` defaults to Tigris
(`https://t3.storage.dev`, region `auto`). The key needs write access to the
prefix. Give casa a separate read-only key.

## Project layout

```
src/
  config.ts            # env → typed Config
  logger.ts            # loglayer structured logger (json|pretty)
  exec.ts              # subprocess helper
  agent.ts             # buildAgent(): prompt + tools + durable runtime + tracing
  runtime/             # pi-durable harness: models, tool adapter, turns, recovery
  compaction.ts        # compaction threshold policy (mechanism is durable's)
  memory/              # ppm wrapper + memory_* tools + context injection
  tracker/             # dbxcli wrapper + neutral tracker_* tools
  tools/ask-user.ts    # clarify-and-stop
  telegram/bot.ts      # Telegram adapter
plans/                 # handover, implementation plan, format/spike docs
```

## Migrating from the pi-ai / pi-agent-core runtime

This release is a **breaking change** (TAV-226): the agent moved from
`@earendil-works/pi-ai` 0.82.1 + `pi-agent-core` to `@earendil-works/pi-durable`
(with `pi-ai` and `chord` 1.4.0). What changes for operators and callers:

| Area | Before | Now |
| --- | --- | --- |
| Dependencies | `pi-ai` 0.82.1, `pi-agent-core` 0.82.1 | `pi-durable`, `pi-ai`, `chord` all 1.4.0 (pi-ai 1.x is durable's required model layer); `pi-agent-core` and pi-ai 0.82 are gone |
| Runtime | Bun ≥ 1.1 | **Bun ≥ 1.4** — durable stores to `node:sqlite`, absent in older Bun (the Docker image and CI are bumped to 1.4.3) |
| Transcript | In memory, snapshotted into `sessions/<id>.json` | In the durable SQLite store; the session JSON keeps a read-only `messages` export (same redacted shape, still mirrored to the bucket) |
| New config | — | `PPMA_DURABLE_DB` (default `<session dir>/durable.sqlite`). **Persist it** (e.g. mount `.session`) or nothing survives a restart |
| Existing sessions | Transcript inline | Name/project/id are kept; **old transcripts are not imported** — each session starts a fresh conversation on first use. Memory in `ppm` is unaffected |
| Compaction | Own summarizer + placeholder fallback, after each turn | Durable's model-based compaction, triggered at `PPMA_COMPACTION_TOKEN_THRESHOLD` (default 120k); a failed summary is retried by durable rather than falling back to a placeholder. The summary is still flushed to `ppm` |
| Provider calls | Single attempt | Retried with backoff by durable before a turn fails |
| Logging | `llm request/response` lines carried HTTP status and headers | `llm request` (message count, `trace`-level body) per attempt; no response-header logging — provider errors surface as `model turn failed` |
| Embedding API | `buildAgent()` sync, returned `{ agent }` with `prompt`/`subscribe`/`abort` | `await buildAgent()` returns `{ runtime }`: `runtime.createConversation()`, `runTurn()`, `subscribe()`, `abort()`, `compact()`, `pendingTurns()`. Tests inject `models`/`storage` instead of a `streamFn` |
| Tools | `AgentTool` from pi-agent-core | `AppTool` (`src/tool-helpers.ts`), wrapped into a durable tool at the runtime boundary; tool bodies are unchanged |
| Security | Redaction applied to the session file only | Same — but the durable DB holds the **unredacted** transcript, so treat it like the memory directory (do not mirror or share it) |

Not yet migrated (follow-up): reminders still run from `reminders.json` + a
poller, and ProteOS task watching from `proteos-tasks.json` — both are good
candidates for durable timer tasks. `/search` still indexes session metadata
only.

## Documentation

- [`plans/implementation-plan.md`](plans/implementation-plan.md) — the build plan
- [`plans/handover.md`](plans/handover.md) — original handover
- [`plans/docs/`](plans/docs) — memory format, ppm README, spike contract

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) and our
[Code of Conduct](CODE_OF_CONDUCT.md). Security issues: see
[SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE) © Ivan Pedrazas
