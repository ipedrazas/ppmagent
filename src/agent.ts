import type {
  AssistantMessage,
  Message,
  Model,
  Models,
  ToolResultMessage,
} from "@earendil-works/pi-ai";
import type { AgentEvent, EntryRecord, Storage } from "@earendil-works/pi-durable";
import type { Config } from "./config.ts";
import { type Logger, nullLogger } from "./logger.ts";
import { type MemoryContextHook, makeTransformContext } from "./memory/context.ts";
import { PpmClient } from "./memory/ppm.ts";
import { buildMemoryTools } from "./memory/tools.ts";
import type { MetricsCollector } from "./metrics/collector.ts";
import { ProteosClient } from "./proteos/proteos.ts";
import { buildProteosTools } from "./proteos/tools.ts";
import { PulseClient } from "./pulse/pulse.ts";
import { buildPulseTools } from "./pulse/tools.ts";
import type { ReminderStore } from "./reminder/store.ts";
import { buildReminderTools } from "./reminder/tools.ts";
import { buildModels, resolveModel } from "./runtime/models.ts";
import { type ConversationKey, DurableRuntime, messageText } from "./runtime/runtime.ts";
import type { AppTool } from "./tool-helpers.ts";
import { buildAskUserTool } from "./tools/ask-user.ts";
import type { ConfirmationStore } from "./tools/confirmation.ts";
import { clipPayload, type TraceRecorder } from "./trace/recorder.ts";
import { DataboxClient } from "./tracker/databox.ts";
import { buildTrackerTools } from "./tracker/tools.ts";
/**
 * Tools that write state — tracker mutations, memory writes, git operations, and
 * task dispatch. These are logged at `info` level so there is a clear audit trail
 * of every state-changing action the agent takes. Read-only tools stay at `debug`.
 */
export const MUTATING_TOOLS = new Set<string>([
  // tracker writes
  "tracker_create_task",
  "tracker_update_task",
  "tracker_create_project",
  "tracker_update_project",
  // memory writes
  "memory_write",
  "memory_create_project",
  "memory_update_project",
  // governance writes (memory_standard/memory_initiative also have read actions,
  // but their writes matter enough to keep the whole tool in the audit trail)
  "memory_verdict",
  "memory_waive",
  "memory_standard",
  "memory_initiative",
  // proteos mutations (machine lifecycle, clone, run, send, cancel, branch, commit, push, PR)
  "proteos_machine_create",
  "proteos_machine_start",
  "proteos_machine_stop",
  "proteos_project_clone",
  "proteos_project_ensure",
  "proteos_task_run",
  "proteos_task_send",
  "proteos_task_cancel",
  "proteos_git_branch",
  "proteos_git_commit",
  "proteos_git_push",
  "proteos_git_pr",
  // pulse mutations (image pull, compose up/down on a remote node)
  "pulse_pull",
  "pulse_up",
  "pulse_down",
]);

/**
 * Tools whose interrupted execution must never be re-run when the durable
 * runtime recovers from a crash: everything that writes (see
 * {@link MUTATING_TOOLS}) plus the writers that are not worth an audit line —
 * reminders and `ask_user` (which records an open question in memory). A
 * read-only tool is replayed; one of these is reported to the model as
 * interrupted so it can check the outcome instead of repeating a side effect.
 */
export const NON_REPLAYABLE_TOOLS: ReadonlySet<string> = new Set([
  ...MUTATING_TOOLS,
  "reminder_create",
  "reminder_cancel",
  "ask_user",
]);

export const SYSTEM_PROMPT = `You are a Project / Product-Owner agent. You turn vague requests into well-scoped tracker tasks and keep structured, human-readable memory.

Tracker entities:
- Tasks (issues) and projects are read+write; teams are read-only reference data.
- To update a task, call tracker_update_task with its reference (e.g. TAV-9) and only the fields that change; it can move a task to a workflow state (status, e.g. Todo, In Progress, Done), under a project, reassign it, relabel it, or set priority.
- Prefer tracker_get_task for a known reference (e.g. TAV-9) and tracker_list_tasks with a status/field filter for "show me X tasks" requests; reserve tracker_search_tasks for genuine free-text queries — it is full-text search and slower than a direct lookup or filter.
- To update a project, first get its id via tracker_get_project or tracker_list_projects, then call tracker_update_project with that id and only the fields that change.

Operating rules:
- ORIENT before acting: call memory_list before reading specific entries.
- CLARIFY before creating: if a request is under-specified (missing acceptance criteria, target metric, or owner), call ask_user with ONE question and stop. Never batch ask_user with other tools. Never guess a task into the backlog.
- Memory holds WHY; the tracker holds WHAT + STATUS. After tracker_create_task or tracker_create_project, record the rationale with memory_write type=task (ref/id + url), never the status.
- Resolve open questions with memory_write type=question resolve:true once answered.
- Keep entries atomic and typed. Prefer specific types over note.
- DON'T retry a deterministic failure: if a tool's error says the result is fixed (complexity limit, not-found, "use the project UUID instead", resolver unavailable), stop that route — never repeat the same call with the same args. Immediately pick the cheapest fallback: create the task unfiled (no project) and record a memory note of the intended project, instead of hunting further (task reads/searches never surface project UUIDs).
- NEED A PROJECT UUID but the project listing is down? Task dumps (tracker_get_task / tracker_list_tasks) only show the project display name, never its UUID — never re-read tasks hoping for one. Work the non-listing routes once each, in order: (a) pass a qualified project name (try the exact/alternate spellings, e.g. with team or workspace prefix) as project_id to tracker_create_task / tracker_update_task — name resolution is attempted and may succeed; (b) check memory summaries and existing task/project URLs for a recorded project id; (c) at most ONE targeted lookup with a filter (e.g. tracker_get_project with the name) instead of whole-task reads. Stop repeating any call whose error says the result can't change. If the UUID still can't be resolved, create the task unfiled with a clear note in its description naming the intended project, record the exact blocker and the routes you tried in memory (memory_write type=note), and tell the user the task was filed unfiled and why — never file silently unfiled.

Cross-cutting governance (standards, initiatives, audit):
- The injected context ends with the active project's "cross-cutting obligations". Act on them: judge a \`manual\` standard with memory_verdict (pass/fail + rationale) once you can tell; record a justified exception with memory_waive (the reason is mandatory — never waive to silence a failure).
- memory_audit runs the compliance matrix across projects; narrow it by tag/project or run an ad-hoc built-in check. Use it to answer "where do we stand" questions instead of reading projects one by one.
- Declare workspace invariants with memory_standard and cross-project campaigns with memory_initiative; bind a member project to an initiative with its tracker ref. Scope either via project tags (memory_update_project addTags), which is also how you set a project's lifecycle status and tracker link.

Delegating execution to ProteOS (proteos_* tools):
- ProteOS runs a headless coding agent against a repo cloned in a microVM. Use it to DO the work behind a task (write code, fix a bug), not to track it — the tracker still holds STATUS.
- Flow: proteos_machines_list to get a machine id → proteos_project_ensure the repo onto it → proteos_task_run with a clear prompt. If no suitable machine exists, create one from a template (proteos_templates_list → proteos_machine_create); if a machine is stopped, proteos_machine_start it. task_run returns a task id immediately and does NOT wait — dispatch is fire-and-forget: report the id and END YOUR TURN. Only pass wait:true to task_run when the user explicitly asks to wait for or be notified about the result; that tracks it in the background and notifies on completion.
- NEVER poll for a task's result. Do not call proteos_task_get (or proteos_tasks_list) repeatedly in a turn, and never to "wait" for a task — tasks take minutes to 30m, so no amount of polling in one turn will see the end. Check status only when the user asks, once, then end your turn. Status reads are rate-limited with a growing backoff (1s, 10s, 30s, 90s, 5m per task); a refused read means stop, not retry, and continuing to hammer it ends the turn.
- Every proteos call takes the machine id explicitly; task/git/project calls also take the project (the repo's workspace directory name). If a machine is running a task for the same project, do proteos_task_run in a different machine.
- To land the work: review with proteos_git_status/proteos_git_diff, then proteos_git_branch, proteos_git_commit, proteos_git_push (setUpstream on a new branch), and proteos_git_pr. The task agent never commits on its own — that is the explicit gate.
- After dispatching or landing work for a tracker task, record the link (task id / PR url) in memory with memory_write, never the live status.

Deploying with pulse (pulse_* tools):
- pulse manages Docker stacks on remote nodes/VMs. Use pulse_nodes to see what's available, pulse_ps/pulse_images to inspect a node, pulse_pull to fetch a newer image, and pulse_up to (re)deploy the compose stack (e.g. "Redeploy ProteOS" → pulse_up with that node's compose file). pulse_down stops a stack. pulse_up/pulse_down change what is running, so they require user confirmation.

Reminders (reminder_* tools):
- When the user says "remind me [time] about X" or "remind me to X [time]", call reminder_create with their message and when.
- The \`when\` field accepts natural language: "tomorrow", "in 2 hours", "at 3pm", "next Monday", "in 30 minutes", or an ISO 8601 datetime.
- To show pending reminders call reminder_list; to cancel one call reminder_cancel with its id.`;

export { resolveModel } from "./runtime/models.ts";

export interface BuiltAgent {
  /** The durable runtime: conversations, turns, recovery. */
  runtime: DurableRuntime;
  /** The resolved model the agent runs on. */
  model: Model<any>;
  ppm: PpmClient;
  databox: DataboxClient;
  proteos: ProteosClient;
  pulse: PulseClient;
  /** Memory-injection seam; `sliceTokens()` returns the ephemeral slice size for token accounting. */
  memoryContext: MemoryContextHook;
  /**
   * Attach logging/tracing/metrics/compaction-checkpoint observers to a
   * conversation. Idempotent; called for every conversation a session uses.
   */
  observe: (conversationId: ConversationKey) => void;
}

export interface BuildAgentOverrides {
  /** Inject a model (e.g. a faux provider's) instead of resolving from config. */
  model?: Model<any>;
  /**
   * Inject the `Models` collection the harness resolves the model against (e.g.
   * one holding a faux provider in tests). Defaults to the built-in providers.
   */
  models?: Models;
  /** Supply durable storage directly — tests share one to simulate a restart. */
  storage?: Storage;
  /** Root logger; child loggers are derived for the clients and tool tracing. */
  logger?: Logger;
  /** Session trace sink; tool start/end events are recorded when present. */
  recorder?: TraceRecorder;
  /** Live metrics collector; tool call counts and error rates are recorded when present. */
  metrics?: MetricsCollector;
  /** Called after `proteos_task_run` dispatches a task (for background monitoring). */
  onTaskDispatched?: (machine: string, taskId: string, project: string, label: string) => void;
  /** When set, push/PR and tracker mutations require confirmation before executing. */
  confirmationStore?: ConfirmationStore;
  /** When set, reminder_* tools are available for scheduling personal reminders. */
  reminderStore?: ReminderStore;
  /** Replace the whole tool set (test seam: scripted tools instead of ppm/tracker/ProteOS). */
  tools?: AppTool[];
  /** Open the store without resuming unfinished work (tests inspect a crash's aftermath first). */
  resume?: boolean;
  /** Tokens of recent context a compaction keeps verbatim (tests shrink it). */
  keepRecentTokens?: number;
  /** Provider-call retry tuning (tests set `maxRetries: 0`). */
  retry?: { maxRetries?: number; baseDelayMs?: number };
}

/** Text of a durable entry's first model message (summaries, tool results). */
function entryText(entry: EntryRecord): string {
  return messageText(entry.model?.[0]);
}

/**
 * Subscribe to a conversation's committed events: one log line when a tool
 * starts and one when it ends. Mutating tools (writes, git ops, task dispatch)
 * are logged at `info` for an audit trail; read-only tools stay at `debug`.
 * Errors are always `warn`. Trace events are also recorded when a recorder is
 * present — tool args and results (both clipped), and each assistant message's
 * text and provider-reported usage — so a trace carries enough to replay or
 * grade a session. When a compaction summary lands it is flushed to the active
 * project's memory as a durable checkpoint.
 */
function traceConversation(
  runtime: DurableRuntime,
  conversationId: ConversationKey,
  deps: {
    logger: Logger;
    recorder?: TraceRecorder;
    metrics?: MetricsCollector;
    ppm: PpmClient;
    getActiveProject: () => string | undefined;
  },
): () => void {
  const { recorder, metrics } = deps;
  const log = deps.logger.child().withContext({ component: "agent" });
  return runtime.subscribe(conversationId, (event: AgentEvent) => {
    if (event.type === "tool_execution_start") {
      if (event.parentToolCallId) return;
      const isMutating = MUTATING_TOOLS.has(event.toolName);
      const meta = log.withMetadata({
        tool: event.toolName,
        toolCallId: event.toolCallId,
        ...(isMutating ? { params: clipPayload(event.args) } : {}),
      });
      if (isMutating) meta.info("tool start");
      else meta.debug("tool start");
      recorder?.record({
        type: "tool_start",
        tool: event.toolName,
        toolCallId: event.toolCallId,
        args: clipPayload(event.args),
      });
    } else if (event.type === "tool_execution_end") {
      if (event.parentToolCallId) return;
      const result = event.entry?.model?.[0] as ToolResultMessage | undefined;
      // A call whose entry is absent faulted or was orphaned: report it as an error.
      const isError = result?.isError ?? true;
      const isMutating = MUTATING_TOOLS.has(event.toolName);
      const line = log.withMetadata({
        tool: event.toolName,
        toolCallId: event.toolCallId,
        isError,
      });
      if (isError) line.warn("tool end (error)");
      else if (isMutating) line.info("tool end");
      else line.debug("tool end");
      recorder?.record({
        type: "tool_end",
        tool: event.toolName,
        toolCallId: event.toolCallId,
        isError,
        result: clipPayload(result?.content ?? null),
      });
      metrics?.recordToolCall(event.toolName, isError);
    } else if (event.type === "message_end") {
      const message = event.entry.model?.[0];
      if (event.entry.kind === "pi.assistant" && message?.role === "assistant") {
        recordAssistant(log, recorder, metrics, message);
      } else if (event.entry.kind === "pi.compaction") {
        const project = deps.getActiveProject();
        const summary = entryText(event.entry);
        log.withMetadata({ project, chars: summary.length }).info("transcript compacted");
        recorder?.record({ type: "compaction", summaryChars: summary.length });
        if (project && summary) {
          void deps.ppm
            .write([
              "conversation",
              "add",
              project,
              "--content",
              `Compaction checkpoint.\n\n${summary}`,
            ])
            .catch((error) => {
              log.withError(error).warn("failed to flush compaction summary to memory");
            });
        }
      }
    } else if (event.type === "task_failed") {
      log.withMetadata({ kind: event.kind, error: event.message }).error("durable task failed");
    } else if (event.type === "auto_retry_start") {
      log
        .withMetadata({ attempt: event.attempt, error: event.errorMessage })
        .warn("model call failed; retrying");
    }
  });
}

function recordAssistant(
  log: Logger,
  recorder: TraceRecorder | undefined,
  metrics: MetricsCollector | undefined,
  message: AssistantMessage,
): void {
  metrics?.recordUsage(message.usage);
  const text = messageText(message);
  // A failed provider call is committed as an assistant message with empty
  // text, stopReason "error", and the real cause in `errorMessage`. Logging it
  // here is the only place that cause is visible besides the turn outcome.
  if (message.errorMessage) {
    log
      .withMetadata({
        model: message.model,
        provider: message.provider,
        stopReason: message.stopReason,
        error: message.errorMessage,
      })
      .error("model turn failed");
  } else {
    log
      .withMetadata({
        model: message.model,
        stopReason: message.stopReason,
        chars: text.length,
        totalTokens: message.usage.totalTokens,
      })
      .debug("model turn");
  }
  recorder?.record({
    type: "assistant_message",
    text: clipPayload(text),
    stopReason: message.stopReason,
    ...(message.errorMessage ? { error: message.errorMessage } : {}),
    totalTokens: message.usage.totalTokens,
    costUsd: message.usage.cost.total,
  });
}

/**
 * Wire the agent: memory + tracker + ask_user tools, the `ppm context`
 * injection seam, and the configured provider's model, all hosted on a durable
 * runtime. `getActiveProject` is supplied by the caller (the Telegram adapter
 * tracks it per chat). Async because opening the durable store resumes any turn
 * the previous process left unfinished.
 */
export async function buildAgent(
  config: Config,
  getActiveProject: () => string | undefined,
  overrides: BuildAgentOverrides = {},
): Promise<BuiltAgent> {
  const logger = overrides.logger ?? nullLogger;
  const maxOutputBytes = config.execMaxOutputBytes;
  const ppm = new PpmClient({
    bin: config.ppmBin,
    root: config.ppmMemoryRoot,
    logger,
    maxOutputBytes,
  });
  const databox = new DataboxClient({
    bin: config.dbxcliBin,
    config: config.dbxcliConfig,
    logger,
    maxOutputBytes,
    queryLimit: config.dbxcliQueryLimit,
  });
  const proteos = new ProteosClient({
    bin: config.proteosBin,
    url: config.proteosUrl || undefined,
    logger,
    maxOutputBytes,
    githubToken: config.githubToken || undefined,
  });
  const pulse = new PulseClient({
    bin: config.pulseBin,
    logger,
    maxOutputBytes,
  });

  const tools = overrides.tools ?? [
    ...buildMemoryTools(ppm),
    ...buildTrackerTools(databox, {
      confirmationStore: overrides.confirmationStore,
      queryLimit: config.dbxcliQueryLimit,
    }),
    ...buildProteosTools(proteos, {
      onTaskDispatched: overrides.onTaskDispatched,
      confirmationStore: overrides.confirmationStore,
    }),
    ...buildPulseTools(pulse, { confirmationStore: overrides.confirmationStore }),
    ...(overrides.reminderStore ? buildReminderTools(overrides.reminderStore) : []),
    buildAskUserTool(ppm),
  ];

  const model = overrides.model ?? resolveModel(config, logger);
  const memoryContext = makeTransformContext({
    ppm,
    recent: config.contextRecent,
    getActiveProject,
    logger,
  });
  const llmLog = logger.child().withContext({ component: "llm" });
  logger
    .child()
    .withContext({ component: "agent" })
    .withMetadata({
      model: model.id,
      provider: model.provider,
      api: model.api,
      baseUrl: model.baseUrl,
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
      tools: tools.length,
      durableDb: overrides.storage ? "(injected)" : config.durableDbFile,
    })
    .info("agent model resolved");

  const runtime = await DurableRuntime.open({
    dbFile: overrides.storage ? undefined : config.durableDbFile,
    storage: overrides.storage,
    models: overrides.models ?? buildModels(config, model),
    model,
    systemPrompt: SYSTEM_PROMPT,
    tools,
    mutatingTools: NON_REPLAYABLE_TOOLS,
    transformRequest: async (messages: readonly Message[], signal?: AbortSignal) => {
      // Logged per attempt, including recovery attempts after a restart.
      llmLog
        .withMetadata({ model: model.id, provider: model.provider, messages: messages.length })
        .debug("llm request");
      llmLog
        .withMetadata({ model: model.id, payload: clipPayload(messages) })
        .trace("llm request body");
      return memoryContext.hook(messages, signal);
    },
    compactionThreshold: config.compactionTokenThreshold,
    keepRecentTokens: overrides.keepRecentTokens,
    resume: overrides.resume,
    retry: overrides.retry,
    logger,
  });

  const observed = new Set<ConversationKey>();
  const observe = (conversationId: ConversationKey): void => {
    if (observed.has(conversationId)) return;
    observed.add(conversationId);
    traceConversation(runtime, conversationId, {
      logger,
      recorder: overrides.recorder,
      metrics: overrides.metrics,
      ppm,
      getActiveProject,
    });
  };

  return { runtime, model, ppm, databox, proteos, pulse, memoryContext, observe };
}
