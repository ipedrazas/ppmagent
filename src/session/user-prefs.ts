import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Config } from "../config.ts";

/** Per-user preferences. Absent field = the user has not chosen; use the deployment default. */
export interface UserPrefsEntry {
  /** Set via `/verbose on|off`; overrides `PPMA_SHOW_TOOL_CALLS` for this user. */
  showToolCalls?: boolean;
}

/** Where an effective setting came from. */
export type PrefSource = "user" | "default";

/**
 * Per-user preference store, keyed by Telegram user id (not chat or session, so a
 * preference follows the user across chats and `/new`). Persisted as one JSON
 * file next to the session files, written atomically like the poll offset.
 * Constructed without a path it is memory-only (tests, embedding).
 */
export class UserPrefs {
  private data: Record<string, UserPrefsEntry> = {};

  constructor(private readonly path?: string) {
    if (path && existsSync(path)) {
      try {
        const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          this.data = parsed as Record<string, UserPrefsEntry>;
        }
      } catch {
        // Corrupt file: start empty rather than fail boot; the next write replaces it.
      }
    }
  }

  /** The user's explicit tool-call display choice, or `undefined` if they have none. */
  getShowToolCalls(userId: number): boolean | undefined {
    const v = this.data[String(userId)]?.showToolCalls;
    return typeof v === "boolean" ? v : undefined;
  }

  /** Store (or, with `undefined`, clear) the user's choice and persist. */
  setShowToolCalls(userId: number, value: boolean | undefined): void {
    const key = String(userId);
    const entry = { ...this.data[key] };
    if (value === undefined) delete entry.showToolCalls;
    else entry.showToolCalls = value;
    if (Object.keys(entry).length === 0) delete this.data[key];
    else this.data[key] = entry;
    this.flush();
  }

  private flush(): void {
    if (!this.path) return;
    const dir = dirname(this.path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    renameSync(tmp, this.path);
  }
}

/**
 * The single place tool-call display is decided. A stored `/verbose` choice wins;
 * otherwise fall back to `PPMA_SHOW_TOOL_CALLS` (`config.showToolCalls`). Called
 * per turn, so a toggle applies on the next turn without a restart.
 */
export function resolveShowToolCalls(
  config: Pick<Config, "showToolCalls">,
  prefs: UserPrefs | undefined,
  userId: number,
): { value: boolean; source: PrefSource } {
  const stored = prefs?.getShowToolCalls(userId);
  return stored === undefined
    ? { value: config.showToolCalls, source: "default" }
    : { value: stored, source: "user" };
}
