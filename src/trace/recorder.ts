import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { type Logger, nullLogger } from "../logger.ts";

/**
 * Append-only session trace: one JSONL file per session under a `traces/`
 * directory, one event per line. This is the durable evidence for offline
 * session analysis (the extractor in ./extract.ts) — unlike the live
 * transcript, it is never compacted or mutated, so it survives what the
 * working memory throws away.
 *
 * Recording is strictly fire-and-forget: a trace failure is logged and
 * swallowed, never propagated — telemetry must not break a turn.
 */

/** One recorded line. `ts` is epoch millis; everything else is event-specific. */
export interface TraceEvent {
  ts: number;
  type: string;
  [key: string]: unknown;
}

/**
 * Cap serialized payloads (tool args can carry whole prompts/diffs). Values
 * under the cap pass through untouched; oversized ones are replaced by a
 * truncation marker carrying the head of their JSON form.
 */
export const MAX_PAYLOAD_CHARS = 2_000;

export function clipPayload(value: unknown): unknown {
  let json: string;
  try {
    json = JSON.stringify(value) ?? "null";
  } catch {
    return { truncated: String(value).slice(0, MAX_PAYLOAD_CHARS) };
  }
  if (json.length <= MAX_PAYLOAD_CHARS) return value;
  return { truncated: json.slice(0, MAX_PAYLOAD_CHARS) };
}

export class TraceRecorder {
  private sessionId?: string;
  private readonly log: Logger;

  constructor(
    private readonly dir: string,
    logger: Logger = nullLogger,
  ) {
    this.log = logger.child().withContext({ component: "trace" });
  }

  /** Point subsequent events at this session's trace file (`/new`, `/resume`). */
  setSession(sessionId: string): void {
    this.sessionId = sessionId;
  }

  /**
   * Append one event to the current session's trace. A missing session (never
   * set) or any I/O failure drops the event with a warning — never throws.
   */
  record(event: { type: string } & Record<string, unknown>): void {
    if (!this.sessionId) return;
    try {
      if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true });
      const line: TraceEvent = { ts: Date.now(), ...event, type: event.type };
      appendFileSync(join(this.dir, `${this.sessionId}.jsonl`), `${JSON.stringify(line)}\n`);
    } catch (error) {
      this.log.withError(error).withMetadata({ type: event.type }).warn("trace event dropped");
    }
  }
}
