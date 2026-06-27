import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, toolResult } from "../tool-helpers.ts";
import type { DataboxClient, TrackerProject, TrackerTask, TrackerTeam } from "./databox.ts";

/**
 * Neutral `tracker_*` tools. Linear/Jira vocabulary stays out of the agent so a
 * tracker swap only touches {@link DataboxClient}. The tracker is the source of
 * truth for STATUS; after creating a task the agent records ref+url+rationale in
 * memory via `memory_write type=task` (enforced by the system prompt).
 *
 * Entities: tasks (issues) and projects are read+write; teams are read-only
 * reference data (used to resolve the team for project creation).
 */
export function buildTrackerTools(databox: DataboxClient): AgentTool[] {
  const renderTask = (task: TrackerTask) =>
    `${task.ref} — ${task.title}${task.status ? ` [${task.status}]` : ""}\n${task.url}`;

  const renderProject = (project: TrackerProject) => {
    const bits = [project.status ? `[${project.status}]` : ""];
    if (typeof project.progress === "number") bits.push(`${Math.round(project.progress * 100)}%`);
    if (project.teams?.length) bits.push(project.teams.join(","));
    const meta = bits.filter(Boolean).join(" ");
    return `${project.name}${meta ? ` ${meta}` : ""}\nid: ${project.id}\n${project.url}`;
  };

  const renderTeam = (team: TrackerTeam) =>
    `${team.key} — ${team.name}${team.description ? `\n${team.description}` : ""}\nid: ${team.id}`;

  // ── Tasks (issues) ──

  const createTask = defineTool({
    name: "tracker_create_task",
    description:
      "Create a task in the tracker. Returns the human reference (e.g. ENG-123) and URL. AFTER this, record the rationale in memory with memory_write type=task.",
    label: "Create task",
    parameters: Type.Object({
      title: Type.String(),
      description: Type.String(),
    }),
    execute: async (_id, params, signal) => {
      const task = await databox.createTask(params, { signal });
      return toolResult(renderTask(task), task);
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
    description: "Get one task by its reference (e.g. ENG-123), including live status.",
    label: "Get task",
    parameters: Type.Object({ ref: Type.String() }),
    execute: async (_id, params, signal) => {
      const task = await databox.getTask(params.ref, 1000, signal);
      return toolResult(renderTask(task), task);
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
      const project = await databox.createProject(params, { signal });
      return toolResult(renderProject(project), project);
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
      const project = await databox.updateProject(params, { signal });
      return toolResult(renderProject(project), project);
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
