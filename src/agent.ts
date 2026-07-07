import { Agent, type StreamFn } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
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
- Flow: proteos_machines_list to get a machine id → proteos_project_ensure the repo onto it → proteos_task_run with a clear prompt. If no suitable machine exists, create one from a template (proteos_templates_list → proteos_machine_create — it provisions billable compute, so the user must confirm); if a machine is stopped, proteos_machine_start it. task_run returns a task id immediately and does NOT wait; report the id and poll with proteos_task_get rather than blocking. Every proteos call takes the machine id explicitly; task/git/project calls also take the project (the repo's workspace directory name).
- To land the work: review with proteos_git_status/proteos_git_diff, then proteos_git_branch, proteos_git_commit, proteos_git_push (setUpstream on a new branch), and proteos_git_pr. The task agent never commits on its own — that is the explicit gate.
- After dispatching or landing work for a tracker task, record the link (task id / PR url) in memory with memory_write, never the live status.

Reminders (reminder_* tools):
- When the user says "remind me [time] about X" or "remind me to X [time]", call reminder_create with their message and when.
- The \`when\` field accepts natural language: "tomorrow", "in 2 hours", "at 3pm", "next Monday", "in 30 minutes", or an ISO 8601 datetime.
- To show pending reminders call reminder_list; to cancel one call reminder_cancel with its id.`;

/**
 * Resolve a model from a provider id + model id. `getBuiltinModel` is strongly
 * typed over the built-in catalog; the casts let config-supplied values flow
 * through (it is a runtime catalog lookup).
 */
function resolveModel(provider: string, modelId: string): Model<any> {
  return getBuiltinModel(provider as "anthropic", modelId as "claude-sonnet-4-6");
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

/**
 * Subscribe to the agent's tool-execution events: one log line when a tool
 * starts and one when it ends. Mutating tools (writes, git ops, task dispatch)
 * are logged at `info` for an audit trail; read-only tools stay at `debug`.
 * Errors are always `warn`. A trace event is also recorded when a recorder is
 * present (args clipped; results are not recorded — they live in the transcript).
 * Returns the unsubscribe handle (left attached for the process lifetime).
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
      });
      metrics?.recordToolCall(event.toolName, event.isError);
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
    ...buildTrackerTools(databox, { confirmationStore: overrides.confirmationStore }),
    ...buildProteosTools(proteos, {
      onTaskDispatched: overrides.onTaskDispatched,
      confirmationStore: overrides.confirmationStore,
    }),
    ...(overrides.reminderStore ? buildReminderTools(overrides.reminderStore) : []),
    buildAskUserTool(ppm),
  ];

  const model = overrides.model ?? resolveModel(config.provider, config.model);
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
