import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface WatchedTask {
  machine: string;
  taskId: string;
  project: string;
  /** Epoch millis when the task was dispatched. */
  dispatchedAt: number;
  /** Truncated prompt snippet for human-readable notifications. */
  label?: string;
}

interface WatchedTasksFile {
  tasks: WatchedTask[];
  updatedAt: number;
}

/**
 * File-backed store for ProteOS tasks being monitored by the background watcher.
 * Persists across process restarts so in-flight tasks are not forgotten.
 */
export class WatchedTasksStore {
  constructor(private readonly filePath: string) {}

  private read(): WatchedTask[] {
    if (!existsSync(this.filePath)) return [];
    try {
      const raw = readFileSync(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<WatchedTasksFile>;
      return Array.isArray(parsed.tasks) ? (parsed.tasks as WatchedTask[]) : [];
    } catch {
      return [];
    }
  }

  private write(tasks: WatchedTask[]): void {
    const dir = dirname(this.filePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const file: WatchedTasksFile = { tasks, updatedAt: Date.now() };
    writeFileSync(this.filePath, JSON.stringify(file, null, 2));
  }

  list(): WatchedTask[] {
    return this.read();
  }

  /** Add a task to the watch list (idempotent — duplicate taskId is a no-op). */
  add(task: WatchedTask): void {
    const tasks = this.read();
    if (!tasks.find((t) => t.taskId === task.taskId)) {
      tasks.push(task);
      this.write(tasks);
    }
  }

  remove(taskId: string): void {
    const tasks = this.read().filter((t) => t.taskId !== taskId);
    this.write(tasks);
  }
}
