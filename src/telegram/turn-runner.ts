/**
 * Runs a single agent turn for one inbound message: intercepts a pending
 * confirmation reply, shows the typing indicator, submits the message to the
 * session's durable conversation, collects the reply (assistant text or an
 * `ask_user`/confirmation prompt), persists, and sends. Extracted from
 * {@link TelegramBot} so turn orchestration is one testable unit, separate from
 * transport and commands.
 *
 * Turns are durable: the input is committed under a request id before the model
 * is called, so a crash mid-turn is finished by {@link TurnRunner.recoverPending}
 * on the next start, and a redelivered update joins the admitted turn instead of
 * running twice.
 */
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import type { BuiltAgent } from "../agent.ts";
import type { Config } from "../config.ts";
import { type Logger, nullLogger } from "../logger.ts";
import type { MetricsCollector } from "../metrics/collector.ts";
import { messageText, type PendingTurn, type TurnOutcome } from "../runtime/runtime.ts";
import { type ConfirmationStore, isApproval, isRejection } from "../tools/confirmation.ts";
import { clipPayload, type TraceRecorder } from "../trace/recorder.ts";
import type { ChatSession } from "./chat-session.ts";
import type { TelegramClient } from "./client.ts";
import type { Send } from "./reply.ts";

/** Render a tool call's args/result as a fenced JSON block, clipped to a safe size. */
function formatPayload(value: unknown): string {
  try {
    return JSON.stringify(clipPayload(value), null, 2);
  } catch {
    return String(value);
  }
}

/** Format a `tool_execution_start` event as a Telegram status message. */
function formatToolStart(toolName: string, args: unknown): string {
  return `🔧 Calling \`${toolName}\`\n\`\`\`json\n${formatPayload(args)}\n\`\`\``;
}

/** Format a `tool_execution_end` event as a Telegram status message. */
function formatToolEnd(toolName: string, text: string, isError: boolean): string {
  const icon = isError ? "❌" : "✅";
  return `${icon} \`${toolName}\` ${isError ? "failed" : "done"}\n\`\`\`\n${text}\n\`\`\``;
}

/**
 * Prepended to the user message when `/describe` mode is on: asks the agent to
 * narrate its tool-calling decisions rather than just making them silently.
 */
const DESCRIBE_MODE_PROMPT =
  "You are in describe mode. Before each tool call, explain why you are calling " +
  "that tool, what you expect to get from it, and after receiving the response, " +
  "explain what you learned and how it affects your next decision.";

export interface TurnRunnerDeps {
  session: ChatSession;
  built: BuiltAgent;
  config: Config;
  client: TelegramClient;
  send: Send;
  /** Aborts long-running work (confirmation execution) on shutdown. */
  abortSignal: AbortSignal;
  /** When set, the runner drives the confirmation gate on yes/no replies. */
  confirmationStore?: ConfirmationStore;
  recorder?: TraceRecorder;
  /** Live metrics collector for turn duration and token usage. */
  metrics?: MetricsCollector;
  logger?: Logger;
}

export class TurnRunner {
  private readonly log: Logger;

  constructor(private readonly deps: TurnRunnerDeps) {
    this.log = (deps.logger ?? nullLogger).child().withContext({ component: "telegram-bot" });
  }

  /** Refresh the Telegram "typing…" indicator until the returned stop() is called. */
  private startTyping(chatId: number): () => void {
    const tick = (): void => {
      void this.deps.client.sendChatAction(chatId, "typing").catch(() => {});
    };
    tick();
    const interval = setInterval(tick, 4500);
    return () => clearInterval(interval);
  }

  /**
   * Handle one inbound message as an agent turn (or as a reply to a pending
   * confirmation). Returns the replies sent.
   */
  async run(chatId: number, text: string, updateId?: number): Promise<string[]> {
    const { session, confirmationStore, recorder } = this.deps;
    const trimmed = text.trim();
    const turnLog = this.log.withContext({ chatId, project: session.activeProject });
    turnLog.withMetadata({ chars: text.length }).info("handling message");
    const startedAt = performance.now();
    recorder?.record({
      type: "turn_start",
      chatId,
      chars: text.length,
      project: session.activeProject,
    });

    // Confirmation gate: intercept yes/no replies before starting a new agent turn.
    const pending = confirmationStore?.get();
    if (pending) {
      if (confirmationStore?.isExpired()) {
        confirmationStore.clear();
        return this.reply(chatId, "Confirmation timed out — the operation was cancelled.");
      }
      if (isApproval(trimmed)) {
        const stopTyping = this.startTyping(chatId);
        try {
          const result = await pending.execute(this.deps.abortSignal);
          confirmationStore?.clear();
          return this.reply(chatId, result);
        } catch (error) {
          confirmationStore?.clear();
          const msg = `Operation failed: ${error instanceof Error ? error.message : String(error)}`;
          return this.reply(chatId, msg);
        } finally {
          stopTyping();
        }
      }
      if (isRejection(trimmed)) {
        confirmationStore?.clear();
        return this.reply(chatId, "Cancelled.");
      }
      // Not a yes/no — block: show the pending confirmation and wait.
      return this.reply(
        chatId,
        `Pending confirmation:\n${pending.description}\n\nReply yes to confirm or no to cancel.`,
      );
    }

    // Session cost limit — refuse the turn if the accumulated spend is already over budget.
    if (this.deps.config.sessionMaxCostUsd > 0 && this.deps.metrics) {
      const spent = this.deps.metrics.sessionCostUsd();
      if (spent >= this.deps.config.sessionMaxCostUsd) {
        turnLog
          .withMetadata({ spent, limit: this.deps.config.sessionMaxCostUsd })
          .warn("session cost limit reached");
        return this.reply(
          chatId,
          `Session cost limit of $${this.deps.config.sessionMaxCostUsd} reached` +
            ` (spent ~$${spent.toFixed(4)}). Start a /new session to continue.`,
        );
      }
    }

    const conversationId = await session.ensureConversation();
    const { runtime } = this.deps.built;
    const stopTyping = this.startTyping(chatId);

    // Per-turn limits (tool budget, provider-reported spend) — enforced inside the
    // runtime's generation/tool hooks, so a trip blocks the next call rather than
    // racing the event stream. Either trip aborts the turn.
    const guard = runtime.guardTurn(conversationId, {
      maxTools: this.deps.config.turnMaxTools,
      maxCostUsd: this.deps.config.turnMaxCostUsd,
    });

    // Tool-calling status — send an incremental Telegram message for each tool
    // call and its result as the turn progresses. Sends are queued (not
    // awaited inline) so a slow Telegram API call never delays the tool
    // itself; the queue preserves message order and is drained before the
    // turn's final reply is sent.
    let toolStatusQueue = Promise.resolve();
    const queueToolStatus = (msg: string): void => {
      toolStatusQueue = toolStatusQueue
        .then(() => this.deps.send(chatId, [msg]))
        .catch((error) => {
          turnLog.withError(error).warn("failed to send tool-status message");
        });
    };
    const unsubscribeToolStatus = this.deps.config.showToolCalls
      ? runtime.subscribe(conversationId, (event) => {
          if (event.type === "tool_execution_start") {
            if (event.parentToolCallId) return;
            queueToolStatus(formatToolStart(event.toolName, event.args));
          } else if (event.type === "tool_execution_end") {
            if (event.parentToolCallId) return;
            const result = event.entry?.model?.[0] as ToolResultMessage | undefined;
            queueToolStatus(
              formatToolEnd(
                event.toolName,
                messageText(result) || "(no output)",
                result?.isError ?? true,
              ),
            );
          }
        })
      : null;

    const promptText = session.describeEnabled ? `${DESCRIBE_MODE_PROMPT}\n\n${text}` : text;
    const requestId = `tg:${chatId}:${updateId ?? crypto.randomUUID()}`;

    let outcome: TurnOutcome;
    try {
      outcome = await runtime.runTurn(conversationId, promptText, { requestId });
    } catch (error) {
      const durationMs = Math.round(performance.now() - startedAt);
      turnLog.withError(error).error("agent turn failed");
      recorder?.record({ type: "turn_end", durationMs, error: String(error) });
      this.deps.metrics?.recordTurn({ durationMs, error: true });
      throw error;
    } finally {
      stopTyping();
      unsubscribeToolStatus?.();
      guard.release();
      await toolStatusQueue;
    }

    const outbound = this.repliesFor(outcome, turnLog);
    if (guard.exceeded === "cost") {
      turnLog
        .withMetadata({ cost: guard.costUsd, limit: this.deps.config.turnMaxCostUsd })
        .warn("per-turn cost limit exceeded");
      outbound.push(
        `[Per-turn cost limit of $${this.deps.config.turnMaxCostUsd} reached. Processing stopped.]`,
      );
    }

    await session.refreshMessageCount();
    session.persist();

    if (outbound.length === 0) {
      outbound.push(this.emptyReply(outcome, turnLog));
    }
    await this.deps.send(chatId, outbound);
    const durationMs = Math.round(performance.now() - startedAt);
    recorder?.record({
      type: "turn_end",
      durationMs,
      replies: outbound.length,
      ...(outcome.modelError ? { modelError: outcome.modelError } : {}),
    });
    this.deps.metrics?.recordTurn({ durationMs });
    turnLog.withMetadata({ replies: outbound.length, durationMs }).info("message handled");
    return outbound;
  }

  /**
   * The assistant's text followed by any terminating tool's reply (ask_user,
   * confirmation gates). The assistant's leading context always precedes the
   * terminating tool call within the same message and must stay first.
   */
  private repliesFor(outcome: TurnOutcome, _log: Logger): string[] {
    const replies: string[] = [];
    if (outcome.assistantText) replies.push(outcome.assistantText);
    replies.push(...outcome.terminatingReplies);
    return replies;
  }

  /**
   * Reply for a turn that produced nothing. The provider's cause is surfaced —
   * a failed run is committed with empty text and the real cause in the
   * submission's `detail`; without it the turn would read "(no reply)" for a bad
   * model id, a rejected API key and a provider outage alike.
   */
  private emptyReply(outcome: TurnOutcome, log: Logger): string {
    const { model } = this.deps.built;
    if (outcome.modelError) {
      log
        .withMetadata({ model: model.id, provider: model.provider })
        .error(`model call failed: ${outcome.modelError}`);
      return (
        `⚠️ The model call failed, so there is no answer to send.\n\n` +
        `\`${outcome.modelError}\`\n\n` +
        `Model: \`${model.provider}/${model.id}\``
      );
    }
    log.withMetadata({ reason: outcome.reason }).warn("turn produced no reply and no model error");
    return "(no reply)";
  }

  /**
   * Finish turns the previous process left unfinished (crash, deploy, OOM kill).
   * The durable runtime has already resumed the underlying work when it was
   * opened; this waits for each turn to settle and delivers its reply, which the
   * dead process never got to send. Replies go to the chat encoded in the turn's
   * request id, else to `fallbackChatId`.
   */
  async recoverPending(fallbackChatId?: number): Promise<number> {
    const { runtime } = this.deps.built;
    const pending = await runtime.pendingTurns();
    for (const turn of pending) {
      await this.recoverOne(turn, fallbackChatId);
    }
    return pending.length;
  }

  private async recoverOne(turn: PendingTurn, fallbackChatId?: number): Promise<void> {
    const encoded = turn.requestId?.match(/^tg:(-?\d+):/)?.[1];
    const chatId = encoded !== undefined ? Number(encoded) : fallbackChatId;
    const turnLog = this.log.withContext({ chatId, requestId: turn.requestId });
    turnLog.info("recovering unfinished turn");
    this.deps.built.observe(turn.conversationId);
    try {
      const outcome = await this.deps.built.runtime.awaitTurn(turn);
      const replies = this.repliesFor(outcome, turnLog);
      if (replies.length === 0) replies.push(this.emptyReply(outcome, turnLog));
      if (chatId !== undefined) {
        await this.deps.send(chatId, [
          "↩️ Recovered a turn that was interrupted by a restart:",
          ...replies,
        ]);
      }
      await this.deps.session.refreshMessageCount();
      this.deps.session.persist();
      turnLog.withMetadata({ replies: replies.length }).info("recovered turn delivered");
    } catch (error) {
      turnLog.withError(error).error("failed to recover unfinished turn");
    }
  }

  /** Send a single reply and return it as the replies array. */
  private async reply(chatId: number, text: string): Promise<string[]> {
    await this.deps.send(chatId, [text]);
    return [text];
  }
}
