/**
 * Structured logging built on loglayer. A single root logger is created from
 * config in the entrypoint and threaded through the app; each component derives
 * a child with a `component` context tag so every line is attributable.
 *
 * The library/test default is {@link nullLogger} (a discarding MockLogLayer), so
 * constructors stay logger-optional and unit tests produce no console noise.
 */
import { ConsoleTransport, type ILogLayer, LogLayer, MockLogLayer } from "loglayer";

/** The logger interface passed around the app — loglayer's fluent surface. */
export type Logger = ILogLayer;

/** Minimum severity emitted, in ascending order. */
export type LogLevel = "trace" | "debug" | "info" | "warn" | "error" | "fatal";

/** `json` → one stringified object per line (prod); `pretty` → console objects (dev). */
export type LogFormat = "json" | "pretty";

export const LOG_LEVELS: readonly LogLevel[] = ["trace", "debug", "info", "warn", "error", "fatal"];
export const LOG_FORMATS: readonly LogFormat[] = ["json", "pretty"];

/**
 * Turn an Error into a plain, JSON-serializable object. Without this, `err`
 * fields stringify to `{}` because `message`/`stack` are non-enumerable on
 * Error — so `withError(e)` produced `"err":{}` and hid the actual failure.
 * Walks the `cause` chain so wrapped errors keep their root cause, and folds
 * in any extra enumerable properties (e.g. Node's `code`/`errno`/`syscall`).
 */
function serializeError(error: unknown): Record<string, unknown> {
  if (!(error instanceof Error)) {
    return { value: error };
  }
  const serialized: Record<string, unknown> = {
    name: error.name,
    message: error.message,
    stack: error.stack,
  };
  // Copy own enumerable props Error hides from the standard three (e.g. code).
  for (const key of Object.keys(error)) {
    if (!(key in serialized)) serialized[key] = (error as unknown as Record<string, unknown>)[key];
  }
  if (error.cause !== undefined) {
    serialized.cause = serializeError(error.cause);
  }
  return serialized;
}

export interface LoggerOptions {
  level: LogLevel;
  format: LogFormat;
}

/**
 * Build the root logger. In `json` mode the message, level and ISO timestamp are
 * folded into the structured object and the whole line is stringified — one JSON
 * object per line, ready for a log shipper. In `pretty` mode loglayer logs the
 * message followed by the data object for readable local development.
 */
export function createLogger(opts: LoggerOptions): Logger {
  const json = opts.format === "json";
  return new LogLayer({
    errorSerializer: serializeError,
    transport: new ConsoleTransport({
      logger: console,
      level: opts.level,
      ...(json
        ? {
            messageField: "msg",
            levelField: "level",
            dateField: "time",
            stringify: true,
          }
        : {}),
    }),
  });
}

/** A logger that discards everything — the default for library code and tests. */
export const nullLogger: Logger = new MockLogLayer();
