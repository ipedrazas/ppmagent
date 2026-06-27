/**
 * Typed configuration loaded from the environment. No pi or external-binary
 * dependencies live here so it stays trivially unit-testable.
 */

import { LOG_FORMATS, LOG_LEVELS, type LogFormat, type LogLevel } from "./logger.ts";

export interface Config {
  /** Anthropic API key for the pi default provider. */
  anthropicApiKey: string;
  /** Model id passed to pi's getModel(). */
  model: string;

  /** `ppm` binary (path or name on PATH). */
  ppmBin: string;
  /** Memory workspace root, passed to every ppm call as --root. */
  ppmMemoryRoot: string;
  /** How many recent decisions `ppm context` injects each turn. */
  contextRecent: number;

  /** `dbxcli` binary (path or name on PATH). */
  dbxcliBin: string;
  /** dbxcli config file (DataboxPPM endpoint + auth). */
  dbxcliConfig: string;
  /** DataboxPPM dataset alias holding issues. */
  dbxcliDataset: string;
  /** DataboxPPM action alias that creates an issue. */
  dbxcliCreateAction: string;

  /** Telegram bot token. */
  telegramBotToken: string;
  /** Optional single allowed chat id (single-tenant PoC). */
  telegramAllowedChatId: string | undefined;
  /** Path to the durable session file. */
  sessionFile: string;

  /** Token threshold above which the session compacts. 0 = pi defaults. */
  compactionTokenThreshold: number;

  /** Minimum log severity emitted (trace|debug|info|warn|error|fatal). */
  logLevel: LogLevel;
  /** Log output shape: `json` (one object/line) or `pretty` (readable console). */
  logFormat: LogFormat;
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

/** Read an env var constrained to a fixed set of allowed string values. */
function oneOf<T extends string>(env: Env, key: string, allowed: readonly T[], fallback: T): T {
  const raw = env[key];
  if (!raw) return fallback;
  if ((allowed as readonly string[]).includes(raw)) return raw as T;
  throw new ConfigError(
    `Environment variable ${key} must be one of ${allowed.join("|")}, got: ${raw}`,
  );
}

/**
 * Build a {@link Config} from a process environment. Throws {@link ConfigError}
 * if a required variable is missing or malformed.
 */
export function loadConfig(env: Env = process.env): Config {
  return {
    anthropicApiKey: required(env, "ANTHROPIC_API_KEY"),
    model: optional(env, "PPMA_MODEL", "claude-sonnet-4-6"),

    ppmBin: optional(env, "PPMA_PPM_BIN", "ppm"),
    ppmMemoryRoot: optional(env, "PPM_MEMORY_ROOT", "./memory"),
    contextRecent: int(env, "PPMA_CONTEXT_RECENT", 3),

    dbxcliBin: optional(env, "PPMA_DBXCLI_BIN", "dbxcli"),
    dbxcliConfig: optional(env, "PPMA_DBXCLI_CONFIG", ""),
    dbxcliDataset: optional(env, "PPMA_DBXCLI_DATASET", "issues"),
    dbxcliCreateAction: optional(env, "PPMA_DBXCLI_CREATE_ACTION", "create_issue_linear"),

    telegramBotToken: required(env, "PPMA_TELEGRAM_BOT_TOKEN"),
    telegramAllowedChatId: env.PPMA_TELEGRAM_ALLOWED_CHAT_ID || undefined,
    sessionFile: optional(env, "PPMA_SESSION_FILE", "./.session/session.json"),

    compactionTokenThreshold: int(env, "PPMA_COMPACTION_TOKEN_THRESHOLD", 0),

    logLevel: oneOf(env, "PPMA_LOG_LEVEL", LOG_LEVELS, "info"),
    logFormat: oneOf(env, "PPMA_LOG_FORMAT", LOG_FORMATS, "json"),
  };
}
