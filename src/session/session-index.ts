import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { type Logger, nullLogger } from "../logger.ts";
import type { SessionState, SessionStore, SessionSummary } from "./store.ts";

/** Index entry: summary plus all project slugs the session has ever been active for. */
export interface SessionIndexEntry extends SessionSummary {
  projects: string[];
}

export interface SessionQuery {
  /** Case-insensitive substring match on the session name. */
  name?: string;
  /** Exact match against any project slug in the session's `projects` list. */
  project?: string;
  /** Only sessions last updated at or after this epoch-millis timestamp. */
  after?: number;
  /** Only sessions last updated strictly before this epoch-millis timestamp. */
  before?: number;
  /** Only sessions with at least this many messages. */
  minMessages?: number;
}

/**
 * Persistent file-backed index of session summaries. Much faster than scanning
 * all session JSON files for listings and searches. Rebuilt from the store on
 * demand; updated incrementally on every {@link upsert} and {@link remove}.
 *
 * Designed to be constructed and populated in `index.ts` at startup, then
 * threaded into `ChatSession` (via deps) so every `persist()` call keeps it
 * current.
 */
export class SessionIndex {
  private entries: Map<string, SessionIndexEntry> = new Map();
  private readonly log: Logger;

  constructor(
    private readonly indexFile: string,
    logger?: Logger,
  ) {
    this.log = (logger ?? nullLogger).child().withContext({ component: "session-index" });
    this.load();
  }

  private load(): void {
    if (!existsSync(this.indexFile)) return;
    try {
      const raw = readFileSync(this.indexFile, "utf8");
      const data = JSON.parse(raw) as SessionIndexEntry[];
      for (const entry of data) {
        this.entries.set(entry.sessionId, entry);
      }
      this.log.withMetadata({ count: this.entries.size }).debug("session index loaded");
    } catch {
      this.log.warn("session index file unreadable; will rebuild on next flush");
    }
  }

  private flush(): void {
    const dir = dirname(this.indexFile);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const data = [...this.entries.values()];
    const tmp = `${this.indexFile}.tmp`;
    writeFileSync(tmp, JSON.stringify(data, null, 2));
    renameSync(tmp, this.indexFile);
  }

  /**
   * Rebuild the entire index from the store. Called once at startup so the
   * index reflects sessions created before the index existed.
   */
  rebuild(store: SessionStore): void {
    this.entries.clear();
    for (const s of store.list()) {
      this.entries.set(s.sessionId, {
        ...s,
        projects: s.activeProject ? [s.activeProject] : [],
      });
    }
    this.flush();
    this.log.withMetadata({ count: this.entries.size }).info("session index rebuilt");
  }

  /**
   * Insert or update the index entry for a session. Accumulates all project
   * slugs the session has ever been active for (useful for search).
   */
  upsert(state: SessionState): void {
    const existing = this.entries.get(state.sessionId);
    const projects = existing?.projects ? [...existing.projects] : [];
    if (state.activeProject && !projects.includes(state.activeProject)) {
      projects.push(state.activeProject);
    }
    this.entries.set(state.sessionId, {
      sessionId: state.sessionId,
      name: state.name,
      activeProject: state.activeProject,
      messageCount: state.messages.length,
      createdAt: state.createdAt,
      updatedAt: state.updatedAt,
      projects,
    });
    this.flush();
  }

  /** Remove a session entry (called by the retention runner after deletion). */
  remove(sessionId: string): void {
    if (this.entries.delete(sessionId)) {
      this.flush();
    }
  }

  /** All entries, most-recently-updated first. */
  list(): SessionIndexEntry[] {
    return [...this.entries.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /**
   * Filter entries by query. All specified fields must match (AND semantics).
   * Returns results ordered newest-first.
   */
  search(query: SessionQuery): SessionIndexEntry[] {
    return this.list().filter((e) => {
      if (query.name !== undefined && !e.name?.toLowerCase().includes(query.name.toLowerCase()))
        return false;
      if (query.project !== undefined && !e.projects.includes(query.project)) return false;
      if (query.after !== undefined && e.updatedAt < query.after) return false;
      if (query.before !== undefined && e.updatedAt >= query.before) return false;
      if (query.minMessages !== undefined && e.messageCount < query.minMessages) return false;
      return true;
    });
  }

  get size(): number {
    return this.entries.size;
  }
}
