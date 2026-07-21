/**
 * Runs a single agent turn for one inbound message: intercepts a pending
 * confirmation reply, shows the typing indicator, drives `agent.prompt`,
 * collects the reply (assistant text or an `ask_user`/confirmation prompt),
 * compacts, persists, and sends. Extracted from {@link TelegramBot} so turn
 * orchestration is one testable unit, separate from transport and commands.
 */
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { BuiltAgent } from "../agent.ts";
import type { Config } from "../config.ts";
import { type Logger, nullLogger } from "../logger.ts";
import type { MetricsCollector } from "../metrics/collector.ts";
import { type ConfirmationStore, isApproval, isRejection } from "../tools/confirmation.ts";
import { clipPayload, type TraceRecorder } from "../trace/recorder.ts";
import type { ChatSession } from "./chat-session.ts";
import type { TelegramClient } from "./client.ts";
import type { Send } from "./reply.ts";

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
function formatToolEnd(toolName: string, result: unknown, isError: boolean): string {
  const text = extractToolText(result) || formatPayload(result);
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
  async run(chatId: number, text: string): Promise<string[]> {
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

    const outbound: string[] = [];
    // Text from any tool that terminates the loop (ask_user, confirmation gates),
    // captured separately so it can be appended after the assistant's leading
    // context text — the two are pulled from different places at different
    // times, but the context text always precedes the terminating tool call
    // within the same assistant message and must stay first in the reply.
    const terminatingReplies: string[] = [];
    const stopTyping = this.startTyping(chatId);

    // Per-turn tool budget — block and abort when the per-turn call count is exceeded.
    const prevBeforeToolCall = this.deps.built.agent.beforeToolCall;
    if (this.deps.config.turnMaxTools > 0) {
      let toolsUsed = 0;
      const limit = this.deps.config.turnMaxTools;
      this.deps.built.agent.beforeToolCall = async (ctx, signal) => {
        toolsUsed++;
        if (toolsUsed > limit) {
          this.deps.built.agent.abort();
          return {
            block: true,
            reason: `Per-turn tool budget of ${limit} call(s) exceeded.`,
          };
        }
        return prevBeforeToolCall ? prevBeforeToolCall(ctx, signal) : undefined;
      };
    }

    const unsubscribe = this.deps.built.agent.subscribe((event) => {
      if (event.type === "tool_execution_end" && isTerminating(event.result)) {
        const t = extractToolText(event.result);
        if (t) terminatingReplies.push(t);
      }
    });

    // Per-turn cost limit — abort mid-turn once the accumulated provider-reported
    // spend for this turn exceeds the threshold.
    let turnCostExceeded = false;
    let turnCostSoFar = 0;
    const unsubscribeCost =
      this.deps.config.turnMaxCostUsd > 0
        ? this.deps.built.agent.subscribe((event) => {
            if (event.type !== "turn_end") return;
            const { message } = event;
            if (!("role" in message) || message.role !== "assistant") return;
            turnCostSoFar += message.usage.cost.total;
            if (turnCostSoFar > this.deps.config.turnMaxCostUsd) {
              turnCostExceeded = true;
              turnLog
                .withMetadata({ cost: turnCostSoFar, limit: this.deps.config.turnMaxCostUsd })
                .warn("per-turn cost limit exceeded");
              this.deps.built.agent.abort();
            }
          })
        : null;

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
      ? this.deps.built.agent.subscribe((event) => {
          if (event.type === "tool_execution_start") {
            queueToolStatus(formatToolStart(event.toolName, event.args));
          } else if (event.type === "tool_execution_end") {
            queueToolStatus(formatToolEnd(event.toolName, event.result, event.isError));
          }
        })
      : null;

    const promptText = session.describeEnabled ? `${DESCRIBE_MODE_PROMPT}\n\n${text}` : text;

    try {
      await this.deps.built.agent.prompt(promptText);
    } catch (error) {
      const durationMs = Math.round(performance.now() - startedAt);
      turnLog.withError(error).error("agent turn failed");
      recorder?.record({ type: "turn_end", durationMs, error: String(error) });
      this.deps.metrics?.recordTurn({ durationMs, error: true });
      throw error;
    } finally {
      stopTyping();
      unsubscribe();
      unsubscribeCost?.();
      unsubscribeToolStatus?.();
      await toolStatusQueue;
      this.deps.built.agent.beforeToolCall = prevBeforeToolCall;
    }

    const assistant = lastAssistantText(session.messages);
    if (assistant) outbound.push(assistant);
    outbound.push(...terminatingReplies);

    if (turnCostExceeded) {
      outbound.push(
        `[Per-turn cost limit of $${this.deps.config.turnMaxCostUsd} reached. Processing stopped.]`,
      );
    }

    const outcome = await session.compact(this.deps.config.compactionTokenThreshold);
    if (outcome.compacted) {
      turnLog.withMetadata({ messages: outcome.messages.length }).info("transcript compacted");
    }

    session.persist();

    if (outbound.length === 0) outbound.push("(no reply)");
    await this.deps.send(chatId, outbound);
    const durationMs = Math.round(performance.now() - startedAt);
    recorder?.record({ type: "turn_end", durationMs, replies: outbound.length });
    this.deps.metrics?.recordTurn({ durationMs });
    turnLog.withMetadata({ replies: outbound.length, durationMs }).info("message handled");
    return outbound;
  }

  /** Send a single reply and return it as the replies array. */
  private async reply(chatId: number, text: string): Promise<string[]> {
    await this.deps.send(chatId, [text]);
    return [text];
  }
}
