# ppmagent

A **Project / Product-Owner agent** that talks to one user over **Telegram**,
turns vague requests into well-scoped tracker tasks, **asks a clarifying question
when scope is unclear**, and keeps **structured, human-readable memory** so it
stays coherent over long, compaction-surviving runs.

It is built on the **pi** runtime (`@earendil-works/pi-ai` + `pi-agent-core`)
and delegates two capabilities rather than reimplementing them:

- **Memory** → the [`ppm`](https://github.com/ipedrazas/ppm) CLI, which owns the
  on-disk Markdown memory format. The agent shells out to it; it never writes
  memory files directly.
- **Tracker** → **DataboxPPM** (Linear today, repointable at Jira), reached via
  the `dbxcli` CLI behind neutral tools. It exposes tasks (issues) and projects
  as read+write, and teams as read-only reference data (used to resolve the
  owning team when creating a project).

```
Telegram ⇄ Agent (pi runtime)
                ├── memory tools     → exec `ppm …`   (JSON envelope)
                ├── tracker tools     → exec `dbxcli …` (DataboxPPM)
                └── transformContext  → exec `ppm context …` (shape-aware slice)
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
| `/compact` | Force a compaction now: flush a durable checkpoint to memory, then summarize the older transcript (keeps the most recent messages). |
| `/new [name]` | Start a fresh session: clears the transcript (optionally naming it) while keeping the active project. Memory in `ppm` is untouched — the clean slate is how you check what the agent recalls from memory alone. |
| `/name <name>` | Give the current session a human-readable label. |
| `/session` | Show the current session: short id, name, active project, and message count. |
| `/describe [on\|off]` | Toggle describe mode. With no argument, flips the current state. When on, a reasoning-detail prompt is prepended to each message asking the agent to narrate why it's calling each tool, what it expects, and what it learned from the result. |
| `/tools` | List the external CLIs the agent shells out to (`ppm`, `dbxcli`, `proteos`) with the version of each installed build. |
| `/resume [id\|name]` | With no argument, list saved sessions. With a short id or name, switch back to that session (the current transcript is saved first). |

Sessions are stored one JSON file each under the session directory (derived from
`PPMA_SESSION_FILE`), with a `current` pointer; a pre-existing single-file
session is migrated in automatically on first run. This makes it easy to purge a
conversation (`/new`) and confirm the memory system still carries the project
forward.

## Requirements

- [Bun](https://bun.sh) ≥ 1.1
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

## Project layout

```
src/
  config.ts            # env → typed Config
  logger.ts            # loglayer structured logger (json|pretty)
  exec.ts              # subprocess helper
  agent.ts             # buildAgent(): prompt + tools + transformContext
  compaction.ts        # token-threshold compaction trigger
  memory/              # ppm wrapper + memory_* tools + context injection
  tracker/             # dbxcli wrapper + neutral tracker_* tools
  tools/ask-user.ts    # clarify-and-stop
  telegram/bot.ts      # Telegram adapter
plans/                 # handover, implementation plan, format/spike docs
```

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
