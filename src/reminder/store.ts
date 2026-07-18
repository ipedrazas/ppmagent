import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface Reminder {
  id: string;
  message: string;
  /** Epoch millis when the reminder should fire. */
  dueAt: number;
  /** Epoch millis when the reminder was created. */
  createdAt: number;
}

interface RemindersFile {
  reminders: Reminder[];
  updatedAt: number;
}

/**
 * File-backed store for pending reminders.
 * Persists across process restarts so reminders survive a reboot.
 */
export class ReminderStore {
  constructor(private readonly filePath: string) {}

  private read(): Reminder[] {
    if (!existsSync(this.filePath)) return [];
    try {
      const raw = readFileSync(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<RemindersFile>;
      return Array.isArray(parsed.reminders) ? (parsed.reminders as Reminder[]) : [];
    } catch {
      return [];
    }
  }

  private write(reminders: Reminder[]): void {
    const dir = dirname(this.filePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const file: RemindersFile = { reminders, updatedAt: Date.now() };
    writeFileSync(this.filePath, JSON.stringify(file, null, 2));
  }

  /** All pending reminders sorted by due time (soonest first). */
  list(): Reminder[] {
    return this.read().sort((a, b) => a.dueAt - b.dueAt);
  }

  /** Add a new reminder and return it (with generated id). */
  add(reminder: Omit<Reminder, "id" | "createdAt">): Reminder {
    const reminders = this.read();
    const bytes = new Uint8Array(4);
    crypto.getRandomValues(bytes);
    const id = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
    const r: Reminder = { id, createdAt: Date.now(), ...reminder };
    reminders.push(r);
    this.write(reminders);
    return r;
  }

  /** Remove a reminder by id. Returns true if it existed. */
  remove(id: string): boolean {
    const before = this.read();
    const after = before.filter((r) => r.id !== id);
    if (after.length === before.length) return false;
    this.write(after);
    return true;
  }

  /**
   * All reminders whose dueAt is <= now. Read-only: the runner removes each
   * one (via {@link remove}) only after its notification is actually sent, so
   * a failed send leaves the reminder in place to retry on the next poll.
   */
  due(now: number): Reminder[] {
    return this.read().filter((r) => r.dueAt <= now);
  }
}
