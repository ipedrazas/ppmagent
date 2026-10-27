/**
 * Per-chat session state: the persisted {@link SessionState} (active project,
 * name, link to the session's durable conversation) plus the operations that
 * read or mutate it — persistence, session switching (`/new`, `/resume`),
 * compaction, and the `/context` and `/session` reports. The transcript itself
 * lives in the pi-durable store and is reached through the runtime.
 *
 * Extracted from {@link TelegramBot} so the transport layer no longer owns
 * session state. Crucially, a ChatSession is constructed *before* the agent:
 * `activeProject` has no dependency on the agent, so the memory-injection seam
 * can read it via `() => session.activeProject` with no mutable holder. The
 * runtime is bound afterwards with {@link attach}.
 */
import type { Message } from "@earendil-works/pi-ai";
import type { BuiltAgent } from "../agent.ts";
import { resolveThreshold } from "../compaction.ts";
import type { Config } from "../config.ts";
import type { Logger } from "../logger.ts";
import type { MetricsCollector } from "../metrics/collector.ts";
import type { ConversationKey } from "../runtime/runtime.ts";
import type { SessionIndex } from "../session/session-index.ts";
import { newSession, type SessionState, type SessionStore, shortId } from "../session/store.ts";
import type { TraceRecorder } from "../trace/recorder.ts";

/** One-line label for a session in listings: `<short> "name" — N msgs, project`. */
function sessionLabel(s: {
  sessionId: string;
  name?: string;
  activeProject?: string;
  messageCount: number;
}): string {
  const parts = [shortId(s.sessionId)];
  if (s.name) parts.push(`"${s.name}"`);
  const meta = [`${s.messageCount} msgs`];
  if (s.activeProject) meta.push(s.activeProject);
  return `${parts.join(" ")} — ${meta.join(", ")}`;
}

export interface ChatSessionDeps {
  store: SessionStore;
  /** Session trace sink (compaction events). Absent = no tracing. */
  recorder?: TraceRecorder;
  /** Live metrics collector; compaction token counts are recorded when present. */
  metrics?: MetricsCollector;
  /** Root logger; a `component: chat-session` child is derived. Defaults to discarding. */
  logger?: Logger;
  /** Session index, updated on every persist (upsert). Absent = no indexing. */
  index?: SessionIndex;
}

export class ChatSession {
  private state: SessionState;
  /** Bound in {@link attach}; every transcript operation goes through the runtime. */
  private built!: BuiltAgent;

  constructor(
    private readonly config: Config,
    private readonly deps: ChatSessionDeps,
  ) {
    // Restore the persisted session (or start fresh).
    this.state = deps.store.load() ?? newSession();
    deps.recorder?.setSession(this.state.sessionId);
  }

  /**
   * Bind the built agent. Called once, after `buildAgent`, to complete the wiring
   * the old mutable holder used to provide.
   */
  attach(built: BuiltAgent): void {
    this.built = built;
  }

  // ── State accessors ──

  /** Active project — read by the memory-injection seam via a bound closure. */
  get activeProject(): string | undefined {
    return this.state.activeProject;
  }
  set activeProject(slug: string | undefined) {
    this.state.activeProject = slug;
  }

  get sessionId(): string {
    return this.state.sessionId;
  }

  get name(): string | undefined {
    return this.state.name;
  }
  set name(name: string | undefined) {
    this.state.name = name;
  }

  /** Toggled via `/describe` — read by the turn runner to inject the reasoning prompt. */
  get describeEnabled(): boolean {
    return this.state.describeEnabled ?? false;
  }
  set describeEnabled(value: boolean) {
    this.state.describeEnabled = value;
  }

  /** The session's durable conversation id, if it has been used yet. */
  get conversationId(): ConversationKey | undefined {
    return this.state.conversationId;
  }

  /**
   * The session's durable conversation, created on first use (and re-created if
   * the durable store no longer has it, e.g. after its file was reset).
   */
  async ensureConversation(): Promise<ConversationKey> {
    const { runtime, observe } = this.built;
    let id = this.state.conversationId;
    if (id === undefined || !(await runtime.hasConversation(id))) {
      id = await runtime.createConversation();
      this.state.conversationId = id;
      this.state.messageCount = 0;
    }
    observe(id);
    return id;
  }

  /** The stored transcript (system prompt excluded); empty before the first turn. */
  async messages(): Promise<Message[]> {
    const id = this.state.conversationId;
    if (id === undefined || !(await this.built.runtime.hasConversation(id))) return [];
    this.built.observe(id);
    return this.built.runtime.messages(id);
  }

  // ── Persistence & switching ──

  /** Write the session metadata (and refresh the search index). */
  persist(): void {
    this.deps.store.save(this.state);
    this.deps.index?.upsert(this.state);
  }

  /** Re-read the transcript into the persisted listing count and export snapshot. */
  async refreshMessageCount(): Promise<void> {
    const messages = await this.messages();
    this.state.messageCount = messages.length;
    this.state.messages = messages;
  }

  /**
   * Make `state` the live session. Used by `/new` and `/resume`. The caller
   * persists after.
   */
  switchTo(state: SessionState): void {
    this.state = state;
    this.deps.recorder?.setSession(state.sessionId);
  }

  /**
   * Start a fresh session, carrying the active project forward so memory
   * injection still targets it — the point of a fresh transcript is to check
   * what the agent recalls from `ppm`. Persists and returns the new state.
   */
  startNew(name?: string): SessionState {
    // Don't persist an untouched throwaway session; keep the store tidy.
    if (this.state.conversationId !== undefined) this.persist();
    const fresh = newSession(name);
    fresh.activeProject = this.state.activeProject;
    this.switchTo(fresh);
    this.persist();
    return fresh;
  }

  // ── Compaction ──

  /**
   * Compact the transcript now (`/compact`). Automatic compaction runs inside
   * the durable runtime when the context nears the configured threshold; the
   * summary is flushed to project memory by the conversation observer.
   */
  async compact(): Promise<{
    compacted: boolean;
    tokensBefore: number;
    tokensAfter: number;
    messagesBefore: number;
    messagesAfter: number;
  }> {
    const id = this.state.conversationId;
    const { runtime } = this.built;
    if (id === undefined || !(await runtime.hasConversation(id))) {
      return {
        compacted: false,
        tokensBefore: 0,
        tokensAfter: 0,
        messagesBefore: 0,
        messagesAfter: 0,
      };
    }
    this.built.observe(id);
    const extra = this.built.memoryContext.sliceTokens();
    const messagesBefore = (await runtime.messages(id)).length;
    const tokensBefore = (await runtime.contextTokens(id)) + extra;
    const { compacted } = await runtime.compact(id);
    const messagesAfter = (await runtime.messages(id)).length;
    const tokensAfter = (await runtime.contextTokens(id)) + extra;
    if (compacted) {
      this.deps.recorder?.record({
        type: "compaction",
        tokensBefore,
        tokensAfter,
        messagesAfter,
        threshold: resolveThreshold(this.config.compactionTokenThreshold),
      });
      this.deps.metrics?.recordCompaction(tokensBefore, tokensAfter);
    }
    return { compacted, tokensBefore, tokensAfter, messagesBefore, messagesAfter };
  }

  // ── Reports ──

  /** Human-readable snapshot of context usage vs. the compaction threshold. */
  async contextReport(): Promise<string> {
    const id = this.state.conversationId;
    const messages = await this.messages();
    const stored =
      id === undefined || messages.length === 0 ? 0 : await this.built.runtime.contextTokens(id);
    const used = stored + this.built.memoryContext.sliceTokens();
    const threshold = resolveThreshold(this.config.compactionTokenThreshold);
    const pct = Math.round((used / threshold) * 100);
    return (
      `Context: ~${used.toLocaleString()} tokens across ${messages.length} messages ` +
      `(compaction at ${threshold.toLocaleString()}, ${pct}%).`
    );
  }

  /** Details of the current session, plus a count of others on disk. */
  async sessionReport(): Promise<string> {
    const s = this.state;
    const others = this.deps.store.list().filter((x) => x.sessionId !== s.sessionId).length;
    const lines = [
      `Session ${shortId(s.sessionId)}${s.name ? ` "${s.name}"` : ""}`,
      `Project: ${s.activeProject ?? "(none)"}`,
      `Messages: ${(await this.messages()).length}`,
    ];
    if (others > 0)
      lines.push(`${others} other session${others === 1 ? "" : "s"} — /resume to list.`);
    return lines.join("\n");
  }

  /**
   * `/resume` with no argument lists saved sessions; with an id/name it switches
   * to that session. Returns the reply text. Persists the outgoing session first
   * (if non-empty) so no in-progress transcript is lost on the swap.
   */
  resume(arg: string): string {
    if (!arg) {
      const sessions = this.deps.store.list();
      if (sessions.length === 0) return "No saved sessions yet.";
      const lines = sessions.map(
        (s) => `• ${sessionLabel(s)}${s.sessionId === this.state.sessionId ? " (current)" : ""}`,
      );
      return `Sessions:\n${lines.join("\n")}\n\nResume with /resume <id|name>.`;
    }
    const target = this.deps.store.find(arg);
    if (!target) return `No session matches "${arg}".`;
    if (target.sessionId === this.state.sessionId) return "That session is already active.";
    if (this.state.conversationId !== undefined) this.persist();
    this.switchTo(target);
    this.persist();
    return `Resumed session ${shortId(target.sessionId)}${target.name ? ` "${target.name}"` : ""} (${target.messageCount} messages).`;
  }
}
