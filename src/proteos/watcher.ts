import { type Logger, nullLogger } from "../logger.ts";
import type { ProteosClient } from "./proteos.ts";
import { type WatchedTask, WatchedTasksStore } from "./watched-store.ts";

/**
 * Extract the first task id (e.g. "t-456") from proteos CLI output. Task ids
 * follow the `t-<alphanumeric>` pattern documented in the proteos tool schemas.
 */
export function extractTaskId(output: string): string | undefined {
  return output.match(/\bt-[a-z0-9]+\b/)?.[0];
}

/**
 * Derive a coarse terminal/running classification from the text output of
 * `proteos task get`. The status word is extracted from a `status: <word>` line
 * first; keyword scanning is the fallback. Returns "unknown" when the output
 * carries no interpretable signal — treated as non-terminal (keep watching).
 */
export function parseTaskStatus(
  output: string,
): "completed" | "failed" | "canceled" | "running" | "unknown" {
  const lower = output.toLowerCase();
  const m = lower.match(/\bstatus\b[:\s]+([a-z_-]+)/);
  const word = m?.[1];
  if (word) {
    if (["completed", "done", "success", "succeeded"].includes(word)) return "completed";
    if (["failed", "failure", "error", "errored"].includes(word)) return "failed";
    if (["canceled", "cancelled", "aborted"].includes(word)) return "canceled";
    if (["running", "pending", "queued", "starting", "created", "in_progress"].includes(word))
      return "running";
  }
  // Keyword fallback when there is no explicit status field
  if (lower.includes("completed") || lower.includes("done")) return "completed";
  if (lower.includes("failed") || lower.includes("error")) return "failed";
  if (lower.includes("canceled") || lower.includes("cancelled")) return "canceled";
  return "unknown";
}

const TERMINAL_STATUSES = new Set<string>(["completed", "failed", "canceled"]);

function isTerminal(status: string): boolean {
  return TERMINAL_STATUSES.has(status);
}

function isFailure(status: string): boolean {
  return status === "failed" || status === "canceled";
}

function formatNotification(task: WatchedTask, status: string, output: string): string {
  const elapsedSec = Math.round((Date.now() - task.dispatchedAt) / 1000);
  const elapsed = elapsedSec < 60 ? `${elapsedSec}s` : `${Math.round(elapsedSec / 60)}m`;
  const header = isFailure(status)
    ? `ProteOS task ${task.taskId} failed (${elapsed})`
    : `ProteOS task ${task.taskId} completed (${elapsed})`;
  const lines = [header, `Machine: ${task.machine}  Project: ${task.project}`];
  if (task.label) lines.push(`Prompt: ${task.label}`);
  const details = output
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, 5)
    .join("\n");
  if (details) lines.push(details);
  return lines.join("\n");
}

export interface ProteosTaskWatcherOptions {
  proteos: ProteosClient;
  /** Deliver a notification to the user (e.g. send a Telegram message). */
  notify: (message: string) => Promise<void>;
  /** Path to the persisted task list (survives restarts). */
  storeFile: string;
  /** How long to sleep between poll rounds. */
  intervalMs: number;
  logger?: Logger;
}

/**
 * Background loop that polls in-flight ProteOS tasks and calls `notify` when
 * each one reaches a terminal state (completed/failed/canceled). State is
 * persisted so watched tasks survive a process restart.
 *
 * Usage: call {@link watch} whenever a task is dispatched, then start the loop
 * with {@link start} (run it concurrently alongside other async work). Call
 * {@link stop} to wind down; `start()` will return promptly.
 */
export class ProteosTaskWatcher {
  private readonly store: WatchedTasksStore;
  private readonly log: Logger;
  private running = false;
  private readonly abort = new AbortController();

  constructor(private readonly opts: ProteosTaskWatcherOptions) {
    this.store = new WatchedTasksStore(opts.storeFile);
    this.log = (opts.logger ?? nullLogger).child().withContext({ component: "proteos-watcher" });
  }

  /** Register a newly dispatched task for background monitoring. Idempotent. */
  watch(machine: string, taskId: string, project: string, label: string): void {
    const task: WatchedTask = { machine, taskId, project, label, dispatchedAt: Date.now() };
    this.store.add(task);
    this.log.withMetadata({ taskId, machine, project }).info("watching proteos task");
  }

  /**
   * Start the polling loop. Polls immediately on entry (picks up tasks that
   * survived a restart), then sleeps `intervalMs` between rounds. Resolves when
   * {@link stop} is called.
   */
  async start(): Promise<void> {
    this.running = true;
    const pending = this.store.list();
    this.log
      .withMetadata({ intervalMs: this.opts.intervalMs, pending: pending.length })
      .info("proteos task watcher started");
    // Immediate poll so restarted tasks are noticed without a full interval delay.
    await this.poll();
    while (this.running) {
      await this.sleep(this.opts.intervalMs);
      if (!this.running) break;
      await this.poll();
    }
    this.log.info("proteos task watcher stopped");
  }

  stop(): void {
    this.running = false;
    this.abort.abort();
  }

  private async poll(): Promise<void> {
    const tasks = this.store.list();
    if (tasks.length === 0) return;
    this.log.withMetadata({ count: tasks.length }).debug("polling proteos tasks");
    for (const task of tasks) {
      if (!this.running) return;
      await this.checkTask(task);
    }
  }

  private async checkTask(task: WatchedTask): Promise<void> {
    try {
      const output = await this.opts.proteos.taskGet(task.machine, task.taskId, this.abort.signal);
      const status = parseTaskStatus(output);
      this.log.withMetadata({ taskId: task.taskId, status }).debug("proteos task status polled");
      if (isTerminal(status)) {
        this.log
          .withMetadata({ taskId: task.taskId, status })
          .info("proteos task reached terminal state");
        this.store.remove(task.taskId);
        try {
          await this.opts.notify(formatNotification(task, status, output));
        } catch (notifyErr) {
          this.log
            .withError(notifyErr)
            .withMetadata({ taskId: task.taskId })
            .warn("failed to send task completion notification");
        }
      }
    } catch (error) {
      if (!this.running) return;
      this.log
        .withError(error)
        .withMetadata({ taskId: task.taskId })
        .warn("failed to poll proteos task status");
    }
  }

  /** Sleep `ms`, resolving early if {@link stop} aborts. */
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
