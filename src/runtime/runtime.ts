import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import {
  type AssistantMessage,
  calculateCost,
  type Message,
  type Model,
  type Models,
  type ToolResultMessage,
} from "@earendil-works/pi-ai";
import { estimateContextTokens } from "@earendil-works/pi-ai/utils/estimate";
import {
  type AgentEvent,
  type Conversation,
  createRegistry,
  defineExtension,
  GenerationTask,
  Harness,
  hook,
  MemoryStorage,
  type Storage,
  type SubmissionRecord,
  section,
  ToolTask,
  watchEvents,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { type Logger, nullLogger } from "../logger.ts";
import type { AppTool } from "../tool-helpers.ts";
import { readToolDetails, toDurableTool } from "./tools.ts";

/**
 * The durable agent runtime: a pi-durable {@link Harness} over a SQLite file,
 * with one durable *conversation* per ppmagent session.
 *
 * Everything that matters is committed to the database before it is acted on —
 * the user's input, each model response, each tool call and result — so when the
 * process dies mid-turn, reopening the same file and calling `resume()` (done in
 * {@link DurableRuntime.open}) continues the turn from its last checkpoint
 * instead of losing it. Submissions carry a `requestId`, so a redelivered
 * Telegram update attaches to the already-admitted turn rather than running it
 * twice.
 */

/** Conversation handle id as stored in the session file. */
export type ConversationKey = number;

export interface RuntimeOptions {
  /** SQLite file for the durable store; omit for an in-memory (non-durable) store. */
  dbFile?: string;
  /** Test seam: supply storage directly (e.g. a shared one to simulate a restart). */
  storage?: Storage;
  models: Models;
  /** The model every conversation runs on. */
  model: Model<any>;
  /** Rendered into the system prompt on every request (so deploys update old conversations). */
  systemPrompt: string;
  tools: readonly AppTool[];
  /** Tools whose interrupted execution must NOT be re-run on recovery. */
  mutatingTools?: ReadonlySet<string>;
  /**
   * Request-scoped context rewrite (ppm memory injection). The returned messages
   * are sent to the model for that one request only; they are never stored.
   */
  transformRequest?: (
    messages: readonly Message[],
    signal?: AbortSignal,
  ) => Promise<readonly Message[]>;
  /** Token count at which automatic compaction kicks in; 0 = {@link DEFAULT_COMPACTION_THRESHOLD}. */
  compactionThreshold?: number;
  /** Recent context a compaction keeps verbatim, in tokens. Defaults to durable's (20k). */
  keepRecentTokens?: number;
  /**
   * Start scheduling unfinished work as soon as the store opens (default). Set
   * `false` to inspect what a crash left behind first, then call
   * {@link DurableRuntime.resume}.
   */
  resume?: boolean;
  /** Provider call retries inside durable's generation task. Defaults to durable's. */
  retry?: { maxRetries?: number; baseDelayMs?: number };
  logger?: Logger;
}

export const DEFAULT_COMPACTION_THRESHOLD = 120_000;

/** Concatenate the text blocks of a message's content. */
export function messageText(message: Message | undefined): string {
  if (!message || !Array.isArray(message.content)) {
    return typeof message?.content === "string" ? message.content : "";
  }
  return (message.content as { type: string; text?: string }[])
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("");
}

/** What one settled turn produced, derived from the committed transcript. */
export interface TurnOutcome {
  status: "done" | "unanswered";
  /** Why the turn was not answered (`model_error`, `aborted`, ...). */
  reason?: string;
  /** The failed model call's cause, when `reason` is `model_error`. */
  modelError?: string;
  /** Text of the turn's last assistant message. */
  assistantText: string;
  /** Texts of tool results that ended the run (ask_user, confirmation gates), in order. */
  terminatingReplies: string[];
  /** Provider-reported spend across the turn's assistant messages. */
  costUsd: number;
  /** Messages the turn appended (after the user input). */
  messages: Message[];
}

/** A turn that was admitted but not settled when the process last stopped. */
export interface PendingTurn {
  conversationId: ConversationKey;
  submissionId: number;
  requestId?: string;
}

export type RuntimeEventListener = (event: AgentEvent) => void;

/** Context-window tokens at which `contextWindow - reserveTokens` equals `threshold`. */
export function reserveTokensFor(model: Model<any>, threshold: number): number {
  const wanted = threshold > 0 ? threshold : DEFAULT_COMPACTION_THRESHOLD;
  const window = model.contextWindow > 0 ? model.contextWindow : DEFAULT_COMPACTION_THRESHOLD * 2;
  // Never let the reserve collapse to nothing (the answer needs room) nor exceed the window.
  return Math.max(2_048, Math.min(window - wanted, window - 2_048));
}

/**
 * Dollar cost of one assistant message: what the provider reported, or — when
 * the provider reports none (some OpenAI-compatible endpoints omit it) — the
 * catalog price times the reported tokens. Unknown models cost nothing.
 */
function spendOf(message: AssistantMessage, models: Models): number {
  const reported = message.usage?.cost?.total ?? 0;
  if (reported > 0 || !message.usage) return reported;
  const model = models.getModel(message.provider, message.model);
  return model ? calculateCost(model, message.usage).total : 0;
}

function isAssistant(message: Message): message is AssistantMessage {
  return message.role === "assistant";
}

export class DurableRuntime {
  private readonly listeners = new Map<ConversationKey, Set<RuntimeEventListener>>();
  private readonly observers = new Map<ConversationKey, Promise<void>>();
  private closing = false;

  private constructor(
    readonly harness: Harness,
    readonly options: RuntimeOptions,
    private readonly log: Logger,
    /** Per-turn limits consulted by the generation and tool hooks. */
    private readonly guards: Map<ConversationKey, TurnGuard>,
  ) {}

  /** Open (or reopen) the durable store and resume any unfinished work in it. */
  static async open(options: RuntimeOptions): Promise<DurableRuntime> {
    const log = (options.logger ?? nullLogger).child().withContext({ component: "runtime" });
    const guards = new Map<ConversationKey, TurnGuard>();
    const mutating = options.mutatingTools ?? new Set<string>();

    const extension = defineExtension({
      name: "ppmagent",
      tools: options.tools.map((t) => toDurableTool(t, mutating.has(t.name))),
      sections: [section("system", () => options.systemPrompt, { tag: false })],
      hooks: [
        hook(GenerationTask, {
          // Runs inside the generation task, before its tool round — so a cost
          // overrun is known before any further tool or model call can start.
          afterResponse: (message, api) => {
            const guard = guards.get(api.conversationId as ConversationKey);
            if (!guard || guard.maxCostUsd <= 0) return;
            guard.costUsd += spendOf(message, api.models);
            if (guard.costUsd > guard.maxCostUsd) guard.trip("cost");
          },
          beforeRequest: async (request, _api, context) => {
            if (!options.transformRequest) return undefined;
            return {
              messages: await options.transformRequest(request.messages, context.abortSignal),
            };
          },
        }),
        hook(ToolTask, {
          beforeTool: (call, api) => {
            const guard = guards.get(api.conversationId as ConversationKey);
            if (!guard || call.parent) return undefined;
            guard.toolsUsed++;
            if (guard.exceeded === "cost") {
              return { block: `Per-turn cost limit of $${guard.maxCostUsd} exceeded.` };
            }
            if (guard.maxTools > 0 && guard.toolsUsed > guard.maxTools) {
              guard.trip("tools");
              return { block: `Per-turn tool budget of ${guard.maxTools} call(s) exceeded.` };
            }
            return undefined;
          },
        }),
      ],
    });
    const registry = createRegistry();
    registry.install(extension);

    let storage = options.storage;
    if (!storage) {
      if (options.dbFile) {
        mkdirSync(dirname(options.dbFile), { recursive: true });
        storage = await openNodeSqliteStorage(options.dbFile);
      } else {
        storage = new MemoryStorage();
      }
    }

    const harness = await Harness.open(
      storage,
      {
        models: options.models,
        registry,
        identity: { attribution: null },
        settings: {
          extensions: [extension],
          retry: options.retry,
          compaction: {
            enabled: true,
            reserveTokens: reserveTokensFor(options.model, options.compactionThreshold ?? 0),
            backgroundTokens: 0,
            ...(options.keepRecentTokens !== undefined
              ? { keepRecentTokens: options.keepRecentTokens }
              : {}),
          },
        },
        onReport: (error, info) => {
          log
            .withError(error)
            .withMetadata({ type: info.type })
            .warn("durable runtime reported a problem");
        },
      },
      BACKGROUND_CONTEXT,
    );
    harness.closed.then((end) => {
      if (end.reason === "failed")
        log.withError(end.error).error("durable store closed on failure");
    });
    const runtime = new DurableRuntime(harness, options, log, guards);
    // Continue whatever the previous process left unfinished.
    if (options.resume !== false) runtime.resume();
    return runtime;
  }

  /** Start scheduling: unfinished turns, tool calls and compactions continue from their checkpoints. */
  resume(): void {
    this.harness.resume();
  }

  // ── Conversations ──

  /** Create a fresh durable conversation (one per ppmagent session). */
  async createConversation(): Promise<ConversationKey> {
    const conversation = await this.harness.createConversation(
      {
        ownership: { kind: "ownerless" },
        agent: {
          model: { provider: this.options.model.provider, modelId: this.options.model.id },
        },
      },
      BACKGROUND_CONTEXT,
    );
    return conversation.id as ConversationKey;
  }

  private async conversation(id: ConversationKey): Promise<Conversation> {
    const conversation = await this.harness.conversation(id as never, BACKGROUND_CONTEXT);
    if (!conversation) throw new Error(`durable conversation ${id} not found`);
    return conversation;
  }

  /** True when the store still has this conversation (it may not after a store reset). */
  async hasConversation(id: ConversationKey): Promise<boolean> {
    return (await this.harness.conversation(id as never, BACKGROUND_CONTEXT)) !== undefined;
  }

  // ── Turns ──

  /**
   * Admit `text` as user input and wait for the run to settle. `requestId` makes
   * this idempotent: submitting the same id again — after a crash, or a
   * redelivered Telegram update — joins the existing turn.
   */
  async runTurn(
    id: ConversationKey,
    text: string,
    opts: { requestId?: string; signal?: AbortSignal } = {},
  ): Promise<TurnOutcome> {
    const conversation = await this.conversation(id);
    const context = opts.signal
      ? withAbortSignal(opts.signal, BACKGROUND_CONTEXT)
      : BACKGROUND_CONTEXT;
    const submission = await conversation.submit(
      { type: "input", content: text, requestId: opts.requestId },
      context,
    );
    const settled = await submission.wait(context);
    return this.outcomeOf(id, settled);
  }

  /** Wait for an already-admitted turn (recovery after a restart) and read its outcome. */
  async awaitTurn(pending: PendingTurn): Promise<TurnOutcome> {
    const submission = await this.harness.submission(
      pending.submissionId as never,
      BACKGROUND_CONTEXT,
    );
    if (!submission) throw new Error(`submission ${pending.submissionId} not found`);
    const settled = await submission.wait(BACKGROUND_CONTEXT);
    return this.outcomeOf(pending.conversationId, settled);
  }

  /** Input turns that were admitted but never settled — what a restart must finish. */
  async pendingTurns(): Promise<PendingTurn[]> {
    const inspection = await this.harness.inspect(BACKGROUND_CONTEXT);
    return inspection.submissions
      .filter((s) => s.type === "input" && (s.status === "queued" || s.status === "placed"))
      .map((s: SubmissionRecord) => ({
        conversationId: s.conversationId as ConversationKey,
        submissionId: s.id as number,
        requestId: s.requestId,
      }));
  }

  private async outcomeOf(id: ConversationKey, settled: SubmissionRecord): Promise<TurnOutcome> {
    const view = await (await this.conversation(id)).context(BACKGROUND_CONTEXT);
    const inputEntry = settled.entry as number | undefined;
    const messages: Message[] = [];
    for (let i = 0; i < view.entries.length; i++) {
      const entry = view.entries[i];
      if (!entry || inputEntry === undefined || (entry.id as number) <= inputEntry) continue;
      for (const m of entry.model ?? []) {
        if (m.role !== "system") messages.push(m);
      }
    }
    const lastAssistant = [...messages].reverse().find(isAssistant);
    const lastAssistantIdx = lastAssistant ? messages.lastIndexOf(lastAssistant) : -1;
    // Tool results after the last assistant message belong to a round that ended the run.
    const terminatingReplies = messages
      .slice(lastAssistantIdx + 1)
      .filter((m): m is ToolResultMessage => m.role === "toolResult")
      .filter((m) => readToolDetails(m.details)?.terminate === true)
      .map((m) => messageText(m))
      .filter((t) => t.length > 0);
    const costUsd = messages
      .filter(isAssistant)
      .reduce((sum, m) => sum + spendOf(m, this.options.models), 0);
    return {
      status: settled.status === "done" ? "done" : "unanswered",
      reason: settled.status === "unanswered" ? settled.reason : undefined,
      modelError:
        settled.status === "unanswered" && settled.reason === "model_error"
          ? String(settled.detail ?? "model call failed")
          : undefined,
      assistantText: lastAssistant ? messageText(lastAssistant) : "",
      terminatingReplies,
      costUsd,
      messages,
    };
  }

  /**
   * Withdraw queued input and abort the running turn. Everything already
   * committed stays; the next input starts from that transcript.
   */
  async abort(id: ConversationKey): Promise<void> {
    await (await this.conversation(id)).abort(BACKGROUND_CONTEXT);
  }

  /**
   * Install per-turn limits for `id` (tool calls, provider-reported spend). When
   * one trips, further tool calls are blocked and the turn is aborted. Release
   * the returned guard when the turn ends.
   */
  guardTurn(id: ConversationKey, limits: { maxTools: number; maxCostUsd: number }): TurnGuard {
    const guard: TurnGuard = {
      ...limits,
      toolsUsed: 0,
      costUsd: 0,
      exceeded: undefined,
      trip: (reason) => {
        if (guard.exceeded) return;
        guard.exceeded = reason;
        void this.abort(id).catch((error) => {
          this.log.withError(error).warn("aborting after turn limit exceeded failed");
        });
      },
      release: () => {
        if (this.guards.get(id) === guard) this.guards.delete(id);
      },
    };
    this.guards.set(id, guard);
    return guard;
  }

  // ── Transcript ──

  /** The model context for the next request: stored messages (system prompt excluded). */
  async messages(id: ConversationKey): Promise<Message[]> {
    const view = await (await this.conversation(id)).context(BACKGROUND_CONTEXT);
    return view.messages.filter((m) => m.role !== "system");
  }

  /** Estimated tokens of the stored context. */
  async contextTokens(id: ConversationKey): Promise<number> {
    return estimateContextTokens(await this.messages(id)).tokens;
  }

  /** Summarize older context now; resolves once the summary is placed (or nothing was compactable). */
  async compact(id: ConversationKey, instructions?: string): Promise<{ compacted: boolean }> {
    const conversation = await this.conversation(id);
    const taskId = await conversation.compact(instructions, BACKGROUND_CONTEXT);
    const settled = await this.harness.waitForTask(taskId, BACKGROUND_CONTEXT);
    const outcome = settled.state.outcome;
    if (outcome.status !== "completed") return { compacted: false };
    const result = outcome.result;
    if (result.submissionId !== undefined) {
      const placed = await this.harness.submission(
        result.submissionId as never,
        BACKGROUND_CONTEXT,
      );
      await placed?.wait(BACKGROUND_CONTEXT);
    }
    return { compacted: result.entryId !== undefined || result.submissionId !== undefined };
  }

  // ── Events ──

  /**
   * Subscribe to a conversation's committed agent events (tool start/end,
   * messages, compaction, task failures). The underlying watch is opened lazily
   * and lives until {@link close}.
   */
  subscribe(id: ConversationKey, listener: RuntimeEventListener): () => void {
    let set = this.listeners.get(id);
    if (!set) {
      set = new Set();
      this.listeners.set(id, set);
    }
    set.add(listener);
    if (!this.observers.has(id)) {
      this.observers.set(
        id,
        this.observe(id).catch((error) => {
          this.log.withError(error).withMetadata({ conversationId: id }).warn("event watch failed");
        }),
      );
    }
    return () => set.delete(listener);
  }

  private async observe(id: ConversationKey): Promise<void> {
    const stream = await watchEvents(this.harness, id as never, BACKGROUND_CONTEXT);
    stream.start(async (events) => {
      for (const event of events) {
        for (const listener of this.listeners.get(id) ?? []) {
          try {
            listener(event);
          } catch (error) {
            this.log.withError(error).warn("runtime event listener threw");
          }
        }
      }
    });
  }

  /** Resolves once the event watch for `id` is attached (tests await this before submitting). */
  async observing(id: ConversationKey): Promise<void> {
    await this.observers.get(id);
  }

  /**
   * Stop scheduling and close the store. In-flight turns are NOT aborted: they
   * stay committed at their last checkpoint and the next {@link open} resumes them.
   */
  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    await this.harness.close(BACKGROUND_CONTEXT);
  }
}

/** Per-turn limits (see {@link DurableRuntime.guardTurn}); 0 disables a limit. */
export interface TurnGuard {
  maxTools: number;
  maxCostUsd: number;
  toolsUsed: number;
  costUsd: number;
  /** Which limit tripped first, if any. */
  exceeded: "tools" | "cost" | undefined;
  trip: (reason: "tools" | "cost") => void;
  release: () => void;
}
