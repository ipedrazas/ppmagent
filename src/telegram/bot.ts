import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { BuiltAgent } from "../agent.ts";
import {
  DEFAULT_KEEP_RECENT,
  contextTokens,
  maybeCompact,
  placeholderSummarizer,
  resolveThreshold,
} from "../compaction.ts";
import type { CompactionOutcome, Summarizer } from "../compaction.ts";
import type { Config } from "../config.ts";
import { type Logger, nullLogger } from "../logger.ts";
import { type SessionState, type SessionStore, newSession, shortId } from "../session/store.ts";
import type { TelegramClient } from "./client.ts";

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

export interface TelegramBotDeps {
  client: TelegramClient;
  store: SessionStore;
  /** Transcript summarizer used at compaction. Defaults to the model-free one. */
  summarize?: Summarizer;
  /** Root logger; a `component: telegram-bot` child is derived. Defaults to discarding. */
  logger?: Logger;
}

/** Extract the visible text of an `ask_user` tool result. */
function askUserText(result: unknown): string {
  const content = (result as { content?: Array<{ type?: string; text?: string }> } | undefined)
    ?.content;
  if (!Array.isArray(content)) return "";
  return content.find((c) => c?.type === "text")?.text ?? "";
}

/** Concatenated text of the most recent assistant message, if any. */
function lastAssistantText(messages: AgentMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && "role" in m && m.role === "assistant" && Array.isArray(m.content)) {
      return m.content
        .filter((c): c is { type: "text"; text: string } => c?.type === "text")
        .map((c) => c.text)
        .join("");
    }
  }
  return "";
}

/**
 * Single-tenant Telegram adapter: one user, one chat, one workspace.
 *
 * Each inbound message → `agent.prompt`; the reply is the agent's assistant text
 * or, on a clarify turn, the `ask_user` question. After every turn the
 * transcript is compacted if over threshold (durable facts already live in
 * `ppm`). The session (transcript + active project) is persisted so the agent
 * survives restarts; the active project is exposed to `transformContext` via
 * {@link getActiveProject}.
 */
export class TelegramBot {
  private state: SessionState;
  private running = false;
  /** Aborts the in-flight long-poll so {@link stop} returns promptly. */
  private readonly abort = new AbortController();
  private readonly summarize: Summarizer;
  private readonly allowedChatId: number | undefined;
  private readonly log: Logger;

  constructor(
    private readonly config: Config,
    private readonly built: BuiltAgent,
    private readonly deps: TelegramBotDeps,
  ) {
    this.summarize = deps.summarize ?? placeholderSummarizer;
    this.log = (deps.logger ?? nullLogger).child().withContext({ component: "telegram-bot" });
    this.allowedChatId = config.telegramAllowedChatId
      ? Number(config.telegramAllowedChatId)
      : undefined;
    // Restore the durable session into the live agent.
    this.state = deps.store.load() ?? newSession();
    this.built.agent.state.messages = this.state.messages;
  }

  /** Active project for the current chat — read by the memory injection seam. */
  getActiveProject = (): string | undefined => this.state.activeProject;

  private persist(): void {
    this.state.messages = this.built.agent.state.messages;
    this.deps.store.save(this.state);
  }

  /**
   * Make `state` the live session: swap it in and point the agent's transcript at
   * its messages. Used by `/new` and `/resume`. The caller persists afterwards.
   */
  private switchTo(state: SessionState): void {
    this.state = state;
    this.built.agent.state.messages = state.messages;
  }

  /**
   * Compact the live transcript when it crosses `threshold` tokens, flushing a
   * durable checkpoint to memory first, and assign the result back to the agent.
   * Shared by the post-turn auto-compaction and the manual `/compact` command
   * (which forces an attempt by passing a threshold of 1).
   */
  private async compact(threshold: number): Promise<CompactionOutcome> {
    const outcome = await maybeCompact({
      messages: this.built.agent.state.messages,
      policy: { threshold, keepRecent: DEFAULT_KEEP_RECENT },
      summarize: this.summarize,
      flush: async () => {
        if (this.state.activeProject) {
          await this.built.ppm.write([
            "conversation",
            "add",
            this.state.activeProject,
            "--content",
            "Compaction checkpoint.",
          ]);
        }
      },
    });
    if (outcome.compacted) this.built.agent.state.messages = outcome.messages;
    return outcome;
  }

  /** Human-readable snapshot of context usage vs. the compaction threshold. */
  private contextReport(): string {
    const messages = this.built.agent.state.messages;
    const used = contextTokens(messages);
    const threshold = resolveThreshold(this.config.compactionTokenThreshold);
    const pct = Math.round((used / threshold) * 100);
    return (
      `Context: ~${used.toLocaleString()} tokens across ${messages.length} messages ` +
      `(compaction at ${threshold.toLocaleString()}, ${pct}%).`
    );
  }

  /** Details of the current session, plus a count of others on disk. */
  private sessionReport(): string {
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
  private resume(arg: string): string {
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
    if (this.built.agent.state.messages.length > 0) this.persist();
    this.switchTo(target);
    this.persist();
    return `Resumed session ${shortId(target.sessionId)}${target.name ? ` "${target.name}"` : ""} (${target.messages.length} messages).`;
  }

  private async send(chatId: number, messages: string[]): Promise<void> {
    for (const text of messages) await this.deps.client.sendMessage(chatId, text);
  }

  /**
   * Handle one inbound message and return the replies sent (returned for tests).
   * `/project <slug>` switches the active project; anything else is a turn.
   */
  async handleMessage(chatId: number, text: string): Promise<string[]> {
    const trimmed = text.trim();

    if (trimmed.startsWith("/project")) {
      const slug = trimmed.slice("/project".length).trim();
      const reply = slug ? `Active project set to "${slug}".` : "Usage: /project <slug>";
      if (slug) {
        this.state.activeProject = slug;
        this.persist();
        this.log.withMetadata({ chatId, project: slug }).info("active project switched");
      }
      await this.send(chatId, [reply]);
      return [reply];
    }

    if (trimmed === "/context") {
      const reply = this.contextReport();
      this.log.withMetadata({ chatId }).info("context reported");
      await this.send(chatId, [reply]);
      return [reply];
    }

    if (trimmed === "/compact") {
      const before = contextTokens(this.built.agent.state.messages);
      const beforeCount = this.built.agent.state.messages.length;
      const outcome = await this.compact(1); // threshold 1 = always attempt
      this.persist();
      // Message-count reduction is the true signal: the token estimate is
      // dominated by the fixed system prompt + tool schemas, so collapsing a few
      // short messages can leave the token total essentially unchanged.
      const reply =
        outcome.messages.length < beforeCount
          ? `Compacted: ${beforeCount} → ${outcome.messages.length} messages (~${before.toLocaleString()} → ~${outcome.tokensAfter.toLocaleString()} tokens).`
          : `Nothing to compact yet — ${beforeCount} messages (~${before.toLocaleString()} tokens). Compaction keeps the ${DEFAULT_KEEP_RECENT} most recent.`;
      this.log
        .withMetadata({ chatId, tokensBefore: before, tokensAfter: outcome.tokensAfter })
        .info("manual compaction");
      await this.send(chatId, [reply]);
      return [reply];
    }

    if (trimmed === "/new" || trimmed.startsWith("/new ")) {
      const name = trimmed.slice("/new".length).trim() || undefined;
      // Don't persist an untouched throwaway session; keep the store tidy.
      if (this.built.agent.state.messages.length > 0) this.persist();
      const fresh = newSession(name);
      // Carry the active project so memory injection still targets it — the
      // point of a fresh transcript is to check what the agent recalls from ppm.
      fresh.activeProject = this.state.activeProject;
      this.switchTo(fresh);
      this.persist();
      const reply =
        `Started a new session ${shortId(fresh.sessionId)}${name ? ` "${name}"` : ""}. ` +
        `Transcript cleared${fresh.activeProject ? `, still on "${fresh.activeProject}"` : ""}; memory is untouched.`;
      this.log.withMetadata({ chatId, sessionId: fresh.sessionId }).info("new session");
      await this.send(chatId, [reply]);
      return [reply];
    }

    if (trimmed.startsWith("/name")) {
      const name = trimmed.slice("/name".length).trim();
      const reply = name ? `Session named "${name}".` : "Usage: /name <name>";
      if (name) {
        this.state.name = name;
        this.persist();
        this.log
          .withMetadata({ chatId, sessionId: this.state.sessionId, name })
          .info("session named");
      }
      await this.send(chatId, [reply]);
      return [reply];
    }

    if (trimmed === "/session") {
      const reply = this.sessionReport();
      await this.send(chatId, [reply]);
      return [reply];
    }

    if (trimmed === "/resume" || trimmed.startsWith("/resume ")) {
      const reply = this.resume(trimmed.slice("/resume".length).trim());
      this.log.withMetadata({ chatId, sessionId: this.state.sessionId }).info("resume command");
      await this.send(chatId, [reply]);
      return [reply];
    }

    const turnLog = this.log.withContext({ chatId, project: this.state.activeProject });
    turnLog.withMetadata({ chars: text.length }).info("handling message");
    const startedAt = performance.now();

    const outbound: string[] = [];
    const unsubscribe = this.built.agent.subscribe((event) => {
      if (event.type === "tool_execution_end" && event.toolName === "ask_user") {
        const question = askUserText(event.result);
        if (question) outbound.push(question);
      }
    });
    try {
      await this.built.agent.prompt(text);
    } catch (error) {
      turnLog.withError(error).error("agent turn failed");
      throw error;
    } finally {
      unsubscribe();
    }

    const assistant = lastAssistantText(this.built.agent.state.messages);
    if (assistant) outbound.push(assistant);

    const outcome = await this.compact(this.config.compactionTokenThreshold);
    if (outcome.compacted) {
      turnLog.withMetadata({ messages: outcome.messages.length }).info("transcript compacted");
    }

    this.persist();

    if (outbound.length === 0) outbound.push("(no reply)");
    await this.send(chatId, outbound);
    turnLog
      .withMetadata({
        replies: outbound.length,
        durationMs: Math.round(performance.now() - startedAt),
      })
      .info("message handled");
    return outbound;
  }

  /** Long-poll Telegram and dispatch messages until {@link stop} is called. */
  async start(): Promise<void> {
    this.running = true;
    this.log
      .withMetadata({ allowedChatId: this.allowedChatId, activeProject: this.state.activeProject })
      .info("bot started; long-polling for updates");
    let offset = 0;
    let backoffMs = 0;
    while (this.running) {
      let updates: Awaited<ReturnType<TelegramClient["getUpdates"]>>;
      try {
        updates = await this.deps.client.getUpdates(offset, 25, this.abort.signal);
        backoffMs = 0; // healthy poll — reset the backoff
      } catch (error) {
        // `stop()` aborts the poll to shut down fast; that surfaces here as an
        // abort error — exit the loop cleanly rather than crashing the process.
        if (!this.running) break;
        // Any other failure (network blip, or a 409 conflict from an
        // overlapping poller) must back off, never tight-loop: a no-delay retry
        // pegs CPU and grows memory until the container is OOM-killed.
        backoffMs = Math.min(backoffMs === 0 ? 1_000 : backoffMs * 2, 30_000);
        this.log.withError(error).withMetadata({ backoffMs }).warn("poll failed; backing off");
        await this.sleep(backoffMs);
        continue;
      }
      for (const update of updates) {
        offset = update.updateId + 1;
        const message = update.message;
        if (!message) continue;
        if (this.allowedChatId !== undefined && message.chatId !== this.allowedChatId) {
          this.log.withMetadata({ chatId: message.chatId }).debug("ignoring disallowed chat");
          continue;
        }
        // Keep the poll loop alive: a single failed turn is logged, not fatal.
        try {
          await this.handleMessage(message.chatId, message.text);
        } catch (error) {
          this.log.withError(error).withMetadata({ chatId: message.chatId }).error("turn dropped");
        }
      }
    }
  }

  /** Sleep `ms`, resolving early if {@link stop} aborts in the meantime. */
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

  stop(): void {
    this.running = false;
    this.abort.abort();
    this.log.info("bot stopped");
  }
}
