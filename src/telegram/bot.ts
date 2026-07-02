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
import { execCommand } from "../exec.ts";
import { type Logger, nullLogger } from "../logger.ts";
import { type SessionState, type SessionStore, newSession, shortId } from "../session/store.ts";
import { type ConfirmationStore, isApproval, isRejection } from "../tools/confirmation.ts";
import type { TraceRecorder } from "../trace/recorder.ts";
import type { TelegramClient } from "./client.ts";
import { toMarkdownV2 } from "./mdv2.ts";

/** Full list of available slash commands, one line each. */
function helpText(): string {
  return [
    "Available commands:",
    "/project <slug> — switch active project",
    "/context — show context token usage",
    "/compact — compact the transcript",
    "/new [name] — start a fresh session",
    "/name <name> — label current session",
    "/session — show session details",
    "/tools — report CLI tool versions",
    "/resume [id|name] — list or switch sessions",
    "/cancel — cancel an in-flight turn",
    "/help — show this message",
  ].join("\n");
}

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
  /** Session trace sink (turn/command/compaction events). Absent = no tracing. */
  recorder?: TraceRecorder;
  /** Root logger; a `component: telegram-bot` child is derived. Defaults to discarding. */
  logger?: Logger;
  /** When set, the bot intercepts yes/no replies to drive the confirmation gate. */
  confirmationStore?: ConfirmationStore;
}

/** Extract the visible text from a tool result that carries content blocks. */
function extractToolText(result: unknown): string {
  const content = (result as { content?: Array<{ type?: string; text?: string }> } | undefined)
    ?.content;
  if (!Array.isArray(content)) return "";
  return content.find((c) => c?.type === "text")?.text ?? "";
}

/** True when the tool result sets terminate:true (stops the agent loop). */
function isTerminating(result: unknown): boolean {
  return (result as { terminate?: boolean } | undefined)?.terminate === true;
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
  /** Promise for the currently running agent turn, if any. */
  private activeTurn: Promise<void> | null = null;
  /** Aborts the in-flight long-poll so {@link stop} returns promptly. */
  private readonly abort = new AbortController();
  private readonly summarize: Summarizer;
  private readonly allowedChatId: number | undefined;
  private readonly log: Logger;
  private readonly confirmationStore?: ConfirmationStore;

  constructor(
    private readonly config: Config,
    private readonly built: BuiltAgent,
    private readonly deps: TelegramBotDeps,
  ) {
    this.summarize = deps.summarize ?? placeholderSummarizer;
    this.log = (deps.logger ?? nullLogger).child().withContext({ component: "telegram-bot" });
    // Validated at config load; `undefined` only via the explicit
    // PPMA_ALLOW_ANY_CHAT opt-out (warned about loudly in start()).
    this.allowedChatId = config.telegramAllowedChatId;
    this.confirmationStore = deps.confirmationStore;
    // Restore the durable session into the live agent.
    this.state = deps.store.load() ?? newSession();
    this.built.agent.state.messages = this.state.messages;
    deps.recorder?.setSession(this.state.sessionId);
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
    this.deps.recorder?.setSession(state.sessionId);
  }

  /**
   * Compact the live transcript when it crosses `threshold` tokens, flushing
   * the generated summary to memory as a durable checkpoint, and assign the
   * result back to the agent. Shared by the post-turn auto-compaction and the
   * manual `/compact` command (which forces an attempt by passing a threshold
   * of 1).
   */
  private async compact(threshold: number): Promise<CompactionOutcome> {
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
    }
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
   * The external CLIs ppmagent shells out to, paired with what each powers.
   * `/tools` reports these so an operator can confirm from the chat which tool
   * builds are deployed alongside the bot.
   */
  private toolSpecs(): Array<{ bin: string; role: string }> {
    return [
      { bin: this.config.ppmBin, role: "memory" },
      { bin: this.config.dbxcliBin, role: "tracker" },
      { bin: this.config.proteosBin, role: "ProteOS task lane" },
    ];
  }

  /**
   * Query each external CLI's `--version` and report it. A tool that fails to
   * spawn (not on PATH) or exits non-zero is reported as unavailable rather than
   * failing the whole command, so `/tools` always answers. Version formats differ
   * per CLI, so the raw output is passed through (multi-line collapsed to one).
   */
  private async toolsReport(): Promise<string> {
    const lines = await Promise.all(
      this.toolSpecs().map(async ({ bin, role }) => {
        try {
          const result = await execCommand(bin, ["--version"], {
            signal: this.abort.signal,
            logger: this.log,
          });
          if (result.exitCode !== 0) {
            return `• ${bin} (${role}) — unavailable (exit ${result.exitCode})`;
          }
          const version =
            [result.stdout, result.stderr]
              .join("\n")
              .split("\n")
              .map((l) => l.trim())
              .filter(Boolean)
              .join(" · ") || "(no version output)";
          return `• ${version} — ${role}`;
        } catch {
          return `• ${bin} (${role}) — not installed`;
        }
      }),
    );
    return `ppmagent tools:\n${lines.join("\n")}`;
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
    for (const text of messages) {
      const formatted = toMarkdownV2(text);
      try {
        await this.deps.client.sendMessage(chatId, formatted, "MarkdownV2");
      } catch {
        // MarkdownV2 was rejected by Telegram (e.g. malformed entity) — retry
        // as plain text so the message is never silently dropped.
        this.log.withMetadata({ chatId }).warn("MarkdownV2 send failed; retrying as plain text");
        await this.deps.client.sendMessage(chatId, text);
      }
    }
  }

  /**
   * Handle one inbound message and return the replies sent (returned for tests).
   * `/project <slug>` switches the active project; anything else is a turn.
   */
  async handleMessage(chatId: number, text: string): Promise<string[]> {
    const trimmed = text.trim();

    // Trace every slash command uniformly (name + arg); turns are traced below.
    if (trimmed.startsWith("/")) {
      const [command = "", ...rest] = trimmed.split(/\s+/);
      this.deps.recorder?.record({ type: "command", command, arg: rest.join(" ") || undefined });
    }

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

    if (trimmed === "/tools") {
      const reply = await this.toolsReport();
      this.log.withMetadata({ chatId }).info("tools reported");
      await this.send(chatId, [reply]);
      return [reply];
    }

    if (trimmed === "/resume" || trimmed.startsWith("/resume ")) {
      const reply = this.resume(trimmed.slice("/resume".length).trim());
      this.log.withMetadata({ chatId, sessionId: this.state.sessionId }).info("resume command");
      await this.send(chatId, [reply]);
      return [reply];
    }

    if (trimmed === "/cancel") {
      // When called from the poll loop while a turn is active, the poll loop
      // aborts the agent before routing here. This branch handles the direct
      // call case (no turn in flight) — we still clear any pending confirmation.
      const hadConfirmation = this.confirmationStore?.hasPending() ?? false;
      if (hadConfirmation) this.confirmationStore?.clear();
      const reply = hadConfirmation ? "Cancelled." : "No active turn to cancel.";
      await this.send(chatId, [reply]);
      return [reply];
    }

    if (trimmed === "/help") {
      const reply = helpText();
      await this.send(chatId, [reply]);
      return [reply];
    }

    const turnLog = this.log.withContext({ chatId, project: this.state.activeProject });
    turnLog.withMetadata({ chars: text.length }).info("handling message");
    const startedAt = performance.now();
    this.deps.recorder?.record({
      type: "turn_start",
      chatId,
      chars: text.length,
      project: this.state.activeProject,
    });

    // Confirmation gate: intercept yes/no replies before starting a new agent turn.
    const pending = this.confirmationStore?.get();
    if (pending) {
      if (this.confirmationStore?.isExpired()) {
        this.confirmationStore.clear();
        const reply = "Confirmation timed out — the operation was cancelled.";
        await this.send(chatId, [reply]);
        return [reply];
      }
      if (isApproval(trimmed)) {
        const sendTyping = (): void => {
          void this.deps.client.sendChatAction(chatId, "typing").catch(() => {});
        };
        sendTyping();
        const typingInterval = setInterval(sendTyping, 4500);
        try {
          const result = await pending.execute(this.abort.signal);
          this.confirmationStore?.clear();
          await this.send(chatId, [result]);
          return [result];
        } catch (error) {
          this.confirmationStore?.clear();
          const errorMsg = `Operation failed: ${error instanceof Error ? error.message : String(error)}`;
          await this.send(chatId, [errorMsg]);
          return [errorMsg];
        } finally {
          clearInterval(typingInterval);
        }
      }
      if (isRejection(trimmed)) {
        this.confirmationStore?.clear();
        const reply = "Cancelled.";
        await this.send(chatId, [reply]);
        return [reply];
      }
      // Not a yes/no — block: show the pending confirmation and wait.
      const modal = `Pending confirmation:\n${pending.description}\n\nReply yes to confirm or no to cancel.`;
      await this.send(chatId, [modal]);
      return [modal];
    }

    const outbound: string[] = [];

    // Show a typing indicator and refresh every 4.5 s (Telegram expires it after 5 s).
    const sendTyping = (): void => {
      void this.deps.client.sendChatAction(chatId, "typing").catch(() => {});
    };
    sendTyping();
    const typingInterval = setInterval(sendTyping, 4500);

    const unsubscribe = this.built.agent.subscribe((event) => {
      if (event.type === "tool_execution_end" && isTerminating(event.result)) {
        // Capture text from any tool that terminates the loop (ask_user, confirmation gates).
        const t = extractToolText(event.result);
        if (t) outbound.push(t);
      }
    });
    try {
      await this.built.agent.prompt(text);
    } catch (error) {
      turnLog.withError(error).error("agent turn failed");
      this.deps.recorder?.record({
        type: "turn_end",
        durationMs: Math.round(performance.now() - startedAt),
        error: String(error),
      });
      throw error;
    } finally {
      clearInterval(typingInterval);
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
    const durationMs = Math.round(performance.now() - startedAt);
    this.deps.recorder?.record({ type: "turn_end", durationMs, replies: outbound.length });
    turnLog.withMetadata({ replies: outbound.length, durationMs }).info("message handled");
    return outbound;
  }

  /** Long-poll Telegram and dispatch messages until {@link stop} is called. */
  async start(): Promise<void> {
    this.running = true;
    if (this.allowedChatId === undefined) {
      this.log.warn(
        "bot is OPEN TO ALL CHATS (PPMA_ALLOW_ANY_CHAT) — anyone who finds the handle can drive it",
      );
    }
    this.log
      .withMetadata({ allowedChatId: this.allowedChatId, activeProject: this.state.activeProject })
      .info("bot started; long-polling for updates");
    let offset = this.deps.store.loadOffset();
    let backoffMs = 0;
    while (this.running) {
      let updates: Awaited<ReturnType<TelegramClient["getUpdates"]>>;
      try {
        // Short-poll while a turn is running so /cancel is noticed within ~1 s.
        const pollTimeout = this.activeTurn ? 1 : 25;
        updates = await this.deps.client.getUpdates(offset, pollTimeout, this.abort.signal);
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
        this.deps.store.saveOffset(offset);
        const message = update.message;
        if (!message) continue;
        if (this.allowedChatId !== undefined && message.chatId !== this.allowedChatId) {
          this.log.withMetadata({ chatId: message.chatId }).debug("ignoring disallowed chat");
          continue;
        }

        // /cancel: abort the active turn (if any) and/or clear any pending
        // confirmation — handled here in the poll loop so it can interrupt an
        // in-flight turn without waiting for it to finish first.
        if (message.text.trim() === "/cancel") {
          const wasCancelled = this.activeTurn !== null;
          if (wasCancelled) {
            this.built.agent.abort();
            await this.activeTurn;
            this.activeTurn = null;
          }
          const hadConfirmation = this.confirmationStore?.hasPending() ?? false;
          if (hadConfirmation) this.confirmationStore?.clear();
          const reply =
            wasCancelled || hadConfirmation ? "Cancelled." : "No active turn to cancel.";
          this.log
            .withMetadata({ chatId: message.chatId, wasCancelled, hadConfirmation })
            .info("cancel command");
          await this.deps.client.sendMessage(message.chatId, reply).catch(() => {});
          continue;
        }

        // If a turn is in flight, wait for it before starting another — the bot
        // is single-tenant so interleaving turns would corrupt the transcript.
        if (this.activeTurn) {
          await this.activeTurn;
          this.activeTurn = null;
        }

        // Launch the turn as a background task so the poll loop remains
        // responsive (e.g. to /cancel) while the agent is processing. A single
        // failed turn is logged and surfaced to the user, never fatal to the loop.
        const turn: Promise<void> = this.handleMessage(message.chatId, message.text).then(
          () => {},
          (error) => {
            this.log
              .withError(error)
              .withMetadata({ chatId: message.chatId })
              .error("turn dropped");
            const msg =
              error instanceof Error
                ? `Something went wrong: ${error.message}`
                : "Something went wrong.";
            void this.send(message.chatId, [msg]).catch((sendErr) => {
              this.log.withError(sendErr).error("failed to notify user of turn error");
            });
          },
        );
        this.activeTurn = turn;
        void turn.then(() => {
          if (this.activeTurn === turn) this.activeTurn = null;
        });
      }
    }
    // Drain any in-flight turn before the process exits.
    if (this.activeTurn) await this.activeTurn;
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
