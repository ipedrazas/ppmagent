import { execCommand } from "../exec.ts";
import { type Logger, nullLogger } from "../logger.ts";
import { validateFilter, validateRef, validateSearchQuery } from "../sanitize.ts";

export interface DataboxClientOptions {
  /** `dbxcli` binary (path or name on PATH). */
  bin: string;
  /** dbxcli config file (DataboxPPM endpoint + auth). Empty = dbxcli default. */
  config: string;
  /** Logger; defaults to the discarding logger so the client stays test-quiet. */
  logger?: Logger;
  /** Cap combined subprocess output (stdout+stderr) at this many bytes. 0 = unlimited. */
  maxOutputBytes?: number;
}

/**
 * One row of a Databox dataset, passed through verbatim. The datasource owns the
 * field set (it has evolved over time and will again), so the client does NOT
 * rename or restrict fields into a fixed neutral struct — it surfaces what the
 * datasource projects and lets the tool layer render whatever is present. New
 * fields (or a re-added `title`/`status`) therefore appear with no code change.
 */
export type DataboxRow = Record<string, unknown>;

export interface CreateTaskInput {
  title: string;
  description: string;
  /**
   * Optional team id. Normally omitted: Databox pins `team_id` on the action and
   * injects/overrides it on real creates. Only needed to satisfy the `--simulated`
   * path (the simulator validates params but does not apply pins).
   */
  team?: string;
  /** Optional project id. When provided the issue is created under that project. */
  project_id?: string;
  /** Optional assignee user UUID. */
  assignee_id?: string;
  /** Optional label UUIDs to apply. */
  label_ids?: string[];
  /** Optional priority: 0 none, 1 urgent, 2 high, 3 medium, 4 low. */
  priority?: number;
}

export interface UpdateTaskInput {
  /** UUID or human identifier (e.g. ENG-123) of the issue to update. */
  ref: string;
  title?: string;
  description?: string;
  /** Workflow state name to move the issue to (e.g. Todo, In Progress, Done). */
  status?: string;
  assignee_id?: string;
  /** Label UUIDs (replaces the existing set). */
  label_ids?: string[];
  priority?: number;
  /** Move the issue under this project UUID. */
  project_id?: string;
}

export interface CreateProjectInput {
  name: string;
  /**
   * The owning team: either a team key (e.g. "TAV") or its UUID. A key is
   * resolved to the UUID via the teams dataset before the action is invoked.
   */
  team: string;
  description?: string;
  /** UUID of the user to set as project lead. */
  lead?: string;
  /** Initial state: backlog | planned | started | paused | completed | canceled. */
  state?: string;
}

export interface UpdateProjectInput {
  /** UUID of the project to update. */
  id: string;
  name?: string;
  description?: string;
  /** UUID of the user to set as project lead. */
  lead?: string;
  /** New state: backlog | planned | started | paused | completed | canceled. */
  state?: string;
}

// ── Raw dbxcli envelope + action result shapes ──

interface ListResponse<T> {
  items: T[];
  meta?: { total?: number; limit?: number; offset?: number };
}

/** `action invoke` envelope: the action result lives under `result`. */
interface InvokeResponse<T> {
  metadata?: { simulated?: boolean; replayed?: boolean };
  result: T;
}

/** Result of the `create_issue` / `update_issue` actions. */
export interface IssueMutationResult {
  identifier: string;
  issue_id: string;
  url: string;
}

/** Result of the `create_project` / `update_project` actions. */
export interface ProjectMutationResult {
  name: string;
  project_id: string;
  url: string;
  state?: string;
}

/** One entry of `dbxcli datasets` — the alias + its neutral `data_kind`. */
interface DatasetMeta {
  alias: string;
  /** Neutral kind: "issues" | "projects" | "teams". Null for some datasets (e.g. teams). */
  data_kind?: string | null;
  name?: string;
}

/** One entry of `dbxcli action list` — the alias + its neutral `action_type`. */
interface ActionMeta {
  alias: string;
  /** Neutral type, e.g. "create_issue" | "update_issue" | "create_project". */
  action_type: string;
}

/** The two discovery responses, cached once per client. */
interface DataboxCatalog {
  datasets: DatasetMeta[];
  actions: ActionMeta[];
}

export class DataboxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DataboxError";
  }
}

// ── Pure helpers ──

/** RFC-4122 UUID matcher; lets a team/project reference accept a key/name or a raw UUID. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

/**
 * Extract the human identifier (e.g. TAV-9) from a Linear issue URL like
 * `https://linear.app/tavon/issue/TAV-9/...`. The issues dataset no longer
 * projects an `identifier` field, so the ref is recovered from the URL. Returns
 * "" when no ref can be parsed.
 */
export function refFromUrl(url: unknown): string {
  if (typeof url !== "string") return "";
  const match = url.match(/\/issue\/([A-Za-z0-9]+-\d+)/);
  return match?.[1] ?? "";
}

/**
 * The human reference for an issue row: the projected `identifier` if the
 * datasource still provides one, else parsed from the URL, else the raw id.
 */
export function taskRef(row: DataboxRow): string {
  const identifier = typeof row.identifier === "string" ? row.identifier : "";
  if (identifier) return identifier;
  const fromUrl = refFromUrl(row.url);
  if (fromUrl) return fromUrl;
  return typeof row.id === "string" ? row.id : "";
}

/**
 * Build the `create_issue` action params. Pure. `team_id` is sent only when an
 * explicit override is given; otherwise Databox pins/injects it server-side.
 */
export function buildCreateParams(input: CreateTaskInput): {
  title: string;
  team_id?: string;
  description?: string;
  project_id?: string;
  assignee_id?: string;
  label_ids?: string[];
  priority?: number;
} {
  const params: {
    title: string;
    team_id?: string;
    description?: string;
    project_id?: string;
    assignee_id?: string;
    label_ids?: string[];
    priority?: number;
  } = { title: input.title };
  if (input.team) params.team_id = input.team;
  if (input.description) params.description = input.description;
  if (input.project_id) params.project_id = input.project_id;
  if (input.assignee_id) params.assignee_id = input.assignee_id;
  if (input.label_ids && input.label_ids.length > 0) params.label_ids = input.label_ids;
  if (typeof input.priority === "number") params.priority = input.priority;
  return params;
}

/** Build the `update_issue` action params. Pure. Only provided fields are sent. */
export function buildUpdateTaskParams(input: UpdateTaskInput): {
  issue_id: string;
  title?: string;
  description?: string;
  status?: string;
  assignee_id?: string;
  label_ids?: string[];
  priority?: number;
  project_id?: string;
} {
  const params: {
    issue_id: string;
    title?: string;
    description?: string;
    status?: string;
    assignee_id?: string;
    label_ids?: string[];
    priority?: number;
    project_id?: string;
  } = { issue_id: input.ref };
  if (input.title) params.title = input.title;
  if (input.description) params.description = input.description;
  if (input.status) params.status = input.status;
  if (input.assignee_id) params.assignee_id = input.assignee_id;
  if (input.label_ids && input.label_ids.length > 0) params.label_ids = input.label_ids;
  if (typeof input.priority === "number") params.priority = input.priority;
  if (input.project_id) params.project_id = input.project_id;
  return params;
}

/**
 * Build the `create_project` action params. Pure. `team_id` must already be the
 * resolved team UUID (callers resolve a team key via the teams dataset first).
 */
export function buildCreateProjectParams(
  input: CreateProjectInput,
  teamId: string,
): { name: string; team_id: string; description?: string; lead_id?: string; state?: string } {
  const params: {
    name: string;
    team_id: string;
    description?: string;
    lead_id?: string;
    state?: string;
  } = { name: input.name, team_id: teamId };
  if (input.description) params.description = input.description;
  if (input.lead) params.lead_id = input.lead;
  if (input.state) params.state = input.state;
  return params;
}

/** Build the `update_project` action params. Pure. Only provided fields are sent. */
export function buildUpdateProjectParams(input: UpdateProjectInput): {
  project_id: string;
  name?: string;
  description?: string;
  lead_id?: string;
  state?: string;
} {
  const params: {
    project_id: string;
    name?: string;
    description?: string;
    lead_id?: string;
    state?: string;
  } = { project_id: input.id };
  if (input.name) params.name = input.name;
  if (input.description) params.description = input.description;
  if (input.lead) params.lead_id = input.lead;
  if (input.state) params.state = input.state;
  return params;
}

/**
 * Thin wrapper over the `dbxcli` CLI, which fronts the DataboxPPM datasource.
 * pi has no MCP client, so this is how the agent reaches the tracker.
 *
 * Following the {@link import("../proteos/proteos.ts").ProteosClient} pattern,
 * this surfaces the datasource's own rows rather than projecting them into a
 * renamed neutral struct: the datasource owns the field set and it evolves, so a
 * fixed mapping silently goes stale (it once assumed `identifier`/`title`/`status`
 * fields the issues dataset no longer projects). The tool layer renders whatever
 * fields are present. Reads never mirror status into memory — the tracker is the
 * source of truth.
 *
 * Entities: tasks (issues) and projects are read+write; teams are read-only.
 *
 * Dataset and action aliases are NOT configured: they are discovered from the
 * dbxcli config (via `dbxcli datasets` / `dbxcli action list`) and resolved by
 * their neutral `data_kind` / `action_type`, then cached for the client's life.
 *
 * Verified surface (against the live datasource):
 *   list/search   → `{ items: T[], meta }`
 *   get           → a single row object, keyed by id OR human identifier
 *   action invoke → `{ metadata, result }` — result shape varies per action
 */
export class DataboxClient {
  private readonly log: Logger;
  /** Lazily-loaded, cached discovery of dataset + action aliases. */
  private catalogPromise?: Promise<DataboxCatalog>;

  constructor(private readonly opts: DataboxClientOptions) {
    this.log = (opts.logger ?? nullLogger).child().withContext({ component: "databox" });
  }

  private baseArgs(): string[] {
    const args = ["--format", "json"];
    if (this.opts.config) args.push("--config", this.opts.config);
    return args;
  }

  /**
   * Discover dataset + action aliases from the dbxcli config, once. The result is
   * cached for the client's lifetime; a failed load is not cached, so a transient
   * error (e.g. an aborted call) can be retried.
   */
  private async catalog(signal?: AbortSignal): Promise<DataboxCatalog> {
    if (!this.catalogPromise) {
      this.catalogPromise = Promise.all([
        this.run<{ datasets?: DatasetMeta[] }>(["datasets"], signal),
        this.run<{ items?: ActionMeta[] }>(["action", "list"], signal),
      ])
        .then(([ds, ac]) => ({ datasets: ds.datasets ?? [], actions: ac.items ?? [] }))
        .catch((error) => {
          this.catalogPromise = undefined;
          throw error;
        });
    }
    return this.catalogPromise;
  }

  /**
   * Resolve a dataset alias by its neutral kind ("issues" | "projects" | "teams").
   * Matches `data_kind` first; falls back to the alias/name for datasets that omit
   * `data_kind` (the teams dataset does).
   */
  private async datasetAlias(kind: "issues" | "projects" | "teams", signal?: AbortSignal) {
    const { datasets } = await this.catalog(signal);
    const match =
      datasets.find((d) => d.data_kind === kind) ??
      datasets.find((d) => d.alias?.toLowerCase() === kind) ??
      datasets.find((d) => (d.name ?? "").toLowerCase().includes(kind));
    if (!match?.alias) {
      const available = datasets.map((d) => d.alias).join(", ") || "none";
      throw new DataboxError(`no dataset found for "${kind}" (available aliases: ${available})`);
    }
    return match.alias;
  }

  /** Resolve an action alias by its neutral `action_type`. */
  private async actionAlias(
    type: "create_issue" | "update_issue" | "create_project" | "update_project",
    signal?: AbortSignal,
  ) {
    const { actions } = await this.catalog(signal);
    const match = actions.find((a) => a.action_type === type);
    if (!match?.alias) {
      const available = actions.map((a) => a.action_type).join(", ") || "none";
      throw new DataboxError(`no action found for "${type}" (available types: ${available})`);
    }
    return match.alias;
  }

  /** Run a dbxcli subcommand and parse its JSON stdout. */
  private async run<T>(args: string[], signal?: AbortSignal): Promise<T> {
    const result = await execCommand(this.opts.bin, [...this.baseArgs(), ...args], {
      signal,
      logger: this.log,
      maxOutputBytes: this.opts.maxOutputBytes,
    });
    if (result.exitCode !== 0) {
      const message =
        result.stderr.trim() || result.stdout.trim() || `dbxcli exited ${result.exitCode}`;
      this.log.withMetadata({ args, exitCode: result.exitCode }).warn("dbxcli returned an error");
      throw new DataboxError(message);
    }
    try {
      return JSON.parse(result.stdout) as T;
    } catch (error) {
      this.log.withError(error).withMetadata({ args }).error("dbxcli output was not valid JSON");
      throw new DataboxError(`dbxcli output was not valid JSON: ${result.stdout.slice(0, 200)}`);
    }
  }

  // ── Tasks (issues) ──

  /**
   * List tasks. `filters` are passed through verbatim as repeated `--filter`
   * clauses (e.g. `status=Done`, `status!=Canceled`, `labels in bug,urgent`,
   * `project_id=<uuid>`); they are AND-combined by the datasource.
   */
  async listTasks(limit = 50, filters: string[] = [], signal?: AbortSignal): Promise<DataboxRow[]> {
    const dataset = await this.datasetAlias("issues", signal);
    const args = ["list", dataset, "--limit", String(limit)];
    for (const filter of filters) args.push("--filter", validateFilter(filter));
    const res = await this.run<ListResponse<DataboxRow>>(args, signal);
    return res.items ?? [];
  }

  async searchTasks(query: string, limit = 50, signal?: AbortSignal): Promise<DataboxRow[]> {
    const dataset = await this.datasetAlias("issues", signal);
    const res = await this.run<ListResponse<DataboxRow>>(
      ["search", dataset, validateSearchQuery(query, "query"), "--limit", String(limit)],
      signal,
    );
    return res.items ?? [];
  }

  /**
   * Get one task by its human identifier (e.g. ENG-123) via `dbxcli get`, which
   * resolves the ref server-side — no client-side list scan. `dbxcli get` errors
   * for an unknown ref, which surfaces as a {@link DataboxError}.
   */
  async getTask(ref: string, signal?: AbortSignal): Promise<DataboxRow> {
    const dataset = await this.datasetAlias("issues", signal);
    return this.run<DataboxRow>(["get", dataset, validateRef(ref)], signal);
  }

  /**
   * Create a task via the `create_issue` action. The agent does not supply a
   * team — Databox pins `team_id` and injects it. Pass `simulated: true` to route
   * through Databox's simulator (no real issue created) — used by tests; the
   * simulator does not apply pins, so tests pass a `team` to satisfy it.
   */
  async createTask(
    input: CreateTaskInput,
    opts: { simulated?: boolean; signal?: AbortSignal } = {},
  ): Promise<IssueMutationResult> {
    const action = await this.actionAlias("create_issue", opts.signal);
    const params = buildCreateParams(input);
    const args = ["action", "invoke", action, "--params", JSON.stringify(params)];
    if (opts.simulated) args.push("--simulated");
    const res = await this.run<InvokeResponse<IssueMutationResult>>(args, opts.signal);
    if (!res.result?.identifier) {
      throw new DataboxError("create action returned no identifier");
    }
    return res.result;
  }

  /**
   * Update a task via the `update_issue` action. `ref` accepts a UUID or a human
   * identifier (e.g. ENG-123). Only provided fields are sent. Pass
   * `simulated: true` to dry-run.
   */
  async updateTask(
    input: UpdateTaskInput,
    opts: { simulated?: boolean; signal?: AbortSignal } = {},
  ): Promise<IssueMutationResult> {
    const action = await this.actionAlias("update_issue", opts.signal);
    const params = buildUpdateTaskParams(input);
    const args = ["action", "invoke", action, "--params", JSON.stringify(params)];
    if (opts.simulated) args.push("--simulated");
    const res = await this.run<InvokeResponse<IssueMutationResult>>(args, opts.signal);
    if (!res.result?.identifier) {
      throw new DataboxError("update action returned no identifier");
    }
    return res.result;
  }

  // ── Projects (read + write) ──

  async listProjects(limit = 50, signal?: AbortSignal): Promise<DataboxRow[]> {
    const dataset = await this.datasetAlias("projects", signal);
    const res = await this.run<ListResponse<DataboxRow>>(
      ["list", dataset, "--limit", String(limit)],
      signal,
    );
    return res.items ?? [];
  }

  /**
   * Get one project by UUID (via `dbxcli get`) or by case-insensitive name (a
   * client-side scan, since projects have no human identifier to `get` by).
   * `limit` bounds the name scan (dataset cap is 1000).
   */
  async getProject(idOrName: string, limit = 1000, signal?: AbortSignal): Promise<DataboxRow> {
    if (isUuid(idOrName)) {
      const dataset = await this.datasetAlias("projects", signal);
      return this.run<DataboxRow>(["get", dataset, idOrName], signal);
    }
    let projects: DataboxRow[];
    try {
      projects = await this.listProjects(limit, signal);
    } catch (error) {
      if (error instanceof DataboxError && /complexity/i.test(error.message)) {
        throw new DataboxError(
          `looking up project "${idOrName}" by name exceeded the Linear API complexity limit; ` +
            "use the project UUID instead",
        );
      }
      throw error;
    }
    const match = projects.find(
      (p) => typeof p.name === "string" && p.name.toLowerCase() === idOrName.toLowerCase(),
    );
    if (!match) throw new DataboxError(`no project found matching ${idOrName}`);
    return match;
  }

  /**
   * Resolve a team reference (key like "TAV", or a name) to its UUID. A value
   * already shaped like a UUID is returned unchanged. Used to satisfy the
   * `team_id` requirement of `create_project`.
   */
  async resolveTeamId(team: string, signal?: AbortSignal): Promise<string> {
    if (isUuid(team)) return team;
    const teams = await this.listTeams(1000, signal);
    const match = teams.find((t) => {
      const key = typeof t.key === "string" ? t.key : "";
      const name = typeof t.name === "string" ? t.name : "";
      return key.toLowerCase() === team.toLowerCase() || name.toLowerCase() === team.toLowerCase();
    });
    const id = match && typeof match.id === "string" ? match.id : "";
    if (!id) throw new DataboxError(`no team found matching ${team}`);
    return id;
  }

  /**
   * Create a project via the `create_project` action. Unlike issues, `team_id` is
   * required and not pinned server-side, so the team is resolved to a UUID first.
   * Pass `simulated: true` to route through Databox's simulator (no real project).
   */
  async createProject(
    input: CreateProjectInput,
    opts: { simulated?: boolean; signal?: AbortSignal } = {},
  ): Promise<ProjectMutationResult> {
    const [teamId, action] = await Promise.all([
      this.resolveTeamId(input.team, opts.signal),
      this.actionAlias("create_project", opts.signal),
    ]);
    const params = buildCreateProjectParams(input, teamId);
    const args = ["action", "invoke", action, "--params", JSON.stringify(params)];
    if (opts.simulated) args.push("--simulated");
    const res = await this.run<InvokeResponse<ProjectMutationResult>>(args, opts.signal);
    if (!res.result?.project_id) {
      throw new DataboxError("create project action returned no project id");
    }
    return res.result;
  }

  /**
   * Update a project via the `update_project` action. Only the fields present on
   * {@link UpdateProjectInput} are sent. Pass `simulated: true` to dry-run.
   */
  async updateProject(
    input: UpdateProjectInput,
    opts: { simulated?: boolean; signal?: AbortSignal } = {},
  ): Promise<ProjectMutationResult> {
    const action = await this.actionAlias("update_project", opts.signal);
    const params = buildUpdateProjectParams(input);
    const args = ["action", "invoke", action, "--params", JSON.stringify(params)];
    if (opts.simulated) args.push("--simulated");
    const res = await this.run<InvokeResponse<ProjectMutationResult>>(args, opts.signal);
    if (!res.result?.project_id) {
      throw new DataboxError("update project action returned no project id");
    }
    return res.result;
  }

  // ── Teams (read-only reference) ──

  async listTeams(limit = 50, signal?: AbortSignal): Promise<DataboxRow[]> {
    const dataset = await this.datasetAlias("teams", signal);
    const res = await this.run<ListResponse<DataboxRow>>(
      ["list", dataset, "--limit", String(limit)],
      signal,
    );
    return res.items ?? [];
  }

  /**
   * Get one team by UUID (via `dbxcli get`) or by key/name (a client-side scan).
   * `limit` bounds the scan (dataset cap is 1000).
   */
  async getTeam(keyOrName: string, limit = 1000, signal?: AbortSignal): Promise<DataboxRow> {
    if (isUuid(keyOrName)) {
      const dataset = await this.datasetAlias("teams", signal);
      return this.run<DataboxRow>(["get", dataset, keyOrName], signal);
    }
    const teams = await this.listTeams(limit, signal);
    const match = teams.find((t) => {
      const key = typeof t.key === "string" ? t.key : "";
      const name = typeof t.name === "string" ? t.name : "";
      return (
        key.toLowerCase() === keyOrName.toLowerCase() ||
        name.toLowerCase() === keyOrName.toLowerCase()
      );
    });
    if (!match) throw new DataboxError(`no team found matching ${keyOrName}`);
    return match;
  }
}
