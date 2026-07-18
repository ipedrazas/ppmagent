import { type Logger, nullLogger } from "../logger.ts";
import type { Reminder, ReminderStore } from "./store.ts";

function formatNotification(reminder: Reminder): string {
  return `⏰ Reminder: ${reminder.message}`;
}

export interface ReminderRunnerOptions {
  store: ReminderStore;
  /** Deliver a notification to the user (e.g. send a Telegram message). */
  notify: (message: string) => Promise<void>;
  /** How long to sleep between poll rounds. Default: 30 000 ms (30 seconds). */
  intervalMs?: number;
  logger?: Logger;
}

/**
 * Background loop that polls pending reminders every `intervalMs` and calls
 * `notify` for any that are now due. State is persisted in
 * {@link ReminderStore} so reminders survive a process restart.
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
    this.intervalMs = opts.intervalMs ?? 30_000;
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

  /**
   * Run exactly one poll round and return when it completes. Lets callers
   * drive the runner deterministically (used by tests) without racing the
   * background loop's timers against an in-flight poll.
   */
  async pollOnce(): Promise<void> {
    this.running = true;
    await this.poll();
  }

  private async poll(): Promise<void> {
    const now = Date.now();
    let due: Reminder[];
    try {
      due = this.store.due(now);
    } catch (err) {
      // A store read/write failure (e.g. a transient disk error) must not
      // propagate: that would reject start()'s promise, which — awaited
      // alongside the Telegram bot in main()'s Promise.all — would crash the
      // entire process over a reminder-store hiccup. Log and retry next round.
      this.log.withError(err).warn("failed to read due reminders; will retry next poll");
      return;
    }
    if (due.length === 0) return;
    this.log.withMetadata({ count: due.length }).info("firing due reminders");
    for (const reminder of due) {
      // Send first, remove on success: a failed send keeps the reminder in
      // the store so it retries next poll (at-least-once delivery). The old
      // pop-then-send order lost the reminder forever on a single network
      // blip. The trade-off: if remove() fails after a successful send, the
      // reminder may fire twice — a duplicate ping beats a silent drop.
      try {
        await this.opts.notify(formatNotification(reminder));
      } catch (err) {
        this.log
          .withError(err)
          .withMetadata({ id: reminder.id })
          .warn("failed to send reminder; will retry next poll");
        continue;
      }
      try {
        this.store.remove(reminder.id);
        this.log.withMetadata({ id: reminder.id, message: reminder.message }).info("reminder sent");
      } catch (err) {
        this.log
          .withError(err)
          .withMetadata({ id: reminder.id })
          .warn("reminder sent but could not be removed from store; it may fire again");
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
