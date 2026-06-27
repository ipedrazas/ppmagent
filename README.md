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
