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

  const memoryUpdateProject = defineTool({
    name: "memory_update_project",
    description:
      "Edit a project's index frontmatter: lifecycle status, title, tags, tracker link. Tags drive `tag:<t>` scoping of standards and initiatives.",
    label: "Update project",
    parameters: Type.Object({
      project: Type.String({ description: "Project slug." }),
      status: Type.Optional(
        Type.Union([
          Type.Literal("active"),
          Type.Literal("paused"),
          Type.Literal("done"),
          Type.Literal("archived"),
        ]),
      ),
      title: Type.Optional(Type.String()),
      addTags: Type.Optional(
        Type.Array(Type.String(), { description: "Tags to add; drive tag:<t> concern scoping." }),
      ),
      removeTags: Type.Optional(Type.Array(Type.String(), { description: "Tags to remove." })),
      trackerSystem: Type.Optional(Type.String({ description: "e.g. linear|jira." })),
      trackerProject: Type.Optional(Type.String({ description: "Tracker project name." })),
      trackerUrl: Type.Optional(Type.String({ description: "Tracker project URL." })),
    }),
    execute: async (_id, params, signal) => {
      const env = await ppm.projectUpdate(params, signal);
      return toolResult(env.message, env.data);
    },
  });

  const memoryAudit = defineTool({
    name: "memory_audit",
    description:
      "Run the cross-project compliance matrix. With no params: every active standard and initiative over its applies-to scope. Narrow with `standard`/`initiative` (one concern), `tag`/`project` (the project axis), or run an ad-hoc built-in `check`: has-summary | has-focus | decisions-link-tasks | active-has-tracker | no-stale-questions:Nd | freshness:Nd.",
    label: "Audit memory",
    parameters: Type.Object({
      standard: Type.Optional(Type.String({ description: "Run a single standard by id." })),
      initiative: Type.Optional(Type.String({ description: "Run a single initiative by id." })),
      check: Type.Optional(
        Type.String({ description: "Ad-hoc built-in check, e.g. no-stale-questions:14d." }),
      ),
      tag: Type.Optional(Type.String({ description: "Restrict the project axis to this tag." })),
      project: Type.Optional(
        Type.String({ description: "Restrict the project axis to one project." }),
      ),
    }),
    execute: async (_id, params, signal) => {
      const env = await ppm.audit(params, signal);
      return toolResult(env.message, env.data);
    },
  });

  const memoryVerdict = defineTool({
    name: "memory_verdict",
    description:
      "Record a pass/fail judgement for a `manual` standard on one project, with rationale, so audit stops reporting it as `unknown`. Use this after judging semantic standards a built-in check can't.",
    label: "Record verdict",
    parameters: Type.Object({
      standard: Type.String({ description: "The manual standard's id." }),
      project: Type.String({ description: "Project slug." }),
      status: Type.Union([Type.Literal("pass"), Type.Literal("fail")]),
      content: Type.String({ description: "The rationale behind the judgement." }),
    }),
    execute: async (_id, params, signal) => {
      const env = await ppm.verdict(params, signal);
      return toolResult(env.message, env.data);
    },
  });

  const memoryWaive = defineTool({
    name: "memory_waive",
    description:
      "Waive a concern (standard or initiative id) for one project so audit reports `waived` instead of `fail`. The reason is required — an exception you can't justify shouldn't be silently green.",
    label: "Waive concern",
    parameters: Type.Object({
      concern: Type.String({ description: "The concern id being waived." }),
      project: Type.String({ description: "Project slug." }),
      reason: Type.String({ description: "Why the exception is justified." }),
    }),
    execute: async (_id, params, signal) => {
      const env = await ppm.waive(params, signal);
      return toolResult(env.message, env.data);
    },
  });

  const memoryStandard = defineTool({
    name: "memory_standard",
    description:
      "Manage cross-cutting standards (workspace-level invariants). Actions: add (declare; `check` is a built-in id or 'manual' for agent-judged, `appliesTo` is all | tag:<t> | comma-separated slugs), list, show, retire (kept for history, skipped by audit).",
    label: "Manage standards",
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal("add"),
        Type.Literal("list"),
        Type.Literal("show"),
        Type.Literal("retire"),
      ]),
      id: Type.Optional(Type.String({ description: "Standard id; required except for list." })),
      content: Type.Optional(Type.String({ description: "For add: what the standard requires." })),
      title: Type.Optional(Type.String()),
      check: Type.Optional(
        Type.String({ description: "For add: built-in check id, or 'manual' (default)." }),
      ),
      severity: Type.Optional(
        Type.Union([Type.Literal("info"), Type.Literal("warn"), Type.Literal("block")]),
      ),
      appliesTo: Type.Optional(
        Type.String({ description: "For add: all | tag:<t> | comma-separated slugs." }),
      ),
    }),
    execute: async (_id, params, signal) => {
      const env = await ppm.standard(params, signal);
      return toolResult(env.message, env.data);
    },
  });

  const memoryInitiative = defineTool({
    name: "memory_initiative",
    description:
      "Manage cross-project initiatives (campaigns spanning projects). Actions: add (declare, with `appliesTo` scope), bind (link a member project via a backlinked task; needs `project`, `ref`, `content`), list, show (per-member bound/unbound rollup), update (status).",
    label: "Manage initiatives",
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal("add"),
        Type.Literal("bind"),
        Type.Literal("list"),
        Type.Literal("show"),
        Type.Literal("update"),
      ]),
      id: Type.Optional(Type.String({ description: "Initiative id; required except for list." })),
      content: Type.Optional(
        Type.String({
          description: "For add: the campaign's intent. For bind: the member task's rationale.",
        }),
      ),
      title: Type.Optional(Type.String()),
      appliesTo: Type.Optional(
        Type.String({ description: "For add: all | tag:<t> | comma-separated slugs." }),
      ),
      status: Type.Optional(
        Type.Union([Type.Literal("active"), Type.Literal("paused"), Type.Literal("done")], {
          description: "For update.",
        }),
      ),
      project: Type.Optional(Type.String({ description: "For bind: the project to bind." })),
      ref: Type.Optional(
        Type.String({ description: "For bind: tracker reference for the member task." }),
      ),
      url: Type.Optional(Type.String({ description: "For bind: tracker URL." })),
    }),
    execute: async (_id, params, signal) => {
      const env = await ppm.initiative(params, signal);
      return toolResult(env.message, env.data);
    },
  });

  return [
    memoryList,
    memoryRead,
    memorySearch,
    memoryCreateProject,
    memoryWrite,
    memoryUpdateProject,
    memoryAudit,
    memoryVerdict,
    memoryWaive,
    memoryStandard,
    memoryInitiative,
  ];
}
