/**
 * Typed configuration loaded from the environment. No pi or external-binary
 * dependencies live here so it stays trivially unit-testable.
 */

import { LOG_FORMATS, LOG_LEVELS, type LogFormat, type LogLevel } from "./logger.ts";

/** LLM providers we support. Names match the provider ids pi's getBuiltinModel() expects. */
export const PROVIDERS = ["anthropic", "deepseek", "zai", "openrouter", "ollama"] as const;
export type Provider = (typeof PROVIDERS)[number];

/** Friendly aliases accepted in PPMA_PROVIDER, normalised to the pi provider id. */
const PROVIDER_ALIASES: Record<string, Provider> = {
  glm: "zai",
  zhipu: "zai",
};

/** Env var carrying each provider's API key. */
const PROVIDER_API_KEY_ENV: Record<Provider, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  deepseek: "DEEPSEEK_API_KEY",
  zai: "ZAI_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  ollama: "OLLAMA_API_KEY",
};

/**
 * Providers whose API key is optional. Ollama runs against a local server that
 * typically has no auth in front of it, unlike the hosted providers above.
 */
const OPTIONAL_API_KEY_PROVIDERS = new Set<Provider>(["ollama"]);

/** Default model id per provider, used when PPMA_MODEL is unset. */
const PROVIDER_DEFAULT_MODEL: Record<Provider, string> = {
  anthropic: "claude-sonnet-4-6",
  deepseek: "deepseek-v4-pro",
  zai: "glm-4.7",
  openrouter: "anthropic/claude-sonnet-4.6",
  ollama: "llama3",
};

/**
 * Default base URL per provider, used when PPMA_BASE_URL is unset. Only
 * providers reachable at a non-standard (e.g. local) endpoint need one — the
 * hosted providers resolve their base URL from pi's built-in catalog.
 */
const PROVIDER_DEFAULT_BASE_URL: Partial<Record<Provider, string>> = {
  ollama: "http://localhost:11434/v1",
};

export interface Config {
  /** Selected LLM provider (the id passed to pi's getBuiltinModel()). */
  provider: Provider;
  /**
   * API key for the selected provider. Empty for providers in
   * {@link OPTIONAL_API_KEY_PROVIDERS} (e.g. ollama) when unset.
   */
  apiKey: string;
  /** Model id passed to pi's getBuiltinModel(). */
  model: string;
  /**
   * Base URL override for OpenAI-compatible providers reachable at a
   * non-standard endpoint (e.g. a local Ollama server). Empty = use the
   * provider's built-in default.
   */
  baseUrl: string;

  /** `ppm` binary (path or name on PATH). */
  ppmBin: string;
  /** Memory workspace root, passed to every ppm call as --root. */
  ppmMemoryRoot: string;
  /** How many recent decisions `ppm context` injects each turn. */
  contextRecent: number;

  /** `dbxcli` binary (path or name on PATH). */
  dbxcliBin: string;
  /**
   * dbxcli config file (DataboxPPM endpoint + auth). It also lists the dataset
   * and action aliases, so those are discovered at runtime rather than configured
   * here (see {@link DataboxClient}).
   */
  dbxcliConfig: string;
  /**
   * Default row limit for `tracker_list_tasks`, `tracker_search_tasks`,
   * `tracker_list_projects`, and `tracker_list_teams`. Lower this if large
   * queries trip the Linear API complexity limit.
   */
  dbxcliQueryLimit: number;

  /** `proteos` binary (path or name on PATH) for the ProteOS task lane. */
  proteosBin: string;
  /**
   * ProteOS control-plane base URL, passed to proteos as --url. Empty = let
   * proteos resolve it from PROTEOS_URL or the stored login. The auth token is
   * not configured here: proteos reads PROTEOS_TOKEN (or its stored login) from
   * the inherited environment, keeping the secret off the command line.
   */
  proteosUrl: string;
  /** Polling interval for the background ProteOS task watcher, in milliseconds. */
  proteosWatchIntervalMs: number;

  /** Telegram bot token. */
  telegramBotToken: string;
  /**
   * The single allowed chat id (single-tenant PoC). Required — the bot can
   * create tracker issues, dispatch coding agents, and push code, so it must
   * not be open to whoever finds the handle. `undefined` only when the
   * operator explicitly opted out via PPMA_ALLOW_ANY_CHAT=true.
   */
  telegramAllowedChatId: number | undefined;
  /** Path to the durable session file. */
  sessionFile: string;

  /** Token threshold above which the session compacts. 0 = pi defaults. */
  compactionTokenThreshold: number;

  /** Minimum log severity emitted (trace|debug|info|warn|error|fatal). */
  logLevel: LogLevel;
  /** Log output shape: `json` (one object/line) or `pretty` (readable console). */
  logFormat: LogFormat;

  /**
   * Whether the confirmation gate is active. When `true` (default), all
   * mutating operations (tracker create/update, git push/PR) require explicit
   * user approval before executing. Set `PPMA_CONFIRMATION_GATE=false` to
   * disable — intended for automated PO agents that run without a human in the
   * loop.
   */
  confirmationGate: boolean;

  /**
   * HTTP port for the GitHub webhook server. `null` = disabled (default).
   * Set `PPMA_GITHUB_WEBHOOK_PORT` to enable.
   */
  githubWebhookPort: number | null;
  /** HMAC-SHA256 secret for verifying GitHub webhook payloads. Empty = no verification. */
  githubWebhookSecret: string;
  /**
   * Repo patterns to monitor for PR events (e.g. `["tavon-ai/*", "ipedrazas/*"]`).
   * Supports `owner/*` wildcards. Empty list = monitor nothing.
   */
  githubMonitoredRepos: string[];

  /**
   * HTTP port for the `/metrics` endpoint. `null` = disabled (default).
   * Set `PPMA_METRICS_PORT` to expose a live JSON metrics snapshot.
   */
  metricsPort: number | null;

  /**
   * Number of days after which an idle session is deleted by the retention
   * runner. 0 = disabled (sessions accumulate indefinitely). Default: 30.
   */
  sessionRetentionDays: number;

  /**
   * HTTP port for the Telegram webhook transport server. `null` = disabled
   * (default). When set together with `telegramWebhookUrl`, the agent receives
   * updates via HTTP POST instead of long-polling. See
   * `src/telegram/webhook-transport.ts` for the scaling rationale.
   */
  telegramWebhookPort: number | null;
  /**
   * Public HTTPS URL that Telegram should POST updates to. Required when
   * `telegramWebhookPort` is set. Telegram will call `setWebhook` with this URL
   * at startup. Example: `https://bot.example.com/webhook/telegram`.
   */
  telegramWebhookUrl: string;
  /**
   * Optional secret token sent in `X-Telegram-Bot-Api-Secret-Token` on every
   * webhook request. Empty = no token verification (only acceptable behind a
   * firewall or in dev). Set this in production — it proves the POST is from
   * Telegram and not a random actor who discovered the endpoint.
   */
  telegramWebhookSecret: string;

  /**
   * Maximum combined stdout+stderr bytes a subprocess may emit before its output
   * is truncated. 0 = unlimited.
   */
  execMaxOutputBytes: number;
  /**
   * Maximum tool calls per agent turn. The turn is aborted when this count is
   * exceeded. 0 = unlimited.
   */
  turnMaxTools: number;
  /**
   * Maximum estimated cost (USD) per agent turn. The turn is aborted if the
   * estimated cost of one turn exceeds this threshold. 0 = unlimited.
   */
  turnMaxCostUsd: number;
  /**
   * Maximum estimated cost (USD) per session. A new turn is refused when the
   * accumulated session cost would breach this limit. 0 = unlimited.
   */
  sessionMaxCostUsd: number;

  /**
   * GitHub Personal Access Token (or GitHub App installation token) forwarded
   * to the `proteos` CLI so that `gh` is authenticated on ProteOS machines.
   * Required for `proteos_git_pr` to open PRs and for headless coding agents
   * dispatched via `proteos_task_run` to run `gh pr create`. Empty = not set
   * (git push still works via deploy keys, but PR creation will fail).
   */
  githubToken: string;
}

/** Environment shape we read from — a subset of `process.env`. */
export type Env = Record<string, string | undefined>;

class ConfigError extends Error {}

function required(env: Env, key: string): string {
  const value = env[key];
  if (!value) {
    throw new ConfigError(`Missing required environment variable: ${key}`);
  }
  return value;
}

function optional(env: Env, key: string, fallback: string): string {
  const value = env[key];
  return value && value.length > 0 ? value : fallback;
}

function int(env: Env, key: string, fallback: number): number {
  const raw = env[key];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed)) {
    throw new ConfigError(`Environment variable ${key} must be an integer, got: ${raw}`);
  }
  return parsed;
}

function float(env: Env, key: string, fallback: number): number {
  const raw = env[key];
  if (!raw) return fallback;
  const parsed = Number.parseFloat(raw);
  if (Number.isNaN(parsed)) {
    throw new ConfigError(`Environment variable ${key} must be a number, got: ${raw}`);
  }
  return parsed;
}

/** Read an env var constrained to a fixed set of allowed string values. */
function oneOf<T extends string>(env: Env, key: string, allowed: readonly T[], fallback: T): T {
  const raw = env[key];
  if (!raw) return fallback;
  if ((allowed as readonly string[]).includes(raw)) return raw as T;
  throw new ConfigError(
    `Environment variable ${key} must be one of ${allowed.join("|")}, got: ${raw}`,
  );
}

/** Resolve PPMA_PROVIDER (with aliases) to a supported provider id. */
function resolveProvider(env: Env): Provider {
  const raw = env.PPMA_PROVIDER;
  if (!raw) return "anthropic";
  const normalised = PROVIDER_ALIASES[raw.toLowerCase()] ?? raw.toLowerCase();
  if ((PROVIDERS as readonly string[]).includes(normalised)) return normalised as Provider;
  throw new ConfigError(
    `Environment variable PPMA_PROVIDER must be one of ${PROVIDERS.join("|")} (alias glm/zhipu=zai), got: ${raw}`,
  );
}

/**
 * Resolve the allowed chat id, failing closed: it must be set (and parse as an
 * integer — Telegram chat ids are integers, negative for groups) unless the
 * operator explicitly opts into an open bot with PPMA_ALLOW_ANY_CHAT=true.
 * A silently unset or malformed value must never yield an open bot.
 */
function resolveAllowedChatId(env: Env): number | undefined {
  const raw = env.PPMA_TELEGRAM_ALLOWED_CHAT_ID;
  if (!raw) {
    if (env.PPMA_ALLOW_ANY_CHAT === "true") return undefined;
    throw new ConfigError(
      "Missing required environment variable: PPMA_TELEGRAM_ALLOWED_CHAT_ID " +
        "(or set PPMA_ALLOW_ANY_CHAT=true to explicitly run the bot open to all chats)",
    );
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed)) {
    throw new ConfigError(
      `Environment variable PPMA_TELEGRAM_ALLOWED_CHAT_ID must be an integer chat id, got: ${raw}`,
    );
  }
  return parsed;
}

function resolvePort(env: Env, key: string): number | null {
  const raw = env[key];
  if (!raw) return null;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed < 1 || parsed > 65535) {
    throw new ConfigError(`${key} must be a valid port (1–65535), got: ${raw}`);
  }
  return parsed;
}

function resolveMonitoredRepos(env: Env): string[] {
  const raw = env.PPMA_GITHUB_MONITORED_REPOS;
  if (!raw || raw.trim() === "") return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Build a {@link Config} from a process environment. Throws {@link ConfigError}
 * if a required variable is missing or malformed.
 */
export function loadConfig(env: Env = process.env): Config {
  const provider = resolveProvider(env);
  return {
    provider,
    apiKey: OPTIONAL_API_KEY_PROVIDERS.has(provider)
      ? optional(env, PROVIDER_API_KEY_ENV[provider], "")
      : required(env, PROVIDER_API_KEY_ENV[provider]),
    model: optional(env, "PPMA_MODEL", PROVIDER_DEFAULT_MODEL[provider]),
    baseUrl: optional(env, "PPMA_BASE_URL", PROVIDER_DEFAULT_BASE_URL[provider] ?? ""),

    ppmBin: optional(env, "PPMA_PPM_BIN", "ppm"),
    ppmMemoryRoot: optional(env, "PPM_MEMORY_ROOT", "./memory"),
    contextRecent: int(env, "PPMA_CONTEXT_RECENT", 3),

    dbxcliBin: optional(env, "PPMA_DBXCLI_BIN", "dbxcli"),
    dbxcliConfig: optional(env, "PPMA_DBXCLI_CONFIG", ""),
    dbxcliQueryLimit: int(env, "PPMA_DBXCLI_QUERY_LIMIT", 100),

    proteosBin: optional(env, "PPMA_PROTEOS_BIN", "proteos"),
    proteosUrl: optional(env, "PROTEOS_URL", ""),
    proteosWatchIntervalMs: int(env, "PPMA_PROTEOS_WATCH_INTERVAL_MS", 30_000),

    telegramBotToken: required(env, "PPMA_TELEGRAM_BOT_TOKEN"),
    telegramAllowedChatId: resolveAllowedChatId(env),
    sessionFile: optional(env, "PPMA_SESSION_FILE", "./.session/session.json"),

    compactionTokenThreshold: int(env, "PPMA_COMPACTION_TOKEN_THRESHOLD", 0),

    logLevel: oneOf(env, "PPMA_LOG_LEVEL", LOG_LEVELS, "info"),
    logFormat: oneOf(env, "PPMA_LOG_FORMAT", LOG_FORMATS, "json"),

    confirmationGate: env.PPMA_CONFIRMATION_GATE !== "false",
    githubWebhookPort: resolvePort(env, "PPMA_GITHUB_WEBHOOK_PORT"),
    githubWebhookSecret: optional(env, "PPMA_GITHUB_WEBHOOK_SECRET", ""),
    githubMonitoredRepos: resolveMonitoredRepos(env),
    metricsPort: resolvePort(env, "PPMA_METRICS_PORT"),
    githubToken: optional(env, "GITHUB_TOKEN", ""),

    sessionRetentionDays: int(env, "PPMA_SESSION_RETENTION_DAYS", 30),
    telegramWebhookPort: resolvePort(env, "PPMA_TELEGRAM_WEBHOOK_PORT"),
    telegramWebhookUrl: optional(env, "PPMA_TELEGRAM_WEBHOOK_URL", ""),
    telegramWebhookSecret: optional(env, "PPMA_TELEGRAM_WEBHOOK_SECRET", ""),

    execMaxOutputBytes: int(env, "PPMA_EXEC_MAX_OUTPUT_BYTES", 1_048_576),
    turnMaxTools: int(env, "PPMA_TURN_MAX_TOOLS", 0),
    turnMaxCostUsd: float(env, "PPMA_TURN_MAX_COST_USD", 0),
    sessionMaxCostUsd: float(env, "PPMA_SESSION_MAX_COST_USD", 0),
  };
}
