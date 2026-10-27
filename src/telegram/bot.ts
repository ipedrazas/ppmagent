import type { BuiltAgent } from "../agent.ts";
import type { Config } from "../config.ts";
import { type Logger, nullLogger } from "../logger.ts";
import type { MetricsCollector } from "../metrics/collector.ts";
import type { ReminderStore } from "../reminder/store.ts";
import type { SessionIndex } from "../session/session-index.ts";
import type { SessionStore } from "../session/store.ts";
import type { ConfirmationStore } from "../tools/confirmation.ts";
import type { TraceRecorder } from "../trace/recorder.ts";
import type { ChatSession } from "./chat-session.ts";
import type { InboundMessage, TelegramClient } from "./client.ts";
import { CommandRouter, parseCommand } from "./command-router.ts";
import { sendReplies } from "./reply.ts";
import { TurnRunner } from "./turn-runner.ts";

export interface TelegramBotDeps {
  client: TelegramClient;
  /** Session store — the bot uses it only for the durable poll offset. */
  store: SessionStore;
  /** Session trace sink (turn/command events). Absent = no tracing. */
  recorder?: TraceRecorder;
  /** Live metrics collector for turn duration and token usage. */
  metrics?: MetricsCollector;
  /** Root logger; a `component: telegram-bot` child is derived. Defaults to discarding. */
  logger?: Logger;
  /** When set, the bot intercepts yes/no replies to drive the confirmation gate. */
  confirmationStore?: ConfirmationStore;
  /** Session index for the `/search` command. Absent = search unavailable. */
  index?: SessionIndex;
  /** When set, enables the /reminders command and reminder_* agent tools. */
  reminderStore?: ReminderStore;
}

/**
 * Single-tenant Telegram adapter: one user, one chat, one workspace.
 *
 * Each inbound message → a turn on the session's durable conversation; the reply
 * is the agent's assistant text or, on a clarify turn, the `ask_user` question.
 * The durable runtime compacts the transcript when it nears the threshold
 * (durable facts already live in `ppm`). The session metadata and transcript are
 * persisted so the agent survives restarts — including mid-turn, which the next
 * `start()` finishes; the active project is exposed to the request-context
 * injection via {@link getActiveProject}.
 */
export class TelegramBot {
  private running = false;
  /** Promise for the currently running agent turn, if any. */
  private activeTurn: Promise<void> | null = null;
  /** Aborts the in-flight long-poll so {@link stop} returns promptly. */
  private readonly abort = new AbortController();
  private readonly allowedChatId: number | undefined;
  private readonly log: Logger;
  private readonly confirmationStore?: ConfirmationStore;
  private readonly router: CommandRouter;
  private readonly turnRunner: TurnRunner;

  constructor(
    config: Config,
    private readonly built: BuiltAgent,
    /** Per-chat session state; must already be {@link ChatSession.attach}ed. */
    private readonly session: ChatSession,
    private readonly deps: TelegramBotDeps,
  ) {
    this.log = (deps.logger ?? nullLogger).child().withContext({ component: "telegram-bot" });
    // Validated at config load; `undefined` only via the explicit
    // PPMA_ALLOW_ANY_CHAT opt-out (warned about loudly in start()).
    this.allowedChatId = config.telegramAllowedChatId;
    this.confirmationStore = deps.confirmationStore;
    const send = (chatId: number, messages: string[]) => this.send(chatId, messages);
    this.router = new CommandRouter({
      session,
      config,
      send,
      abortSignal: this.abort.signal,
      confirmationStore: deps.confirmationStore,
      recorder: deps.recorder,
      index: deps.index,
      reminderStore: deps.reminderStore,
      logger: deps.logger,
    });
    this.turnRunner = new TurnRunner({
      session,
      built,
      config,
      client: deps.client,
      send,
      abortSignal: this.abort.signal,
      confirmationStore: deps.confirmationStore,
      recorder: deps.recorder,
      metrics: deps.metrics,
      logger: deps.logger,
    });
  }

  /** Active project for the current chat — read by the memory injection seam. */
  getActiveProject = (): string | undefined => this.session.activeProject;

  private async send(chatId: number, messages: string[]): Promise<void> {
    await sendReplies(this.deps.client, this.log, chatId, messages);
  }

  /**
   * Handle one inbound message: dispatch it as a slash command, or — when it is
   * not a command — run it as an agent turn. Returns the replies (for tests).
   */
  async handleMessage(chatId: number, text: string, updateId?: number): Promise<string[]> {
    const handled = await this.router.route(chatId, text);
    if (handled !== null) return handled;
    return this.turnRunner.run(chatId, text, updateId);
  }

  /**
   * Finish any turn the previous process left half-done (crash, deploy, OOM
   * kill) and deliver its reply, before taking new input. Never throws.
   */
  async recover(): Promise<void> {
    try {
      const recovered = await this.turnRunner.recoverPending(this.allowedChatId);
      if (recovered > 0) this.log.withMetadata({ recovered }).info("recovered unfinished turns");
    } catch (error) {
      this.log.withError(error).error("recovering unfinished turns failed");
    }
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
      .withMetadata({
        allowedChatId: this.allowedChatId,
        activeProject: this.session.activeProject,
      })
      .info("bot started; long-polling for updates");
    await this.recover();
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
        if (update.message) await this.dispatchMessage(update.message, update.updateId);
      }
    }
    // Drain any in-flight turn before the process exits.
    if (this.activeTurn) await this.activeTurn;
  }

  /**
   * Route one inbound message: enforce the chat allowlist, handle inline control
   * commands (e.g. `/cancel`, which must interrupt an in-flight turn without
   * waiting for it), otherwise launch the turn. A new control command is a new
   * branch here — not an edit to the poll loop in {@link start}.
   */
  private async dispatchMessage(message: InboundMessage, updateId?: number): Promise<void> {
    if (this.allowedChatId !== undefined && message.chatId !== this.allowedChatId) {
      this.log.withMetadata({ chatId: message.chatId }).debug("ignoring disallowed chat");
      return;
    }

    // Non-text messages (photos, voice notes, edits): send a helpful reply.
    if (!message.text) {
      const kind = message.nonText ?? "unknown";
      await this.send(message.chatId, [`I can only process text messages (received: ${kind}).`]);
      return;
    }

    // Handle /cancel@botname form from group chats before waiting for any active turn.
    if (parseCommand(message.text)?.cmd === "cancel") {
      await this.cancel(message.chatId);
      return;
    }

    // Single-tenant: finish any in-flight turn before starting another, else
    // interleaved turns would corrupt the transcript.
    if (this.activeTurn) {
      await this.activeTurn;
      this.activeTurn = null;
    }
    this.launchTurn(message.chatId, message.text, updateId);
  }

  /**
   * Handle `/cancel`: abort an in-flight turn (if any) and/or clear a pending
   * confirmation, then acknowledge. Runs in the poll loop so it can interrupt a
   * turn that is still processing.
   */
  private async cancel(chatId: number): Promise<void> {
    const wasCancelled = this.activeTurn !== null;
    if (wasCancelled) {
      const conversationId = this.session.conversationId;
      if (conversationId !== undefined) await this.built.runtime.abort(conversationId);
      await this.activeTurn;
      this.activeTurn = null;
    }
    const hadConfirmation = this.confirmationStore?.hasPending() ?? false;
    if (hadConfirmation) this.confirmationStore?.clear();
    const reply = wasCancelled || hadConfirmation ? "Cancelled." : "No active turn to cancel.";
    this.log.withMetadata({ chatId, wasCancelled, hadConfirmation }).info("cancel command");
    await this.deps.client.sendMessage(chatId, reply).catch(() => {});
  }

  /**
   * Launch a turn as a background task so the poll loop stays responsive (e.g.
   * to `/cancel`) while the agent works. A failed turn is logged and surfaced to
   * the user, never fatal to the loop. Tracks the turn as {@link activeTurn} and
   * clears it on completion if it is still the current one.
   */
  private launchTurn(chatId: number, text: string, updateId?: number): void {
    const turn: Promise<void> = this.handleMessage(chatId, text, updateId).then(
      () => {},
      (error) => {
        this.log.withError(error).withMetadata({ chatId }).error("turn dropped");
        const msg =
          error instanceof Error
            ? `Something went wrong: ${error.message}`
            : "Something went wrong.";
        void this.send(chatId, [msg]).catch((sendErr) => {
          this.log.withError(sendErr).error("failed to notify user of turn error");
        });
      },
    );
    this.activeTurn = turn;
    void turn.then(() => {
      if (this.activeTurn === turn) this.activeTurn = null;
    });
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
