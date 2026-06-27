import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, toolResult } from "../tool-helpers.ts";
import { type PpmClient, buildWriteArgs } from "./ppm.ts";

/**
 * The closed set of writable entry types. Enforced in the tool schema so the
 * model literally cannot name an off-list type (the anti-dumping-ground rule).
 */
const WriteType = Type.Union([
  Type.Literal("summary"),
  Type.Literal("focus"),
  Type.Literal("decision"),
  Type.Literal("question"),
  Type.Literal("task"),
  Type.Literal("note"),
  Type.Literal("conversation"),
]);

/**
 * Build the `memory_*` tools as thin wrappers over {@link PpmClient}. Each maps
 * one neutral tool onto one `ppm` command (see plans/implementation-plan.md §4).
 * The visible tool result is ppm's human-readable `message`; `details` carries
 * the structured payload for programmatic use.
 */
export function buildMemoryTools(ppm: PpmClient): AgentTool[] {
  const memoryList = defineTool({
    name: "memory_list",
    description:
      "Orient over memory cheaply. With no project: list all projects. With a project: return its shape (entry inventory, no content). Call this before reading.",
    label: "List memory",
    parameters: Type.Object({
      project: Type.Optional(
        Type.String({ description: "Project slug. Omit to list all projects." }),
      ),
    }),
    execute: async (_id, params, signal) => {
      const env = params.project
        ? await ppm.projectShow(params.project, signal)
        : await ppm.projectList(signal);
      return toolResult(env.message, env.data);
    },
  });

  const memoryRead = defineTool({
    name: "memory_read",
    description:
      "Read full entry content. Omit `project` for the workspace index; omit `type`/`name` for the project index.",
    label: "Read memory",
    parameters: Type.Object({
      project: Type.Optional(Type.String()),
      type: Type.Optional(Type.String()),
      name: Type.Optional(Type.String()),
    }),
    execute: async (_id, params, signal) => {
      const env = await ppm.read(params.project, { type: params.type, name: params.name }, signal);
      return toolResult(env.message, env.data);
    },
  });

  const memorySearch = defineTool({
    name: "memory_search",
    description: "Full-text search across all memory; returns matches with provenance.",
    label: "Search memory",
    parameters: Type.Object({
      query: Type.String({ description: "Free-text query." }),
    }),
    execute: async (_id, params, signal) => {
      const env = await ppm.search(params.query, signal);
      return toolResult(env.message, env.data);
    },
  });

  const memoryCreateProject = defineTool({
    name: "memory_create_project",
    description: "Create a new project; scaffolds its index/summary/focus.",
    label: "Create project",
    parameters: Type.Object({
      slug: Type.String({ description: "Stable kebab-case key." }),
      title: Type.String(),
    }),
    execute: async (_id, params, signal) => {
      const env = await ppm.projectCreate(params.slug, params.title, signal);
      return toolResult(env.message, env.data);
    },
  });

  const memoryWrite = defineTool({
    name: "memory_write",
    description:
      "Type-addressable write to memory. Stores WHY (rationale), never live tracker status. `type` must be in the closed set. Singletons (summary/focus) replace; collections create; a question with `resolve:true` flips its status.",
    label: "Write memory",
    parameters: Type.Object({
      project: Type.String(),
      type: WriteType,
      content: Type.String(),
      name: Type.Optional(
        Type.String({ description: "Entry name; required to resolve a question." }),
      ),
      resolve: Type.Optional(
        Type.Boolean({ description: "For type=question: resolve instead of add." }),
      ),
      ref: Type.Optional(
        Type.String({ description: "For type=task: the tracker reference, e.g. ENG-123." }),
      ),
      url: Type.Optional(Type.String({ description: "For type=task: the tracker URL." })),
    }),
    execute: async (_id, params, signal) => {
      const env = await ppm.write(buildWriteArgs(params), signal);
      return toolResult(env.message, env.data);
    },
  });

  return [memoryList, memoryRead, memorySearch, memoryCreateProject, memoryWrite];
}
