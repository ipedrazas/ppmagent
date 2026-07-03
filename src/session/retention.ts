import { type Logger, nullLogger } from "../logger.ts";
import type { SessionIndex } from "./session-index.ts";
import type { SessionStore } from "./store.ts";

export interface SessionRetentionOptions {
  store: SessionStore;
  /** Number of days after which an idle session is deleted. 0 = disabled. */
  retentionDays: number;
  /** Session id getter for the currently active session (never deleted). */
  currentSessionId: () => string;
  /** Optional index to remove entries from when sessions are deleted. */
  index?: SessionIndex;
  /** Milliseconds between retention sweeps. Default: 1 hour. */
  intervalMs?: number;
  logger?: Logger;
}

/**
 * Background runner that periodically deletes sessions older than the
 * configured retention window. The active session is always skipped. Runs at
 * startup and then every `intervalMs` (default 1 hour). Set `retentionDays=0`
 * to disable.
 */
export class SessionRetentionRunner {
  private readonly log: Logger;
  private readonly retentionMs: number;
  private readonly intervalMs: number;
  private running = false;
  private readonly abort = new AbortController();

  constructor(private readonly opts: SessionRetentionOptions) {
    this.log = (opts.logger ?? nullLogger).child().withContext({ component: "session-retention" });
    this.retentionMs = opts.retentionDays * 24 * 60 * 60 * 1000;
    this.intervalMs = opts.intervalMs ?? 3_600_000;
  }

  /** Run one retention sweep synchronously and return the number of sessions deleted. */
  runOnce(): number {
    if (this.retentionMs <= 0) return 0;
    const cutoff = Date.now() - this.retentionMs;
    const currentId = this.opts.currentSessionId();
    const sessions = this.opts.store.list();
    let deleted = 0;
    for (const s of sessions) {
      if (s.sessionId === currentId) continue;
      if (s.updatedAt < cutoff) {
        const ok = this.opts.store.delete(s.sessionId);
        if (ok) {
          this.opts.index?.remove(s.sessionId);
          deleted++;
          this.log
            .withMetadata({ sessionId: s.sessionId, updatedAt: s.updatedAt })
            .info("retention: deleted expired session");
        }
      }
    }
    this.log
      .withMetadata({ checked: sessions.length, deleted, cutoff })
      .debug("retention sweep complete");
    return deleted;
  }

  /**
   * Start the background loop. Returns immediately when `retentionDays=0`
   * (disabled). Otherwise runs an immediate sweep then sleeps `intervalMs`
   * between rounds. Resolves when {@link stop} is called.
   */
  async start(): Promise<void> {
    if (this.retentionMs <= 0) {
      this.log.debug("session retention disabled (retentionDays=0)");
      return;
    }
    this.running = true;
    this.log
      .withMetadata({ retentionDays: this.opts.retentionDays, intervalMs: this.intervalMs })
      .info("session retention runner started");
    this.runOnce();
    while (this.running) {
      await this.sleep(this.intervalMs);
      if (!this.running) break;
      this.runOnce();
    }
    this.log.info("session retention runner stopped");
  }

  stop(): void {
    this.running = false;
    this.abort.abort();
  }

  private sleep(ms: number): Promise<void> {
    const signal = this.abort.signal;
    if (signal.aborted) return Promise.resolve();
    return new Promise((resolve) => {
      const onAbort = () => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }
}
