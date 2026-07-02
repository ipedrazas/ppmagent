import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, toolResult } from "../tool-helpers.ts";
import type { ProteosClient } from "./proteos.ts";
import { extractTaskId } from "./watcher.ts";

export interface ProteosToolsOptions {
  /** Called after a task is dispatched so the background watcher can track it. */
  onTaskDispatched?: (machine: string, taskId: string, project: string, label: string) => void;
}

/**
 * `proteos_*` tools: delegate coding work to ProteOS, where a headless agent runs
 * against a repo cloned in a firecracker microVM. The control plane owns task
 * status; nothing here is mirrored into memory.
 *
 * Flow: pick a machine (proteos_machines_list) → make sure the repo is on it
 * (proteos_project_ensure) → dispatch (proteos_task_run, returns a task id and
 * does NOT block) → poll (proteos_task_get). Every command takes the machine id
 * explicitly; task/git/project commands also take the project (the repo's
 * workspace directory name).
 *
 * `task watch` (live event stream) is intentionally not exposed: it blocks for up
 * to 30m, which would freeze the chat. Use proteos_task_get to poll instead.
 */
export function buildProteosTools(proteos: ProteosClient, opts?: ProteosToolsOptions): AgentTool[] {
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
      "Dispatch a headless coding-agent task against a project on a machine, given a natural-language prompt. Returns immediately with a task id; it does NOT wait. The agent leaves a dirty working tree and never commits. Poll progress with proteos_task_get. Ensure the project exists first (proteos_project_ensure).",
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
    }),
    execute: async (_id, params, signal) => {
      const out = await proteos.taskRun(params, signal);
      if (opts?.onTaskDispatched) {
        const taskId = extractTaskId(out);
        if (taskId) {
          opts.onTaskDispatched(
            params.machine,
            taskId,
            params.project,
            params.prompt.slice(0, 200),
          );
        }
      }
      return toolResult(out, { output: out });
    },
  });

  const listTasks = defineTool({
    name: "proteos_tasks_list",
    description:
      "List a machine's agent tasks, newest first (id, status, provider, project, created).",
    label: "List tasks",
    parameters: Type.Object({ machine: Type.String() }),
    execute: async (_id, params, signal) => {
      const out = await proteos.tasksList(params.machine, signal);
      return toolResult(out, { output: out });
    },
  });

  const getTask = defineTool({
    name: "proteos_task_get",
    description:
      "Show one task's status and, when finished, its result (session id, usage/cost, summary, error). Use this to poll a task dispatched with proteos_task_run.",
    label: "Get task",
    parameters: Type.Object({
      machine: Type.String(),
      task: Type.String({ description: "task id, e.g. t-456" }),
    }),
    execute: async (_id, params, signal) => {
      const out = await proteos.taskGet(params.machine, params.task, signal);
      return toolResult(out, { output: out });
    },
  });

  const sendTask = defineTool({
    name: "proteos_task_send",
    description:
      "Send a follow-up turn that resumes a finished task's agent session (e.g. 'now also update the tests'), continuing the same context. Asynchronous — returns once dispatched; poll with proteos_task_get.",
    label: "Send to task",
    parameters: Type.Object({
      machine: Type.String(),
      task: Type.String({ description: "task id, e.g. t-456" }),
      prompt: Type.String(),
    }),
    execute: async (_id, params, signal) => {
      const out = await proteos.taskSend(params.machine, params.task, params.prompt, signal);
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
      const out = await proteos.gitCommit(params, signal);
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
      const out = await proteos.gitPush(params, signal);
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
      const out = await proteos.gitPr(params, signal);
      return toolResult(out, { output: out });
    },
  });

  return [
    listMachines,
    getMachine,
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
