import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { uuidv7 } from "@earendil-works/pi-agent-core";

/**
 * Durable per-chat session: the transcript plus the active project and an
 * optional human-readable name. Persisted as JSON so the agent survives restarts
 * (spike DoD: continuity across a restart).
 */
export interface SessionState {
  sessionId: string;
  /** Optional human-friendly label set via `/name`. */
  name?: string;
  activeProject?: string;
  messages: AgentMessage[];
  /** Epoch millis; set at creation, never changed. */
  createdAt: number;
  /** Epoch millis; refreshed on every save. */
  updatedAt: number;
}

/** Lightweight session descriptor for listing (no transcript). */
export interface SessionSummary {
  sessionId: string;
  name?: string;
  activeProject?: string;
  messageCount: number;
  createdAt: number;
  updatedAt: number;
}

export function newSession(name?: string): SessionState {
  const now = Date.now();
  return { sessionId: uuidv7(), name, messages: [], createdAt: now, updatedAt: now };
}

/**
 * Short, distinguishing handle for a session: the trailing 8 hex digits.
 * uuidv7 is time-ordered, so leading characters collide for sessions created
 * close together — the random tail is what tells them apart.
 */
export function shortId(sessionId: string): string {
  return sessionId.replace(/-/g, "").slice(-8);
}

function readFileSafe(path: string): string | null {
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}

/**
 * File-backed multi-session store. Sessions live as one JSON file each under a
 * `sessions/` directory; a `current` pointer file names the active one. The
 * directory is derived from the configured session file path, so a pre-existing
 * single-file session is migrated in on first load.
 */
export class SessionStore {
  private readonly legacyFile: string;
  private readonly root: string;
  private readonly dir: string;
  private readonly pointer: string;
  private readonly offsetFile: string;

  /**
   * @param filePath - Path to the session file (directory is derived from this).
   * @param sanitize - Optional transform applied to the session state before
   *   writing to disk. Use to redact secrets from persisted data without
   *   altering the in-memory state.
   */
  constructor(
    filePath: string,
    private readonly sanitize?: (v: unknown) => unknown,
  ) {
    this.legacyFile = filePath;
    this.root = dirname(filePath);
    this.dir = join(this.root, "sessions");
    this.pointer = join(this.root, "current");
    this.offsetFile = join(this.root, "offset");
  }

  private file(sessionId: string): string {
    return join(this.dir, `${sessionId}.json`);
  }

  private parse(raw: string | null): SessionState | null {
    if (raw == null) return null;
    try {
      const p = JSON.parse(raw) as Partial<SessionState>;
      if (!p.sessionId || !Array.isArray(p.messages)) return null;
      const now = Date.now();
      return {
        sessionId: p.sessionId,
        name: p.name,
        activeProject: p.activeProject,
        messages: p.messages,
        createdAt: p.createdAt ?? now,
        updatedAt: p.updatedAt ?? now,
      };
    } catch {
      return null;
    }
  }

  /** The current session id, or null if the pointer is missing/dangling. */
  private readPointer(): string | null {
    const id = readFileSafe(this.pointer)?.trim();
    return id && existsSync(this.file(id)) ? id : null;
  }

  private setCurrent(sessionId: string): void {
    if (!existsSync(this.root)) mkdirSync(this.root, { recursive: true });
    const tmp = `${this.pointer}.tmp`;
    writeFileSync(tmp, sessionId);
    renameSync(tmp, this.pointer);
  }

  /** One-time import of a pre-multi-session file as the first real session. */
  private ensureMigrated(): void {
    if (this.readPointer()) return;
    const legacy = this.parse(readFileSafe(this.legacyFile));
    if (legacy) this.save(legacy);
  }

  /** Load the current session, or `null` if there is none yet. */
  load(): SessionState | null {
    this.ensureMigrated();
    const id = this.readPointer();
    return id ? this.get(id) : null;
  }

  /** Load a specific session by id, or `null` if absent/malformed. */
  get(sessionId: string): SessionState | null {
    return this.parse(readFileSafe(this.file(sessionId)));
  }

  /**
   * Persist `state` and mark it current. Refreshes `updatedAt` (mutating the
   * passed object, which the caller holds as the live session).
   * Writes are atomic: content goes to a sibling `.tmp` file first, then
   * renamed into place, so a crash mid-write never leaves a partial file.
   */
  save(state: SessionState): void {
    if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true });
    state.updatedAt = Date.now();
    const file = this.file(state.sessionId);
    const tmp = `${file}.tmp`;
    const toWrite = this.sanitize ? this.sanitize(state) : state;
    writeFileSync(tmp, JSON.stringify(toWrite, null, 2));
    renameSync(tmp, file);
    this.setCurrent(state.sessionId);
  }

  /** Load the last-seen Telegram update offset, or 0 if not yet persisted. */
  loadOffset(): number {
    const raw = readFileSafe(this.offsetFile);
    if (raw == null) return 0;
    const n = Number.parseInt(raw.trim(), 10);
    return Number.isNaN(n) ? 0 : n;
  }

  /** Atomically persist the Telegram update offset. */
  saveOffset(offset: number): void {
    if (!existsSync(this.root)) mkdirSync(this.root, { recursive: true });
    const tmp = `${this.offsetFile}.tmp`;
    writeFileSync(tmp, String(offset));
    renameSync(tmp, this.offsetFile);
  }

  /** All saved sessions, most-recently-updated first. */
  list(): SessionSummary[] {
    this.ensureMigrated();
    if (!existsSync(this.dir)) return [];
    const out: SessionSummary[] = [];
    for (const f of readdirSync(this.dir)) {
      if (!f.endsWith(".json")) continue;
      const s = this.parse(readFileSafe(join(this.dir, f)));
      if (s) {
        out.push({
          sessionId: s.sessionId,
          name: s.name,
          activeProject: s.activeProject,
          messageCount: s.messages.length,
          createdAt: s.createdAt,
          updatedAt: s.updatedAt,
        });
      }
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /**
   * Remove a session file from the store. Returns `true` if the file existed
   * and was deleted, `false` if there was nothing to delete. Does not update
   * the `current` pointer — callers are responsible for not deleting the active
   * session (the retention runner checks this).
   */
  delete(sessionId: string): boolean {
    const f = this.file(sessionId);
    if (!existsSync(f)) return false;
    unlinkSync(f);
    return true;
  }

  /**
   * Resolve a session by its full id, its short handle (see {@link shortId}), or
   * a case-insensitive name. Returns the full state, or `null` when nothing
   * matches. Prefix matching is deliberately avoided — uuidv7 ids share leading
   * characters, so a prefix would be ambiguous.
   */
  find(idOrName: string): SessionState | null {
    const q = idOrName.trim();
    if (!q) return null;
    const ql = q.toLowerCase();
    const summaries = this.list();
    const hit =
      summaries.find((s) => s.sessionId === q) ??
      summaries.find((s) => shortId(s.sessionId).toLowerCase() === ql) ??
      summaries.find((s) => s.name?.toLowerCase() === ql);
    return hit ? this.get(hit.sessionId) : null;
  }
}
