import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, toolResult } from "../tool-helpers.ts";
import { CONFIRM_SUFFIX, type ConfirmationStore } from "../tools/confirmation.ts";
import { sanitizeLine, sanitizeString } from "../tools/sanitize.ts";
import {
  type DataboxClient,
  type DataboxRow,
  type IssueMutationResult,
  type ProjectMutationResult,
  taskRef,
} from "./databox.ts";

export interface TrackerToolsOptions {
  /** When set, create/update operations require user confirmation before executing. */
  confirmationStore?: ConfirmationStore;
}

/**
 * Neutral `tracker_*` tools. Linear/Jira vocabulary stays out of the tool names
 * so a tracker swap only touches {@link DataboxClient}. The client passes the
 * datasource's rows through verbatim; these renderers read whatever fields are
 * present (so a re-added `title`/`status` shows up with no change here) and
 * degrade gracefully when one is missing. The tracker is the source of truth for
 * STATUS; after creating a task the agent records ref+url+rationale in memory via
 * `memory_write type=task` (enforced by the system prompt).
 *
 * Entities: tasks (issues) and projects are read+write; teams are read-only
 * reference data (used to resolve the team for project creation).
 */
export function buildTrackerTools(databox: DataboxClient, opts?: TrackerToolsOptions): AgentTool[] {
  /** Coerce an unknown field to a display string ("" when absent/non-string). */
  const str = (v: unknown): string => (typeof v === "string" ? v : v == null ? "" : String(v));

  /** Compact one-liner for a task row: `REF — title [status]` + url. */
  const renderTask = (row: DataboxRow): string => {
    const head = [taskRef(row), str(row.title)].filter(Boolean).join(" — ") || "(issue)";
    const status = str(row.status);
    return `${head}${status ? ` [${status}]` : ""}\n${str(row.url)}`;
  };

  /** Fuller view for a single task: adds team/project/assignee context + description. */
  const renderTaskDetail = (row: DataboxRow): string => {
    const head = [taskRef(row), str(row.title)].filter(Boolean).join(" — ") || "(issue)";
    const status = str(row.status);
    const lines = [`${head}${status ? ` [${status}]` : ""}`];
    const ctx: string[] = [];
    if (str(row.team)) ctx.push(`team ${str(row.team)}`);
    if (str(row.project)) ctx.push(`project ${str(row.project)}`);
    if (str(row.assignee)) ctx.push(`assignee ${str(row.assignee)}`);
    if (ctx.length) lines.push(ctx.join(" · "));
    if (str(row.url)) lines.push(str(row.url));
    if (str(row.description)) lines.push("", str(row.description));
    return lines.join("\n");
  };

  const renderIssueMutation = (r: IssueMutationResult): string => `${r.identifier}\n${r.url}`;

  const renderProject = (row: DataboxRow): string => {
    const bits: string[] = [];
    if (str(row.status)) bits.push(`[${str(row.status)}]`);
    if (typeof row.progress === "number") bits.push(`${Math.round(row.progress * 100)}%`);
    const teams = Array.isArray(row.teams) ? row.teams.map(str).filter(Boolean) : [];
    if (teams.length) bits.push(teams.join(","));
    const meta = bits.filter(Boolean).join(" ");
    return `${str(row.name)}${meta ? ` ${meta}` : ""}\nid: ${str(row.id)}\n${str(row.url)}`;
  };

  const renderProjectMutation = (r: ProjectMutationResult): string =>
    `${r.name}${r.state ? ` [${r.state}]` : ""}\nid: ${r.project_id}\n${r.url}`;

  const renderTeam = (row: DataboxRow): string =>
    `${str(row.key)} — ${str(row.name)}${str(row.description) ? `\n${str(row.description)}` : ""}\nid: ${str(row.id)}`;

  // ── Tasks (issues) ──

  const createTask = defineTool({
    name: "tracker_create_task",
    description:
      "Create a task in the tracker. Returns the human reference (e.g. ENG-123) and URL. Optionally file it under a project (project_id), assign it (assignee_id), label it (label_ids), or set priority (0 none, 1 urgent, 2 high, 3 medium, 4 low). AFTER this, record the rationale in memory with memory_write type=task.",
    label: "Create task",
    parameters: Type.Object({
      title: Type.String(),
      description: Type.String(),
      project_id: Type.Optional(Type.String()),
      assignee_id: Type.Optional(Type.String()),
      label_ids: Type.Optional(Type.Array(Type.String())),
      priority: Type.Optional(Type.Integer({ minimum: 0, maximum: 4 })),
    }),
    execute: async (_id, params, signal) => {
      const sanitized = {
        ...params,
        title: sanitizeLine(params.title),
        description: sanitizeString(params.description),
      };

      if (opts?.confirmationStore) {
        const preview = sanitized.description.slice(0, 120);
        const lines = [
          "Create task",
          `  Title: "${sanitized.title}"`,
          `  Description: ${preview}${sanitized.description.length > 120 ? "…" : ""}`,
        ];
        const description = lines.join("\n");
        opts.confirmationStore.set(description, async (s) => {
          const r = await databox.createTask(sanitized, { signal: s });
          return renderIssueMutation(r);
        });
        return toolResult(
          `${description}${CONFIRM_SUFFIX}`,
          { identifier: "", issue_id: "", url: "" },
          { terminate: true },
        );
      }

      const result = await databox.createTask(sanitized, { signal });
      return toolResult(renderIssueMutation(result), result);
    },
  });

  const updateTask = defineTool({
    name: "tracker_update_task",
    description:
      "Update a task by its reference (e.g. ENG-123). Only the fields you pass change. Move it to a workflow state (status, e.g. Todo, In Progress, Done), file it under a project (project_id), reassign (assignee_id), replace labels (label_ids), or set priority (0 none, 1 urgent, 2 high, 3 medium, 4 low).",
    label: "Update task",
    parameters: Type.Object({
      ref: Type.String(),
      title: Type.Optional(Type.String()),
      description: Type.Optional(Type.String()),
      status: Type.Optional(
        Type.String({ description: "workflow state name, e.g. Todo, In Progress, Done" }),
      ),
      project_id: Type.Optional(Type.String()),
      assignee_id: Type.Optional(Type.String()),
      label_ids: Type.Optional(Type.Array(Type.String())),
      priority: Type.Optional(Type.Integer({ minimum: 0, maximum: 4 })),
    }),
    execute: async (_id, params, signal) => {
      const sanitized = {
        ...params,
        ref: sanitizeLine(params.ref),
        title: params.title !== undefined ? sanitizeLine(params.title) : undefined,
        description:
          params.description !== undefined ? sanitizeString(params.description) : undefined,
        status: params.status !== undefined ? sanitizeLine(params.status) : undefined,
      };

      if (opts?.confirmationStore) {
        const changes: string[] = [];
        if (sanitized.title) changes.push(`  Title: "${sanitized.title}"`);
        if (sanitized.status) changes.push(`  Status: ${sanitized.status}`);
        if (sanitized.description) changes.push("  Description: (updated)");
        if (sanitized.project_id) changes.push(`  Project: ${sanitized.project_id}`);
        if (sanitized.assignee_id) changes.push(`  Assignee: ${sanitized.assignee_id}`);
        const description = [`Update task ${sanitized.ref}`, ...changes].join("\n");
        opts.confirmationStore.set(description, async (s) => {
          const r = await databox.updateTask(sanitized, { signal: s });
          return renderIssueMutation(r);
        });
        return toolResult(
          `${description}${CONFIRM_SUFFIX}`,
          { identifier: "", issue_id: "", url: "" },
          { terminate: true },
        );
      }

      const result = await databox.updateTask(sanitized, { signal });
      return toolResult(renderIssueMutation(result), result);
    },
  });

  const searchTasks = defineTool({
    name: "tracker_search_tasks",
    description: "Search tasks in the tracker.",
    label: "Search tasks",
    parameters: Type.Object({ query: Type.String() }),
    execute: async (_id, params, signal) => {
      const tasks = await databox.searchTasks(params.query, 50, signal);
      return toolResult(tasks.map(renderTask).join("\n\n") || "No matches.", tasks);
    },
  });

  const listTasks = defineTool({
    name: "tracker_list_tasks",
    description:
      "List tasks in the tracker. Optionally narrow with filters, each a 'field<op>value' clause AND-combined by the tracker. Operators: = (eq), != (ne), ~ (contains), !~ (ncontains), > (gt), < (lt), 'in'/'nin' for comma lists. Examples: 'status=Done', 'status!=Canceled', 'project_id=<uuid>', 'labels in bug,urgent'.",
    label: "List tasks",
    parameters: Type.Object({
      filters: Type.Optional(Type.Array(Type.String())),
    }),
    execute: async (_id, params, signal) => {
      const tasks = await databox.listTasks(50, params.filters ?? [], signal);
      return toolResult(tasks.map(renderTask).join("\n\n") || "No tasks.", tasks);
    },
  });

  const getTask = defineTool({
    name: "tracker_get_task",
    description:
      "Get one task by its reference (e.g. ENG-123), including any fields the tracker projects (team, project, assignee, description, and live status when available).",
    label: "Get task",
    parameters: Type.Object({ ref: Type.String() }),
    execute: async (_id, params, signal) => {
      const task = await databox.getTask(params.ref, signal);
      return toolResult(renderTaskDetail(task), task);
    },
  });

  // ── Projects ──

  const listProjects = defineTool({
    name: "tracker_list_projects",
    description: "List projects in the tracker, with their state, progress, and owning team(s).",
    label: "List projects",
    parameters: Type.Object({}),
    execute: async (_id, _params, signal) => {
      const projects = await databox.listProjects(50, signal);
      return toolResult(projects.map(renderProject).join("\n\n") || "No projects.", projects);
    },
  });

  const getProject = defineTool({
    name: "tracker_get_project",
    description:
      "Get one project by its name or id, including its id (needed to update it), state, and progress.",
    label: "Get project",
    parameters: Type.Object({ ref: Type.String() }),
    execute: async (_id, params, signal) => {
      const project = await databox.getProject(params.ref, 1000, signal);
      return toolResult(renderProject(project), project);
    },
  });

  const createProject = defineTool({
    name: "tracker_create_project",
    description:
      "Create a project. 'team' is the owning team key (e.g. TAV) or its id — list teams first if unsure. 'state' is one of backlog, planned, started, paused, completed, canceled.",
    label: "Create project",
    parameters: Type.Object({
      name: Type.String(),
      team: Type.String(),
      description: Type.Optional(Type.String()),
      lead: Type.Optional(Type.String()),
      state: Type.Optional(Type.String()),
    }),
    execute: async (_id, params, signal) => {
      const sanitized = {
        ...params,
        name: sanitizeLine(params.name),
        team: sanitizeLine(params.team),
        description:
          params.description !== undefined ? sanitizeString(params.description) : undefined,
        state: params.state !== undefined ? sanitizeLine(params.state) : undefined,
      };

      if (opts?.confirmationStore) {
        const lines = [
          "Create project",
          `  Name: "${sanitized.name}"`,
          `  Team: ${sanitized.team}`,
        ];
        if (sanitized.state) lines.push(`  State: ${sanitized.state}`);
        const description = lines.join("\n");
        opts.confirmationStore.set(description, async (s) => {
          const r = await databox.createProject(sanitized, { signal: s });
          return renderProjectMutation(r);
        });
        return toolResult(
          `${description}${CONFIRM_SUFFIX}`,
          { name: "", project_id: "", url: "" },
          { terminate: true },
        );
      }

      const result = await databox.createProject(sanitized, { signal });
      return toolResult(renderProjectMutation(result), result);
    },
  });

  const updateProject = defineTool({
    name: "tracker_update_project",
    description:
      "Update a project by its id (get the id via tracker_get_project / tracker_list_projects). Only the fields you pass are changed. 'state' is one of backlog, planned, started, paused, completed, canceled.",
    label: "Update project",
    parameters: Type.Object({
      id: Type.String(),
      name: Type.Optional(Type.String()),
      description: Type.Optional(Type.String()),
      lead: Type.Optional(Type.String()),
      state: Type.Optional(Type.String()),
    }),
    execute: async (_id, params, signal) => {
      const sanitized = {
        ...params,
        id: sanitizeLine(params.id),
        name: params.name !== undefined ? sanitizeLine(params.name) : undefined,
        description:
          params.description !== undefined ? sanitizeString(params.description) : undefined,
        state: params.state !== undefined ? sanitizeLine(params.state) : undefined,
      };

      if (opts?.confirmationStore) {
        const changes: string[] = [];
        if (sanitized.name) changes.push(`  Name: "${sanitized.name}"`);
        if (sanitized.state) changes.push(`  State: ${sanitized.state}`);
        if (sanitized.description) changes.push("  Description: (updated)");
        const description = [`Update project ${sanitized.id}`, ...changes].join("\n");
        opts.confirmationStore.set(description, async (s) => {
          const r = await databox.updateProject(sanitized, { signal: s });
          return renderProjectMutation(r);
        });
        return toolResult(
          `${description}${CONFIRM_SUFFIX}`,
          { name: "", project_id: "", url: "" },
          { terminate: true },
        );
      }

      const result = await databox.updateProject(sanitized, { signal });
      return toolResult(renderProjectMutation(result), result);
    },
  });

  // ── Teams (read-only reference) ──

  const listTeams = defineTool({
    name: "tracker_list_teams",
    description:
      "List teams (read-only reference). Use a team's key or id when creating a project.",
    label: "List teams",
    parameters: Type.Object({}),
    execute: async (_id, _params, signal) => {
      const teams = await databox.listTeams(50, signal);
      return toolResult(teams.map(renderTeam).join("\n\n") || "No teams.", teams);
    },
  });

  const getTeam = defineTool({
    name: "tracker_get_team",
    description: "Get one team by its key (e.g. TAV), name, or id.",
    label: "Get team",
    parameters: Type.Object({ ref: Type.String() }),
    execute: async (_id, params, signal) => {
      const team = await databox.getTeam(params.ref, 1000, signal);
      return toolResult(renderTeam(team), team);
    },
  });

  return [
    createTask,
    updateTask,
    searchTasks,
    listTasks,
    getTask,
    listProjects,
    getProject,
    createProject,
    updateProject,
    listTeams,
    getTeam,
  ];
}
