import { type Logger, nullLogger } from "../logger.ts";
import type { Reminder, ReminderStore } from "./store.ts";

function formatNotification(reminder: Reminder): string {
  return `⏰ Reminder: ${reminder.message}`;
}

export interface ReminderRunnerOptions {
  store: ReminderStore;
  /** Deliver a notification to the user (e.g. send a Telegram message). */
  notify: (message: string) => Promise<void>;
  /** How long to sleep between poll rounds. Default: 60 000 ms (1 minute). */
  intervalMs?: number;
  logger?: Logger;
}

/**
 * Background loop that polls pending reminders each minute and calls `notify`
 * for any that are now due. State is persisted in {@link ReminderStore} so
 * reminders survive a process restart.
 *
 * Usage: call `start()` concurrently alongside other async work; call `stop()`
 * to wind down promptly.
 */
export class ReminderRunner {
  private readonly store: ReminderStore;
  private readonly intervalMs: number;
  private readonly log: Logger;
  private running = false;
  private readonly abort = new AbortController();

  constructor(private readonly opts: ReminderRunnerOptions) {
    this.store = opts.store;
    this.intervalMs = opts.intervalMs ?? 60_000;
    this.log = (opts.logger ?? nullLogger).child().withContext({ component: "reminder-runner" });
  }

  /**
   * Start the polling loop. Polls immediately on entry (fires any reminders
   * overdue from before restart), then sleeps `intervalMs` between rounds.
   * Resolves when {@link stop} is called.
   */
  async start(): Promise<void> {
    this.running = true;
    const pending = this.store.list();
    this.log
      .withMetadata({ intervalMs: this.intervalMs, pending: pending.length })
      .info("reminder runner started");
    await this.poll();
    while (this.running) {
      await this.sleep(this.intervalMs);
      if (!this.running) break;
      await this.poll();
    }
    this.log.info("reminder runner stopped");
  }

  stop(): void {
    this.running = false;
    this.abort.abort();
  }

  private async poll(): Promise<void> {
    const now = Date.now();
    const due = this.store.takeDue(now);
    if (due.length === 0) return;
    this.log.withMetadata({ count: due.length }).info("firing due reminders");
    for (const reminder of due) {
      try {
        await this.opts.notify(formatNotification(reminder));
        this.log.withMetadata({ id: reminder.id, message: reminder.message }).info("reminder sent");
      } catch (err) {
        this.log.withError(err).withMetadata({ id: reminder.id }).warn("failed to send reminder");
      }
    }
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
