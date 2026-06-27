import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, toolResult } from "../tool-helpers.ts";
import type { DataboxClient, TrackerTask } from "./databox.ts";

/**
 * Neutral `tracker_*` tools. Linear/Jira vocabulary stays out of the agent so a
 * tracker swap only touches {@link DataboxClient}. The tracker is the source of
 * truth for STATUS; after creating a task the agent records ref+url+rationale in
 * memory via `memory_write type=task` (enforced by the system prompt).
 */
export function buildTrackerTools(databox: DataboxClient): AgentTool[] {
  const render = (task: TrackerTask) =>
    `${task.ref} — ${task.title}${task.status ? ` [${task.status}]` : ""}\n${task.url}`;

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
      return toolResult(render(task), task);
    },
  });

  const searchTasks = defineTool({
    name: "tracker_search_tasks",
    description: "Search tasks in the tracker.",
    label: "Search tasks",
    parameters: Type.Object({ query: Type.String() }),
    execute: async (_id, params, signal) => {
      const tasks = await databox.searchTasks(params.query, 50, signal);
      return toolResult(tasks.map(render).join("\n\n") || "No matches.", tasks);
    },
  });

  const listTasks = defineTool({
    name: "tracker_list_tasks",
    description: "List tasks in the tracker.",
    label: "List tasks",
    parameters: Type.Object({}),
    execute: async (_id, _params, signal) => {
      const tasks = await databox.listTasks(50, signal);
      return toolResult(tasks.map(render).join("\n\n") || "No tasks.", tasks);
    },
  });

  const getTask = defineTool({
    name: "tracker_get_task",
    description: "Get one task by its reference (e.g. ENG-123), including live status.",
    label: "Get task",
    parameters: Type.Object({ ref: Type.String() }),
    execute: async (_id, params, signal) => {
      const task = await databox.getTask(params.ref, 1000, signal);
      return toolResult(render(task), task);
    },
  });

  return [createTask, searchTasks, listTasks, getTask];
}
