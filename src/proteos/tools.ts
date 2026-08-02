import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, toolResult } from "../tool-helpers.ts";
import { CONFIRM_SUFFIX, type ConfirmationStore } from "../tools/confirmation.ts";
import { sanitizeLine, sanitizePrompt, sanitizeString } from "../tools/sanitize.ts";
import { BLOCKS_BEFORE_TERMINATE, formatWait, type PollDecision, PollGate } from "./poll-gate.ts";
import type { ProteosClient } from "./proteos.ts";
import { extractTaskId } from "./watcher.ts";

export interface ProteosToolsOptions {
  /** Called after a task is dispatched so the background watcher can track it. */
  onTaskDispatched?: (machine: string, taskId: string, project: string, label: string) => void;
  /** When set, machine create, git push, and git PR require user confirmation before executing. */
  confirmationStore?: ConfirmationStore;
  /** Rate limiter for status reads. Injectable so tests can drive its clock. */
  pollGate?: PollGate;
}

/** Poll-gate key for one task's status. */
function taskKey(machine: string, task: string): string {
  return `task:${machine}/${task}`;
}

/** Poll-gate key for a machine's task listing. */
function tasksKey(machine: string): string {
  return `tasks:${machine}`;
}

/**
 * `proteos_*` tools: delegate coding work to ProteOS, where a headless agent runs
 * against a repo cloned in a firecracker microVM. The control plane owns task
 * status; nothing here is mirrored into memory.
 *
 * Flow: pick a machine (proteos_machines_list) → make sure the repo is on it
 * (proteos_project_ensure) → dispatch (proteos_task_run, returns a task id and
 * does NOT block). By default the dispatch is fire-and-forget — nobody polls
 * it. Only when the caller passes wait:true is the task tracked in the
 * background for a completion notification; proteos_task_get is always
 * available for a manual, one-off status check. Every command takes the
 * machine id explicitly; task/git/project commands also take the project
 * (the repo's workspace directory name).
 *
 * `task watch` (live event stream) is intentionally not exposed: it blocks for up
 * to 30m, which would freeze the chat. Use proteos_task_get for a one-off check,
 * or proteos_task_run's wait:true for background tracking, instead.
 *
 * Status reads go through a {@link PollGate}: repeated checks of the same task or
 * machine back off (1s, 10s, 30s, 90s, 5m) and a caller that keeps hammering has
 * its turn terminated. The prompt asks for fire-and-forget; this enforces it.
 */
export function buildProteosTools(proteos: ProteosClient, opts?: ProteosToolsOptions): AgentTool[] {
  const pollGate = opts?.pollGate ?? new PollGate();

  /**
   * Result returned instead of an actual status read when the caller is polling
   * too fast. Carries the last known output so the model still has something to
   * report, plus the wait before the next check is allowed.
   *
   * The first block is a nudge the model can act on. Once it has ignored
   * {@link BLOCKS_BEFORE_TERMINATE} of them it is looping, so the turn is ended —
   * and since a terminating tool's text is what the user receives, that message
   * is written for them rather than for the model.
   */
  function throttledResult(subject: string, decision: PollDecision) {
    const age = formatWait(decision.ageMs ?? 0);
    const wait = formatWait(decision.waitMs);
    const last = (decision.lastOutput ?? "").trim();
    const terminate = decision.blocked >= BLOCKS_BEFORE_TERMINATE;

    const lines = terminate
      ? [
          `I stopped checking ${subject} — it was last read ${age} ago and status checks are rate-limited to keep from hammering ProteOS. Ask me again in ${wait} or so, or dispatch with wait:true next time and I'll message you when it finishes.`,
        ]
      : [
          `Not checked: ${subject} was already checked ${age} ago and status reads are rate-limited.`,
          `Do not poll in a loop. Wait at least ${wait} before checking again — end your turn, report what is known, and check later if the user asks.`,
          `To be told when the task finishes instead, dispatch with wait:true.`,
        ];
    if (last) lines.push("", `Last known status (${age} ago):`, last);

    return toolResult(lines.join("\n"), { output: "" }, { terminate });
  }

  // ── Discovery ──

  const listMachines = defineTool({
    name: "proteos_machines_list",
    description:
      "List your ProteOS machines (id, name, state, template). A task runs inside a machine, so start here to get a machine id.",
    label: "List machines",
    parameters: Type.Object({}),
    execute: async (_id, _params, signal) => {
      const out = await proteos.listMachines(signal);
      return toolResult(out, { output: out });
    },
  });

  const getMachine = defineTool({
    name: "proteos_machine_get",
    description: "Show one ProteOS machine by its id.",
    label: "Get machine",
    parameters: Type.Object({ machine: Type.String({ description: "machine id, e.g. m-123" }) }),
    execute: async (_id, params, signal) => {
      const out = await proteos.getMachine(params.machine, signal);
      return toolResult(out, { output: out });
    },
  });

  // ── Machine lifecycle ──

  const createMachine = defineTool({
    name: "proteos_machine_create",
    description:
      "Create a new machine from a template (list them with proteos_templates_list). Provisions billable compute, so it requires user confirmation. Asynchronous — the machine boots in the background; poll proteos_machine_get until it is running.",
    label: "Create machine",
    parameters: Type.Object({
      template: Type.String({ description: "template id, e.g. go, full-stack" }),
      name: Type.Optional(Type.String({ description: "display name for the machine" })),
      vcpus: Type.Optional(Type.Integer({ description: "override vCPU count" })),
      memMiB: Type.Optional(Type.Integer({ description: "override memory in MiB" })),
      diskMiB: Type.Optional(Type.Integer({ description: "override disk size in MiB" })),
    }),
    execute: async (_id, params, signal) => {
      const sanitized = {
        ...params,
        template: sanitizeLine(params.template),
        name: params.name !== undefined ? sanitizeLine(params.name) : undefined,
      };

      if (opts?.confirmationStore) {
        const lines = [`Create machine from template '${sanitized.template}'`];
        if (sanitized.name) lines.push(`  Name: ${sanitized.name}`);
        const overrides = [
          sanitized.vcpus !== undefined ? `${sanitized.vcpus} vCPU` : null,
          sanitized.memMiB !== undefined ? `${sanitized.memMiB} MiB mem` : null,
          sanitized.diskMiB !== undefined ? `${sanitized.diskMiB} MiB disk` : null,
        ].filter(Boolean);
        if (overrides.length > 0) lines.push(`  Resources: ${overrides.join(", ")}`);
        const description = lines.join("\n");
        opts.confirmationStore.set(description, (s) => proteos.createMachine(sanitized, s));
        return toolResult(`${description}${CONFIRM_SUFFIX}`, { output: "" }, { terminate: true });
      }

      const out = await proteos.createMachine(sanitized, signal);
      return toolResult(out, { output: out });
    },
  });

  const startMachine = defineTool({
    name: "proteos_machine_start",
    description: "Start a stopped machine by its id.",
    label: "Start machine",
    parameters: Type.Object({ machine: Type.String({ description: "machine id, e.g. m-123" }) }),
    execute: async (_id, params, signal) => {
      const out = await proteos.startMachine(params.machine, signal);
      return toolResult(out, { output: out });
    },
  });

  const stopMachine = defineTool({
    name: "proteos_machine_stop",
    description:
      "Stop a running machine by its id. Running tasks on it are interrupted; the machine can be started again later.",
    label: "Stop machine",
    parameters: Type.Object({ machine: Type.String({ description: "machine id, e.g. m-123" }) }),
    execute: async (_id, params, signal) => {
      const out = await proteos.stopMachine(params.machine, signal);
      return toolResult(out, { output: out });
    },
  });

  const listTemplates = defineTool({
    name: "proteos_templates_list",
    description: "List the machine templates (types) you can create, e.g. full-stack, go.",
    label: "List templates",
    parameters: Type.Object({}),
    execute: async (_id, _params, signal) => {
      const out = await proteos.listTemplates(signal);
      return toolResult(out, { output: out });
    },
  });

  const listRepos = defineTool({
    name: "proteos_repos_list",
    description:
      "List the GitHub repos (owner/repo) you can clone into a machine. Use a full name from here with proteos_project_ensure.",
    label: "List repos",
    parameters: Type.Object({}),
    execute: async (_id, _params, signal) => {
      const out = await proteos.listRepos(signal);
      return toolResult(out, { output: out });
    },
  });

  // ── Projects ──

  const listProjects = defineTool({
    name: "proteos_projects_list",
    description:
      "List the repos cloned in a machine's /workspace (name, branch, dirty, remote). The 'name' is what you pass as 'project' to task/git commands.",
    label: "List projects",
    parameters: Type.Object({ machine: Type.String() }),
    execute: async (_id, params, signal) => {
      const out = await proteos.listProjects(params.machine, signal);
      return toolResult(out, { output: out });
    },
  });

  const cloneProject = defineTool({
    name: "proteos_project_clone",
    description:
      "Clone owner/repo into a machine's workspace. Asynchronous — returns once dispatched. Prefer proteos_project_ensure, which is idempotent and waits.",
    label: "Clone project",
    parameters: Type.Object({
      machine: Type.String(),
      repo: Type.String({ description: "full name, e.g. octocat/hello-world" }),
    }),
    execute: async (_id, params, signal) => {
      const out = await proteos.cloneProject(params.machine, params.repo, signal);
      return toolResult(out, { output: out });
    },
  });

  const ensureProject = defineTool({
    name: "proteos_project_ensure",
    description:
      "Ensure owner/repo is cloned on a machine, cloning and waiting if needed. Idempotent — call this before proteos_task_run. The project's workspace dir is the repo name (the part after '/').",
    label: "Ensure project",
    parameters: Type.Object({
      machine: Type.String(),
      repo: Type.String({ description: "full name, e.g. octocat/hello-world" }),
    }),
    execute: async (_id, params, signal) => {
      const out = await proteos.ensureProject(params.machine, params.repo, signal);
      return toolResult(out, { output: out });
    },
  });

  // ── Tasks ──

  const taskRun = defineTool({
    name: "proteos_task_run",
    description:
      "Dispatch a headless coding-agent task against a project on a machine, given a natural-language prompt. Always returns immediately with a task id; by default nothing further happens automatically — the agent leaves a dirty working tree and never commits. Set wait:true to have the task tracked in the background and get a proactive notification when it finishes, instead of manually polling with proteos_task_get. Ensure the project exists first (proteos_project_ensure).",
    label: "Run task",
    parameters: Type.Object({
      machine: Type.String(),
      project: Type.String({ description: "workspace directory name (the repo name)" }),
      prompt: Type.String({ description: "what the coding agent should do" }),
      provider: Type.Optional(
        Type.String({
          description: "agent provider (headless lane: claude, pi). Defaults to claude.",
        }),
      ),
      wait: Type.Optional(
        Type.Boolean({
          description:
            "Only set this when the user explicitly asks to wait for or be notified about this task. Tracks it in the background and sends a notification on completion, instead of the default fire-and-forget dispatch.",
        }),
      ),
    }),
    execute: async (_id, params, signal) => {
      const prompt = sanitizePrompt(params.prompt);
      const out = await proteos.taskRun({ ...params, prompt }, signal);
      const taskId = extractTaskId(out);
      // A dispatch changes what a status read would say, so let the new task be
      // checked once immediately (the machine's task list too).
      if (taskId) pollGate.reset(taskKey(params.machine, taskId));
      pollGate.reset(tasksKey(params.machine));
      if (params.wait && opts?.onTaskDispatched && taskId) {
        opts.onTaskDispatched(params.machine, taskId, params.project, prompt.slice(0, 200));
      }
      return toolResult(out, { output: out });
    },
  });

  const listTasks = defineTool({
    name: "proteos_tasks_list",
    description:
      "List a machine's agent tasks, newest first (id, status, provider, project, created). Rate-limited like proteos_task_get — one listing per machine, then a growing wait; it is not a way around the poll backoff.",
    label: "List tasks",
    parameters: Type.Object({ machine: Type.String() }),
    execute: async (_id, params, signal) => {
      const key = tasksKey(params.machine);
      const decision = pollGate.check(key);
      if (!decision.allowed) {
        return throttledResult(`the task list for ${params.machine}`, decision);
      }
      const out = await proteos.tasksList(params.machine, signal);
      pollGate.record(key, out);
      return toolResult(out, { output: out });
    },
  });

  const getTask = defineTool({
    name: "proteos_task_get",
    description:
      "Show one task's status and, when finished, its result (session id, usage/cost, summary, error). A one-off check only: repeated checks of the same task are rate-limited with a growing backoff (1s, 10s, 30s, 90s, 5m) and refused in between, so never loop on this waiting for a task to finish — report the status and end your turn. Use proteos_task_run's wait:true when the user wants to be notified on completion.",
    label: "Get task",
    parameters: Type.Object({
      machine: Type.String(),
      task: Type.String({ description: "task id, e.g. t-456" }),
    }),
    execute: async (_id, params, signal) => {
      const key = taskKey(params.machine, params.task);
      const decision = pollGate.check(key);
      if (!decision.allowed) {
        return throttledResult(`task ${params.task}`, decision);
      }
      const out = await proteos.taskGet(params.machine, params.task, signal);
      pollGate.record(key, out);
      return toolResult(out, { output: out });
    },
  });

  const sendTask = defineTool({
    name: "proteos_task_send",
    description:
      "Send a follow-up turn that resumes a finished task's agent session (e.g. 'now also update the tests'), continuing the same context. Asynchronous — returns once dispatched; report the id and end your turn rather than waiting on proteos_task_get.",
    label: "Send to task",
    parameters: Type.Object({
      machine: Type.String(),
      task: Type.String({ description: "task id, e.g. t-456" }),
      prompt: Type.String(),
    }),
    execute: async (_id, params, signal) => {
      const out = await proteos.taskSend(
        params.machine,
        params.task,
        sanitizePrompt(params.prompt),
        signal,
      );
      // The task is running again — its status is worth one fresh read.
      pollGate.reset(taskKey(params.machine, params.task));
      return toolResult(out, { output: out });
    },
  });

  const cancelTask = defineTool({
    name: "proteos_task_cancel",
    description:
      "Cancel a running task (or all running tasks on the machine with all:true). Partial changes are left in the working tree for review.",
    label: "Cancel task",
    parameters: Type.Object({
      machine: Type.String(),
      task: Type.Optional(Type.String({ description: "task id; omit when all:true" })),
      all: Type.Optional(
        Type.Boolean({ description: "cancel every running/queued task on the machine" }),
      ),
    }),
    execute: async (_id, params, signal) => {
      if (params.all) {
        const out = await proteos.cancelAllTasks(params.machine, signal);
        return toolResult(out, { output: out });
      }
      if (!params.task) {
        return toolResult("Provide a task id, or set all:true to cancel every running task.", {
          output: "",
        });
      }
      const out = await proteos.taskCancel(params.machine, params.task, signal);
      pollGate.reset(taskKey(params.machine, params.task));
      return toolResult(out, { output: out });
    },
  });

  // ── Git (review/land a task's work) ──

  const gitStatus = defineTool({
    name: "proteos_git_status",
    description: "Show a project's working-tree change set (the dirty tree a task leaves behind).",
    label: "Git status",
    parameters: Type.Object({ machine: Type.String(), project: Type.String() }),
    execute: async (_id, params, signal) => {
      const out = await proteos.gitStatus(params.machine, params.project, signal);
      return toolResult(out, { output: out });
    },
  });

  const gitDiff = defineTool({
    name: "proteos_git_diff",
    description: "Show a project's unified diff. Set staged:true for the index (staged) diff.",
    label: "Git diff",
    parameters: Type.Object({
      machine: Type.String(),
      project: Type.String(),
      staged: Type.Optional(Type.Boolean()),
    }),
    execute: async (_id, params, signal) => {
      const out = await proteos.gitDiff(
        params.machine,
        params.project,
        params.staged ?? false,
        signal,
      );
      return toolResult(out, { output: out });
    },
  });

  const gitBranch = defineTool({
    name: "proteos_git_branch",
    description:
      "Create a branch in a project (checked out by default). 'from' is the start point (defaults to HEAD); set noCheckout:true to create without switching.",
    label: "Git branch",
    parameters: Type.Object({
      machine: Type.String(),
      project: Type.String(),
      name: Type.String(),
      from: Type.Optional(Type.String()),
      noCheckout: Type.Optional(Type.Boolean()),
    }),
    execute: async (_id, params, signal) => {
      const out = await proteos.gitBranch(params, signal);
      return toolResult(out, { output: out });
    },
  });

  const gitCommit = defineTool({
    name: "proteos_git_commit",
    description:
      "Stage and commit a project's changes — the explicit review gate (the task agent never commits). Commits all changes, or only the given paths.",
    label: "Git commit",
    parameters: Type.Object({
      machine: Type.String(),
      project: Type.String(),
      message: Type.String(),
      paths: Type.Optional(Type.Array(Type.String())),
    }),
    execute: async (_id, params, signal) => {
      const sanitized = {
        ...params,
        message: sanitizeString(params.message),
        paths: params.paths?.map((p) => sanitizeLine(p)),
      };
      const out = await proteos.gitCommit(sanitized, signal);
      return toolResult(out, { output: out });
    },
  });

  const gitPush = defineTool({
    name: "proteos_git_push",
    description:
      "Push a project's branch to origin. Asynchronous — returns once dispatched. Set setUpstream:true on a new branch's first push.",
    label: "Git push",
    parameters: Type.Object({
      machine: Type.String(),
      project: Type.String(),
      branch: Type.String(),
      setUpstream: Type.Optional(Type.Boolean()),
    }),
    execute: async (_id, params, signal) => {
      const sanitized = {
        ...params,
        machine: sanitizeLine(params.machine),
        project: sanitizeLine(params.project),
        branch: sanitizeLine(params.branch),
      };

      if (opts?.confirmationStore) {
        const lines = [
          `Push branch '${sanitized.branch}' to origin`,
          `  Machine: ${sanitized.machine}, Project: ${sanitized.project}`,
        ];
        if (sanitized.setUpstream) lines.push("  Set upstream: yes");
        const description = lines.join("\n");
        opts.confirmationStore.set(description, (s) => proteos.gitPush(sanitized, s));
        return toolResult(`${description}${CONFIRM_SUFFIX}`, { output: "" }, { terminate: true });
      }

      const out = await proteos.gitPush(sanitized, signal);
      return toolResult(out, { output: out });
    },
  });

  const gitPr = defineTool({
    name: "proteos_git_pr",
    description:
      "Open a pull request for a project from 'head' into 'base' (base defaults to the repo's default branch). The head branch must already be pushed.",
    label: "Git PR",
    parameters: Type.Object({
      machine: Type.String(),
      project: Type.String(),
      head: Type.String(),
      title: Type.String(),
      base: Type.Optional(Type.String()),
      body: Type.Optional(Type.String()),
    }),
    execute: async (_id, params, signal) => {
      const sanitized = {
        ...params,
        machine: sanitizeLine(params.machine),
        project: sanitizeLine(params.project),
        head: sanitizeLine(params.head),
        title: sanitizeLine(params.title),
        base: params.base !== undefined ? sanitizeLine(params.base) : undefined,
        body: params.body !== undefined ? sanitizeString(params.body) : undefined,
      };

      if (opts?.confirmationStore) {
        const base = sanitized.base ?? "default branch";
        const lines = [
          `Open pull request '${sanitized.head}' → ${base}`,
          `  Title: "${sanitized.title}"`,
          `  Machine: ${sanitized.machine}, Project: ${sanitized.project}`,
        ];
        const description = lines.join("\n");
        opts.confirmationStore.set(description, (s) => proteos.gitPr(sanitized, s));
        return toolResult(`${description}${CONFIRM_SUFFIX}`, { output: "" }, { terminate: true });
      }

      const out = await proteos.gitPr(sanitized, signal);
      return toolResult(out, { output: out });
    },
  });

  return [
    listMachines,
    getMachine,
    createMachine,
    startMachine,
    stopMachine,
    listTemplates,
    listRepos,
    listProjects,
    cloneProject,
    ensureProject,
    taskRun,
    listTasks,
    getTask,
    sendTask,
    cancelTask,
    gitStatus,
    gitDiff,
    gitBranch,
    gitCommit,
    gitPush,
    gitPr,
  ];
}
