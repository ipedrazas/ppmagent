import { Agent, type AgentOptions, type StreamFn } from "@earendil-works/pi-agent-core";
import {
  type AssistantMessage,
  createProvider,
  envApiKeyAuth,
  type Model,
  type TextContent,
} from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import {
  builtinModels,
  getBuiltinModel,
  getBuiltinModels,
} from "@earendil-works/pi-ai/providers/all";
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
  // pulse mutations (image pull, compose up/down on a remote node)
  "pulse_pull",
  "pulse_up",
  "pulse_down",
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

/** Catalog ids for a provider, ranked so the closest matches to `wanted` come first. */
function suggestModelIds(provider: string, wanted: string): string[] {
  const ids = getBuiltinModels(provider as "anthropic").map((m) => m.id);
  // A mis-typed id is usually a real id plus/minus a suffix (a date stamp, a
  // `-latest`), so rank by shared prefix length before falling back to
  // alphabetical order.
  const sharedPrefix = (id: string): number => {
    let i = 0;
    while (i < id.length && i < wanted.length && id[i] === wanted[i]) i++;
    return i;
  };
  return ids.sort((a, b) => sharedPrefix(b) - sharedPrefix(a) || a.localeCompare(b)).slice(0, 10);
}

/**
 * Context/output assumptions for a model pi's catalog does not know. They only
 * feed compaction, so they are deliberately conservative — set
 * PPMA_COMPACTION_TOKEN_THRESHOLD explicitly when running an uncatalogued model.
 */
const UNCATALOGUED_CONTEXT_WINDOW = 128_000;
const UNCATALOGUED_MAX_TOKENS = 8_192;

/**
 * Build a descriptor for a model id the catalog does not list, by borrowing the
 * endpoint and wire API from any catalogued model of the same provider. Returns
 * undefined when the provider is unknown or does not speak
 * `openai-completions` — those (e.g. anthropic) need provider-specific request
 * shaping we cannot safely synthesize.
 *
 * A provider's catalog snapshot ages faster than the pinned pi-ai release, so a
 * brand-new model id (e.g. a dated snapshot published after the pin) is a
 * legitimate config, not a typo. Costs are zeroed because they are genuinely
 * unknown — see the warning in {@link resolveModel}.
 */
function uncataloguedModel(config: Config): Model<"openai-completions"> | undefined {
  // The cast widens away the catalog's per-provider `api` literal so the runtime
  // check below is expressible (config supplies the provider at runtime).
  const [sample] = getBuiltinModels(config.provider as "anthropic") as Model<any>[];
  const baseUrl = config.baseUrl || sample?.baseUrl;
  if (!baseUrl || (sample && sample.api !== "openai-completions")) return undefined;
  return {
    id: config.model,
    name: config.model,
    api: "openai-completions",
    provider: config.provider,
    baseUrl,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: UNCATALOGUED_CONTEXT_WINDOW,
    maxTokens: UNCATALOGUED_MAX_TOKENS,
  };
}

/**
 * Resolve the configured provider + model to a runtime `Model`. Ollama is
 * handled specially (see {@link resolveOllamaModel}); every other provider
 * goes through `getBuiltinModel`, which is strongly typed over the built-in
 * catalog — the casts let config-supplied values flow through (it is a
 * runtime catalog lookup).
 *
 * A catalog miss must never return `undefined`: pi-agent-core silently
 * substitutes a placeholder model (`api: "unknown"`), every turn then fails
 * inside the agent loop with "No API provider registered for api: unknown", and
 * pi swallows that into an empty assistant message — a bot that answers
 * "(no reply)" to everything with nothing in the logs. So a miss either
 * synthesizes a descriptor for the provider's endpoint (loudly — the id may
 * simply be newer than the pinned catalog) or throws.
 */
export function resolveModel(config: Config, logger: Logger = nullLogger): Model<any> {
  if (config.provider === "ollama") {
    return resolveOllamaModel(config);
  }
  const model = getBuiltinModel(
    config.provider as "anthropic",
    config.model as "claude-sonnet-4-6",
  );
  if (model) return model;

  const synthesized = uncataloguedModel(config);
  if (synthesized) {
    logger
      .withMetadata({
        model: config.model,
        provider: config.provider,
        baseUrl: synthesized.baseUrl,
        assumedContextWindow: synthesized.contextWindow,
        closestCatalogIds: suggestModelIds(config.provider, config.model).slice(0, 3),
      })
      .warn(
        `Model "${config.model}" is not in pi's catalog; calling ${config.provider} with it ` +
          "anyway. Cost is reported as $0 (so PPMA_TURN_MAX_COST_USD / " +
          "PPMA_SESSION_MAX_COST_USD stop enforcing) and the context window is an " +
          "assumption. If the provider does not know the id either it will reject the " +
          "call — that surfaces as a `model turn failed` log line, not a crash.",
      );
    return synthesized;
  }

  const suggestions = suggestModelIds(config.provider, config.model);
  throw new Error(
    `Unknown model "${config.model}" for provider "${config.provider}" — ` +
      "it is not in pi's built-in catalog and cannot be called generically " +
      "(this provider does not use the OpenAI-completions wire format). " +
      "Set PPMA_MODEL to a known id" +
      (suggestions.length > 0 ? `, e.g. one of: ${suggestions.join(", ")}` : "") +
      ".",
  );
}

/**
 * The stream function real (non-test) runs use.
 *
 * pi-agent-core made `streamFn` a required `Agent` option: omitting it no
 * longer falls back to a provider registry, it throws "No default stream
 * function configured" on the first turn. So the host owns that fallback now.
 * It mirrors {@link resolveModel}: the built-in providers cover every
 * catalogued and uncatalogued-but-catalogued-provider model, and Ollama gets
 * the same synthesized provider {@link resolveOllamaModel} builds its
 * descriptor from — otherwise `streamSimple` would reject its model with
 * "Unknown provider".
 */
export function defaultStreamFn(config: Config): StreamFn {
  const models = builtinModels();
  if (config.provider === "ollama") models.setProvider(ollamaProvider(config.baseUrl));
  return (model, context, options) => models.streamSimple(model, context, options);
}

export interface BuiltAgent {
  agent: Agent;
  /** The resolved model the agent runs on — also used by the compaction summarizer. */
  model: Model<any>;
  ppm: PpmClient;
  databox: DataboxClient;
  proteos: ProteosClient;
  pulse: PulseClient;
  /** Memory-injection seam; `sliceTokens()` returns the ephemeral slice size for token accounting. */
  memoryContext: MemoryContextHook;
}

export interface BuildAgentOverrides {
  /** Inject a model (e.g. a faux provider in tests) instead of resolving from config. */
  model?: Model<any>;
  /**
   * Inject the stream function (e.g. a faux provider backed by a `Models`
   * collection in tests). When omitted, {@link defaultStreamFn} is used.
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

/** Byte length of a value once serialized, or 0 if it cannot be serialized. */
function jsonSize(value: unknown): number {
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return 0;
  }
}

/**
 * Shape-agnostic summary of a provider request body: enough to see *that* a
 * request went out and roughly what was in it, without dumping the whole
 * transcript into the log on every turn. The full body is logged separately at
 * `trace`.
 */
function payloadSummary(payload: unknown): Record<string, unknown> {
  const body = payload as
    | { model?: unknown; messages?: unknown; tools?: unknown; stream?: unknown }
    | null
    | undefined;
  return {
    payloadModel: typeof body?.model === "string" ? body.model : undefined,
    messages: Array.isArray(body?.messages) ? body.messages.length : undefined,
    tools: Array.isArray(body?.tools) ? body.tools.length : undefined,
    stream: typeof body?.stream === "boolean" ? body.stream : undefined,
    bytes: jsonSize(payload),
  };
}

/**
 * Log every provider request and response. `debug` gives the one-line "we sent
 * N messages to model X / the endpoint answered HTTP 200" pair that answers
 * "is the message going out, is anything coming back"; `trace` adds the full
 * request body and response headers for when the summary is not enough. A
 * non-2xx status is logged at `warn` — pi retries some of those internally, so
 * without this they are invisible even when the turn eventually fails.
 */
function llmHooks(logger: Logger): Pick<AgentOptions, "onPayload" | "onResponse"> {
  const log = logger.child().withContext({ component: "llm" });
  return {
    onPayload: (payload, model) => {
      const line = log.withMetadata({
        model: model.id,
        provider: model.provider,
        api: model.api,
        baseUrl: model.baseUrl,
        ...payloadSummary(payload),
      });
      line.debug("llm request");
      log
        .withMetadata({ model: model.id, payload: clipPayload(payload) })
        .trace("llm request body");
      // Returning undefined leaves the payload untouched — this hook only observes.
      return undefined;
    },
    onResponse: (response, model) => {
      const line = log.withMetadata({
        model: model.id,
        provider: model.provider,
        status: response.status,
      });
      if (response.status >= 400) line.warn("llm response (error status)");
      else line.debug("llm response");
      log
        .withMetadata({ model: model.id, status: response.status, headers: response.headers })
        .trace("llm response headers");
    },
  };
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
      const text = assistantText(message.content);
      // pi-agent-core never throws out of `prompt()`: a failed run is turned
      // into an assistant message with empty text, stopReason "error", and the
      // real cause in `errorMessage`. Logging it here is the only place that
      // cause is visible — otherwise the turn just produces no reply.
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
  const pulse = new PulseClient({
    bin: config.pulseBin,
    logger,
    maxOutputBytes,
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
    })
    .info("agent model resolved");

  const agent = new Agent({
    initialState: {
      systemPrompt: SYSTEM_PROMPT,
      model,
      tools,
    },
    transformContext: memoryContext.hook,
    streamFn: overrides.streamFn ?? defaultStreamFn(config),
    getApiKey: () => config.apiKey,
    ...llmHooks(logger),
  });

  traceTools(agent, logger, overrides.recorder, overrides.metrics);

  return { agent, model, ppm, databox, proteos, pulse, memoryContext };
}
