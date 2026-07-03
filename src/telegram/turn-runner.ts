/**
 * Runs a single agent turn for one inbound message: intercepts a pending
 * confirmation reply, shows the typing indicator, drives `agent.prompt`,
 * collects the reply (assistant text or an `ask_user`/confirmation prompt),
 * compacts, persists, and sends. Extracted from {@link TelegramBot} so turn
 * orchestration is one testable unit, separate from transport and commands.
 */
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { BuiltAgent } from "../agent.ts";
import { contextTokens } from "../compaction.ts";
import type { Config } from "../config.ts";
import { type Logger, nullLogger } from "../logger.ts";
import type { MetricsCollector } from "../metrics/collector.ts";
import { type ConfirmationStore, isApproval, isRejection } from "../tools/confirmation.ts";
import type { TraceRecorder } from "../trace/recorder.ts";
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

    const outbound: string[] = [];
    const stopTyping = this.startTyping(chatId);
    const unsubscribe = this.deps.built.agent.subscribe((event) => {
      if (event.type === "tool_execution_end" && isTerminating(event.result)) {
        // Capture text from any tool that terminates the loop (ask_user, confirmation gates).
        const t = extractToolText(event.result);
        if (t) outbound.push(t);
      }
    });
    const sliceTokens = () => this.deps.built.memoryContext.sliceTokens();
    const tokensBefore = contextTokens(session.messages) + sliceTokens();
    try {
      await this.deps.built.agent.prompt(text);
    } catch (error) {
      const durationMs = Math.round(performance.now() - startedAt);
      turnLog.withError(error).error("agent turn failed");
      recorder?.record({ type: "turn_end", durationMs, error: String(error) });
      this.deps.metrics?.recordTurn({
        durationMs,
        tokensBefore,
        tokensAfter: contextTokens(session.messages) + sliceTokens(),
        error: true,
      });
      throw error;
    } finally {
      stopTyping();
      unsubscribe();
    }

    const tokensAfter = contextTokens(session.messages) + sliceTokens();
    const assistant = lastAssistantText(session.messages);
    if (assistant) outbound.push(assistant);

    const outcome = await session.compact(this.deps.config.compactionTokenThreshold);
    if (outcome.compacted) {
      turnLog.withMetadata({ messages: outcome.messages.length }).info("transcript compacted");
    }

    session.persist();

    if (outbound.length === 0) outbound.push("(no reply)");
    await this.deps.send(chatId, outbound);
    const durationMs = Math.round(performance.now() - startedAt);
    recorder?.record({ type: "turn_end", durationMs, replies: outbound.length });
    this.deps.metrics?.recordTurn({ durationMs, tokensBefore, tokensAfter });
    turnLog.withMetadata({ replies: outbound.length, durationMs }).info("message handled");
    return outbound;
  }

  /** Send a single reply and return it as the replies array. */
  private async reply(chatId: number, text: string): Promise<string[]> {
    await this.deps.send(chatId, [text]);
    return [text];
  }
}
