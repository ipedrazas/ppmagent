import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { uuidv7 } from "@earendil-works/pi-agent-core";

/**
 * Durable per-chat session: the transcript plus the active project. Persisted as
 * JSON so the agent survives restarts (spike DoD: continuity across a restart).
 */
export interface SessionState {
  sessionId: string;
  activeProject?: string;
  messages: AgentMessage[];
}

export function newSession(): SessionState {
  return { sessionId: uuidv7(), messages: [] };
}

/** File-backed {@link SessionState} store. Single-tenant PoC: one file. */
export class SessionStore {
  constructor(private readonly filePath: string) {}

  /** Load persisted state, or `null` if there is none yet. */
  load(): SessionState | null {
    if (!existsSync(this.filePath)) return null;
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, "utf8")) as SessionState;
      if (!parsed.sessionId || !Array.isArray(parsed.messages)) return null;
      return parsed;
    } catch {
      return null;
    }
  }

  save(state: SessionState): void {
    const dir = dirname(this.filePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(this.filePath, JSON.stringify(state, null, 2));
  }
}
