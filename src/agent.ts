import { Agent, type StreamFn } from "@earendil-works/pi-agent-core";
import {
  type AssistantMessage,
  createProvider,
  envApiKeyAuth,
  type Model,
  type TextContent,
} from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { getBuiltinModel } from "@earendil-works/pi-ai/providers/all";
import type { Config } from "./config.ts";
import { type Logger, nullLogger } from "./logger.ts";
import { type MemoryContextHook, makeTransformContext } from "./memory/context.ts";
import { PpmClient } from "./memory/ppm.ts";
import { buildMemoryTools } from "./memory/tools.ts";
import type { MetricsCollector } from "./metrics/collector.ts";
import { ProteosClient } from "./proteos/proteos.ts";
import { buildProteosTools } from "./proteos/tools.ts";
import type { ReminderStore } from "./reminder/store.ts";
import { buildReminderTools } from "./reminder/tools.ts";
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
const MUTATING_TOOLS = new Set<string>([
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
]);

export const SYSTEM_PROMPT = `You are a Project / Product-Owner agent. You turn vague requests into well-scoped tracker tasks and keep structured, human-readable memory.

Tracker entities:
- Tasks (issues) and projects are read+write; teams are read-only reference data.
- To update a task, call tracker_update_task with its reference (e.g. TAV-9) and only the fields that change; it can move a task to a workflow state (status, e.g. Todo, In Progress, Done), under a project, reassign it, relabel it, or set priority.
- Prefer tracker_get_task for a known reference (e.g. TAV-9) and tracker_list_tasks with a status/field filter for "show me X tasks" requests; reserve tracker_search_tasks for genuine free-text queries — it is full-text search and slower than a direct lookup or filter.
- To create a project you need its owning team. Pass the team key (e.g. TAV) to tracker_create_project, or call tracker_list_teams first if unsure.
- To update a project, first get its id via tracker_get_project or tracker_list_projects, then call tracker_update_project with that id and only the fields that change.

Operating rules:
- ORIENT before acting: call memory_list before reading specific entries.
- CLARIFY before creating: if a request is under-specified (missing acceptance criteria, target metric, or owner), call ask_user with ONE question and stop. Never batch ask_user with other tools. Never guess a task into the backlog.
- Memory holds WHY; the tracker holds WHAT + STATUS. After tracker_create_task or tracker_create_project, record the rationale with memory_write type=task (ref/id + url), never the status.
- Resolve open questions with memory_write type=question resolve:true once answered.
- Keep entries atomic and typed. Prefer specific types over note.

Cross-cutting governance (standards, initiatives, audit):
- The injected context ends with the active project's "cross-cutting obligations". Act on them: judge a \`manual\` standard with memory_verdict (pass/fail + rationale) once you can tell; record a justified exception with memory_waive (the reason is mandatory — never waive to silence a failure).
- memory_audit runs the compliance matrix across projects; narrow it by tag/project or run an ad-hoc built-in check. Use it to answer "where do we stand" questions instead of reading projects one by one.
- Declare workspace invariants with memory_standard and cross-project campaigns with memory_initiative; bind a member project to an initiative with its tracker ref. Scope either via project tags (memory_update_project addTags), which is also how you set a project's lifecycle status and tracker link.

Delegating execution to ProteOS (proteos_* tools):
- ProteOS runs a headless coding agent against a repo cloned in a microVM. Use it to DO the work behind a task (write code, fix a bug), not to track it — the tracker still holds STATUS.
- Flow: proteos_machines_list to get a machine id → proteos_project_ensure the repo onto it → proteos_task_run with a clear prompt. If no suitable machine exists, create one from a template (proteos_templates_list → proteos_machine_create — it provisions billable compute, so the user must confirm); if a machine is stopped, proteos_machine_start it. task_run returns a task id immediately and does NOT wait — by default, just report the id and end your turn; do not loop on proteos_task_get to wait for it. Only pass wait:true to task_run (or poll manually) when the user explicitly asks to wait for or be notified about the result. Every proteos call takes the machine id explicitly; task/git/project calls also take the project (the repo's workspace directory name).
- To land the work: review with proteos_git_status/proteos_git_diff, then proteos_git_branch, proteos_git_commit, proteos_git_push (setUpstream on a new branch), and proteos_git_pr. The task agent never commits on its own — that is the explicit gate.
- After dispatching or landing work for a tracker task, record the link (task id / PR url) in memory with memory_write, never the live status.

Reminders (reminder_* tools):
- When the user says "remind me [time] about X" or "remind me to X [time]", call reminder_create with their message and when.
- The \`when\` field accepts natural language: "tomorrow", "in 2 hours", "at 3pm", "next Monday", "in 30 minutes", or an ISO 8601 datetime.
- To show pending reminders call reminder_list; to cancel one call reminder_cancel with its id.`;

/**
 * pi-ai has no built-in Ollama provider (it's a local, self-hosted server with
 * no fixed model catalog), so it can't be resolved via `getBuiltinModel`.
 * Build it the same way pi-ai's own OpenAI-compatible providers do — deepseek,
 * zai, and openrouter all wrap `openAICompletionsApi()` via `createProvider` —
 * pointed at the configured base URL instead of a hosted one.
 */
function ollamaProvider(baseUrl: string) {
  return createProvider({
    id: "ollama",
    name: "Ollama",
    baseUrl,
    auth: { apiKey: envApiKeyAuth("Ollama API key", ["OLLAMA_API_KEY"]) },
    models: [],
    api: openAICompletionsApi(),
  });
}

/** Build the runtime Model descriptor for the configured Ollama model id. */
function resolveOllamaModel(config: Config): Model<"openai-completions"> {
  const provider = ollamaProvider(config.baseUrl);
  return {
    id: config.model,
    name: config.model,
    api: "openai-completions",
    provider: provider.id,
    baseUrl: provider.baseUrl ?? config.baseUrl,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 8_192,
  };
}

/**
 * Resolve the configured provider + model to a runtime `Model`. Ollama is
 * handled specially (see {@link resolveOllamaModel}); every other provider
 * goes through `getBuiltinModel`, which is strongly typed over the built-in
 * catalog — the casts let config-supplied values flow through (it is a
 * runtime catalog lookup).
 */
function resolveModel(config: Config): Model<any> {
  if (config.provider === "ollama") {
    return resolveOllamaModel(config);
  }
  return getBuiltinModel(config.provider as "anthropic", config.model as "claude-sonnet-4-6");
}

export interface BuiltAgent {
  agent: Agent;
  /** The resolved model the agent runs on — also used by the compaction summarizer. */
  model: Model<any>;
  ppm: PpmClient;
  databox: DataboxClient;
  proteos: ProteosClient;
  /** Memory-injection seam; `sliceTokens()` returns the ephemeral slice size for token accounting. */
  memoryContext: MemoryContextHook;
}

export interface BuildAgentOverrides {
  /** Inject a model (e.g. a faux provider in tests) instead of resolving from config. */
  model?: Model<any>;
  /**
   * Inject the stream function (e.g. a faux provider backed by a `Models`
   * collection in tests). When omitted, pi-agent-core's default is used.
   */
  streamFn?: StreamFn;
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
}

/** Concatenate the text blocks of an assistant message's content. */
function assistantText(content: AssistantMessage["content"]): string {
  return content
    .filter((c): c is TextContent => c.type === "text")
    .map((c) => c.text)
    .join("");
}

/**
 * Subscribe to the agent's tool-execution and turn-completion events: one log
 * line when a tool starts and one when it ends. Mutating tools (writes, git
 * ops, task dispatch) are logged at `info` for an audit trail; read-only tools
 * stay at `debug`. Errors are always `warn`. Trace events are also recorded
 * when a recorder is present — tool args and results (both clipped), and each
 * assistant turn's text and provider-reported usage — so a trace carries
 * enough to replay or grade a session, not just re-derive it from the live
 * transcript. Returns the unsubscribe handle (left attached for the process
 * lifetime).
 */
function traceTools(
  agent: Agent,
  logger: Logger,
  recorder?: TraceRecorder,
  metrics?: MetricsCollector,
): () => void {
  const log = logger.child().withContext({ component: "agent" });
  return agent.subscribe((event) => {
    if (event.type === "tool_execution_start") {
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
      const isMutating = MUTATING_TOOLS.has(event.toolName);
      const line = log.withMetadata({
        tool: event.toolName,
        toolCallId: event.toolCallId,
        isError: event.isError,
      });
      if (event.isError) line.warn("tool end (error)");
      else if (isMutating) line.info("tool end");
      else line.debug("tool end");
      recorder?.record({
        type: "tool_end",
        tool: event.toolName,
        toolCallId: event.toolCallId,
        isError: event.isError,
        result: clipPayload(event.result),
      });
      metrics?.recordToolCall(event.toolName, event.isError);
    } else if (event.type === "turn_end") {
      const { message } = event;
      if (!("role" in message) || message.role !== "assistant") return;
      metrics?.recordUsage(message.usage);
      recorder?.record({
        type: "assistant_message",
        text: clipPayload(assistantText(message.content)),
        stopReason: message.stopReason,
        totalTokens: message.usage.totalTokens,
        costUsd: message.usage.cost.total,
      });
    }
  });
}

/**
 * Wire the agent: memory + tracker + ask_user tools, the `ppm context`
 * injection seam, and the configured provider's model. `getActiveProject` is supplied by
 * the caller (the Telegram adapter tracks it per chat).
 */
export function buildAgent(
  config: Config,
  getActiveProject: () => string | undefined,
  overrides: BuildAgentOverrides = {},
): BuiltAgent {
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

  const tools = [
    ...buildMemoryTools(ppm),
    ...buildTrackerTools(databox, {
      confirmationStore: overrides.confirmationStore,
      queryLimit: config.dbxcliQueryLimit,
    }),
    ...buildProteosTools(proteos, {
      onTaskDispatched: overrides.onTaskDispatched,
      confirmationStore: overrides.confirmationStore,
    }),
    ...(overrides.reminderStore ? buildReminderTools(overrides.reminderStore) : []),
    buildAskUserTool(ppm),
  ];

  const model = overrides.model ?? resolveModel(config);
  const memoryContext = makeTransformContext({
    ppm,
    recent: config.contextRecent,
    getActiveProject,
    logger,
  });
  const agent = new Agent({
    initialState: {
      systemPrompt: SYSTEM_PROMPT,
      model,
      tools,
    },
    transformContext: memoryContext.hook,
    streamFn: overrides.streamFn,
    getApiKey: () => config.apiKey,
  });

  traceTools(agent, logger, overrides.recorder, overrides.metrics);

  return { agent, model, ppm, databox, proteos, memoryContext };
}
