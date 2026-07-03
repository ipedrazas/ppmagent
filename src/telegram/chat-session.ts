/**
 * Per-chat session state: the durable {@link SessionState} (transcript + active
 * project + name) plus the operations that read or mutate it — persistence,
 * session switching (`/new`, `/resume`), compaction, and the `/context` and
 * `/session` reports.
 *
 * Extracted from {@link TelegramBot} so the transport layer no longer owns
 * session state. Crucially, a ChatSession is constructed *before* the agent:
 * `activeProject` has no dependency on the agent, so the memory-injection seam
 * can read it via `() => session.activeProject` with no mutable holder. The
 * agent's transcript is bound afterwards with {@link attach}.
 */
import type { BuiltAgent } from "../agent.ts";
import {
  type CompactionOutcome,
  DEFAULT_KEEP_RECENT,
  type Summarizer,
  contextTokens,
  maybeCompact,
  placeholderSummarizer,
  resolveThreshold,
} from "../compaction.ts";
import type { Config } from "../config.ts";
import type { Logger } from "../logger.ts";
import type { MetricsCollector } from "../metrics/collector.ts";
import { type SessionState, type SessionStore, newSession, shortId } from "../session/store.ts";
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
  /** Transcript summarizer used at compaction. Defaults to the model-free one. */
  summarize?: Summarizer;
  /** Session trace sink (compaction events). Absent = no tracing. */
  recorder?: TraceRecorder;
  /** Live metrics collector; compaction token counts are recorded when present. */
  metrics?: MetricsCollector;
  /** Root logger; a `component: chat-session` child is derived. Defaults to discarding. */
  logger?: Logger;
}

export class ChatSession {
  private state: SessionState;
  /** Bound in {@link attach}; every transcript operation goes through the agent. */
  private built!: BuiltAgent;
  /** Model-free until {@link attach} supplies the production summarizer. */
  private summarize: Summarizer;

  constructor(
    private readonly config: Config,
    private readonly deps: ChatSessionDeps,
  ) {
    this.summarize = deps.summarize ?? placeholderSummarizer;
    // Restore the durable session (or start fresh).
    this.state = deps.store.load() ?? newSession();
    deps.recorder?.setSession(this.state.sessionId);
  }

  /**
   * Bind the built agent (and its model-backed summarizer) and point the agent's
   * transcript at this session's messages. Called once, after `buildAgent`, to
   * complete the wiring the old mutable holder used to provide. The summarizer is
   * injected here because it depends on the built model, which does not exist at
   * construction time.
   */
  attach(built: BuiltAgent, summarize?: Summarizer): void {
    this.built = built;
    if (summarize) this.summarize = summarize;
    this.built.agent.state.messages = this.state.messages;
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

  /** The live transcript (the agent's message array). */
  get messages() {
    return this.built.agent.state.messages;
  }

  // ── Persistence & switching ──

  persist(): void {
    this.state.messages = this.built.agent.state.messages;
    this.deps.store.save(this.state);
  }

  /**
   * Make `state` the live session: swap it in and point the agent's transcript
   * at its messages. Used by `/new` and `/resume`. The caller persists after.
   */
  switchTo(state: SessionState): void {
    this.state = state;
    this.built.agent.state.messages = state.messages;
    this.deps.recorder?.setSession(state.sessionId);
  }

  /**
   * Start a fresh session, carrying the active project forward so memory
   * injection still targets it — the point of a fresh transcript is to check
   * what the agent recalls from `ppm`. Persists and returns the new state.
   */
  startNew(name?: string): SessionState {
    // Don't persist an untouched throwaway session; keep the store tidy.
    if (this.messages.length > 0) this.persist();
    const fresh = newSession(name);
    fresh.activeProject = this.state.activeProject;
    this.switchTo(fresh);
    this.persist();
    return fresh;
  }

  // ── Compaction ──

  /**
   * Compact the live transcript when it crosses `threshold` tokens, flushing
   * the generated summary to memory as a durable checkpoint, and assign the
   * result back to the agent. Shared by the post-turn auto-compaction and the
   * manual `/compact` command (which forces an attempt by passing a threshold
   * of 1).
   */
  async compact(threshold: number): Promise<CompactionOutcome> {
    const outcome = await maybeCompact({
      messages: this.built.agent.state.messages,
      policy: { threshold, keepRecent: DEFAULT_KEEP_RECENT },
      summarize: this.summarize,
      flush: async (summary) => {
        if (this.state.activeProject) {
          await this.built.ppm.write([
            "conversation",
            "add",
            this.state.activeProject,
            "--content",
            `Compaction checkpoint.\n\n${summary}`,
          ]);
        }
      },
      extraTokens: this.built.memoryContext.sliceTokens(),
    });
    if (outcome.compacted) {
      this.built.agent.state.messages = outcome.messages;
      this.deps.recorder?.record({
        type: "compaction",
        tokensBefore: outcome.tokensBefore,
        tokensAfter: outcome.tokensAfter,
        messagesAfter: outcome.messages.length,
        threshold,
      });
      this.deps.metrics?.recordCompaction(outcome.tokensBefore, outcome.tokensAfter);
    }
    return outcome;
  }

  // ── Reports ──

  /** Human-readable snapshot of context usage vs. the compaction threshold. */
  contextReport(): string {
    const messages = this.built.agent.state.messages;
    const used = contextTokens(messages) + this.built.memoryContext.sliceTokens();
    const threshold = resolveThreshold(this.config.compactionTokenThreshold);
    const pct = Math.round((used / threshold) * 100);
    return (
      `Context: ~${used.toLocaleString()} tokens across ${messages.length} messages ` +
      `(compaction at ${threshold.toLocaleString()}, ${pct}%).`
    );
  }

  /** Details of the current session, plus a count of others on disk. */
  sessionReport(): string {
    const s = this.state;
    const others = this.deps.store.list().filter((x) => x.sessionId !== s.sessionId).length;
    const lines = [
      `Session ${shortId(s.sessionId)}${s.name ? ` "${s.name}"` : ""}`,
      `Project: ${s.activeProject ?? "(none)"}`,
      `Messages: ${this.built.agent.state.messages.length}`,
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
    if (this.messages.length > 0) this.persist();
    this.switchTo(target);
    this.persist();
    return `Resumed session ${shortId(target.sessionId)}${target.name ? ` "${target.name}"` : ""} (${target.messages.length} messages).`;
  }
}
