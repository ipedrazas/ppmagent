import { execCommand } from "../exec.ts";
import { type Logger, nullLogger } from "../logger.ts";

export interface DataboxClientOptions {
  /** `dbxcli` binary (path or name on PATH). */
  bin: string;
  /** dbxcli config file (DataboxPPM endpoint + auth). Empty = dbxcli default. */
  config: string;
  /** Logger; defaults to the discarding logger so the client stays test-quiet. */
  logger?: Logger;
}

/** A tracker task in neutral vocabulary (no Linear/Jira-specific fields). */
export interface TrackerTask {
  /** Human identifier, e.g. ENG-123. */
  ref: string;
  url: string;
  title: string;
  /** Live status — read from the tracker, never mirrored into memory. */
  status?: string;
  /** Team the task belongs to (e.g. "TAV"). */
  team?: string;
  /** Opaque internal id (Linear UUID); kept for `get`-by-id, not shown to memory. */
  id?: string;
}

export interface CreateTaskInput {
  title: string;
  description: string;
  /**
   * Optional team id. Normally omitted: Databox pins `team_id` on the action and
   * injects/overrides it on real creates. Only needed to satisfy the `--simulated`
   * path (the simulator validates params but does not apply pins).
   */
  team?: string;
}

/** A tracker project in neutral vocabulary. */
export interface TrackerProject {
  /** Opaque internal id (Linear UUID); needed to update the project. */
  id: string;
  name: string;
  url: string;
  description?: string;
  /** Lifecycle state: backlog | planned | started | paused | completed | canceled. */
  status?: string;
  /** Lead (display name or id, as the datasource projects it). */
  lead?: string;
  /** Team keys the project belongs to (e.g. ["TAV"]). */
  teams?: string[];
  /** Completion ratio in [0, 1]. */
  progress?: number;
}

/** A tracker team in neutral vocabulary. Read-only reference data. */
export interface TrackerTeam {
  /** Opaque internal id (Linear UUID); pass as the team for project/issue creation. */
  id: string;
  /** Team key, e.g. "TAV" or "ENG". */
  key: string;
  name: string;
  description?: string;
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
  /** UUID of the project to update (from {@link TrackerProject.id}). */
  id: string;
  name?: string;
  description?: string;
  /** UUID of the user to set as project lead. */
  lead?: string;
  /** New state: backlog | planned | started | paused | completed | canceled. */
  state?: string;
}

// ── Raw DataboxPPM shapes (verified against dbxcli against the live datasource) ──

/** One row of the `issues` dataset (a Linear issue projected by Databox). */
interface DataboxIssue {
  id: string;
  identifier: string;
  title: string;
  status?: string;
  team?: string;
  url: string;
  [key: string]: unknown;
}

/** One row of the `projects` dataset (a Linear project projected by Databox). */
interface DataboxProject {
  id: string;
  name: string;
  url: string;
  description?: string;
  status?: string;
  lead?: string;
  teams?: string[];
  progress?: number;
  [key: string]: unknown;
}

/** One row of the `teams` dataset (a Linear team projected by Databox). */
interface DataboxTeam {
  id: string;
  key: string;
  name: string;
  description?: string;
  [key: string]: unknown;
}

interface ListResponse<T> {
  items: T[];
  meta?: { total?: number; limit?: number; offset?: number };
}

/** `action invoke` envelope: the action result lives under `result`. */
interface InvokeResponse<T> {
  metadata?: { simulated?: boolean; replayed?: boolean };
  result: T;
}

/** Result of the `create_issue` action. */
interface CreateIssueResult {
  identifier: string;
  issue_id: string;
  url: string;
}

/** Result of the `create_project` / `update_project` actions. */
interface ProjectMutationResult {
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
  /** Neutral type: "create_issue" | "create_project" | "update_project". */
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

/** Project a raw Databox issue into the neutral {@link TrackerTask}. Pure. */
export function toTrackerTask(issue: DataboxIssue): TrackerTask {
  return {
    ref: issue.identifier,
    url: issue.url,
    title: issue.title,
    status: issue.status,
    team: issue.team,
    id: issue.id,
  };
}

/**
 * Build the `create_issue` action params. Pure. `team_id` is sent only when an
 * explicit override is given; otherwise Databox pins/injects it server-side.
 */
export function buildCreateParams(input: CreateTaskInput): {
  title: string;
  team_id?: string;
  description?: string;
} {
  const params: { title: string; team_id?: string; description?: string } = {
    title: input.title,
  };
  if (input.team) params.team_id = input.team;
  if (input.description) params.description = input.description;
  return params;
}

/** Project a raw Databox project into the neutral {@link TrackerProject}. Pure. */
export function toTrackerProject(project: DataboxProject): TrackerProject {
  return {
    id: project.id,
    name: project.name,
    url: project.url,
    description: project.description || undefined,
    status: project.status || undefined,
    lead: project.lead || undefined,
    teams: project.teams && project.teams.length > 0 ? project.teams : undefined,
    progress: typeof project.progress === "number" ? project.progress : undefined,
  };
}

/** Project a raw Databox team into the neutral {@link TrackerTeam}. Pure. */
export function toTrackerTeam(team: DataboxTeam): TrackerTeam {
  return {
    id: team.id,
    key: team.key,
    name: team.name,
    description: team.description || undefined,
  };
}

/** RFC-4122 UUID matcher; lets {@link CreateProjectInput.team} accept a key or a raw UUID. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
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
 * pi has no MCP client, so this is how the agent reaches the tracker. Linear /
 * Jira vocabulary stays inside this file; the rest of the agent sees only the
 * neutral {@link TrackerTask}, {@link TrackerProject}, and {@link TrackerTeam}.
 *
 * Entities: tasks (issues) and projects are read+write; teams are read-only.
 *
 * Dataset and action aliases are NOT configured: they are discovered from the
 * dbxcli config (via `dbxcli datasets` / `dbxcli action list`) and resolved by
 * their neutral `data_kind` / `action_type`, then cached for the client's life.
 *
 * Verified surface (see plans/implementation-plan.md §5):
 *   list/search   → `{ items: T[], meta }`
 *   get           → resolved client-side from a list (no UUID known up front)
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
    type: "create_issue" | "create_project" | "update_project",
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

  /**
   * List tasks. `filters` are passed through verbatim as repeated `--filter`
   * clauses (e.g. `status=Done`, `status!=Canceled`, `labels in bug,urgent`,
   * `project_id=<uuid>`); they are AND-combined by the datasource.
   */
  async listTasks(
    limit = 50,
    filters: string[] = [],
    signal?: AbortSignal,
  ): Promise<TrackerTask[]> {
    const dataset = await this.datasetAlias("issues", signal);
    const args = ["list", dataset, "--limit", String(limit)];
    for (const filter of filters) args.push("--filter", filter);
    const res = await this.run<ListResponse<DataboxIssue>>(args, signal);
    return (res.items ?? []).map(toTrackerTask);
  }

  async searchTasks(query: string, limit = 50, signal?: AbortSignal): Promise<TrackerTask[]> {
    const dataset = await this.datasetAlias("issues", signal);
    const res = await this.run<ListResponse<DataboxIssue>>(
      ["search", dataset, query, "--limit", String(limit)],
      signal,
    );
    return (res.items ?? []).map(toTrackerTask);
  }

  /**
   * Get a task by its human identifier (e.g. ENG-123). `dbxcli get` keys on the
   * internal UUID and Databox `search` only matches title/description content
   * (not the identifier), so we list and filter by `identifier` client-side.
   * `limit` bounds the scan (dataset cap is 1000); raise it for large workspaces.
   */
  async getTask(ref: string, limit = 1000, signal?: AbortSignal): Promise<TrackerTask> {
    const tasks = await this.listTasks(limit, [], signal);
    const match = tasks.find((t) => t.ref === ref);
    if (!match) throw new DataboxError(`no task found with reference ${ref}`);
    return match;
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
  ): Promise<TrackerTask> {
    const action = await this.actionAlias("create_issue", opts.signal);
    const params = buildCreateParams(input);
    const args = ["action", "invoke", action, "--params", JSON.stringify(params)];
    if (opts.simulated) args.push("--simulated");
    const res = await this.run<InvokeResponse<CreateIssueResult>>(args, opts.signal);
    if (!res.result?.identifier) {
      throw new DataboxError("create action returned no identifier");
    }
    return {
      ref: res.result.identifier,
      url: res.result.url,
      title: input.title,
      id: res.result.issue_id,
    };
  }

  // ── Projects (read + write) ──

  async listProjects(limit = 50, signal?: AbortSignal): Promise<TrackerProject[]> {
    const dataset = await this.datasetAlias("projects", signal);
    const res = await this.run<ListResponse<DataboxProject>>(
      ["list", dataset, "--limit", String(limit)],
      signal,
    );
    return (res.items ?? []).map(toTrackerProject);
  }

  /**
   * Get one project by UUID or (case-insensitive) name. Projects have no human
   * identifier like ENG-123, so we list and match client-side. `limit` bounds the
   * scan (dataset cap is 1000).
   */
  async getProject(idOrName: string, limit = 1000, signal?: AbortSignal): Promise<TrackerProject> {
    const projects = await this.listProjects(limit, signal);
    const match = projects.find(
      (p) => p.id === idOrName || p.name.toLowerCase() === idOrName.toLowerCase(),
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
    const match = teams.find(
      (t) =>
        t.key.toLowerCase() === team.toLowerCase() || t.name.toLowerCase() === team.toLowerCase(),
    );
    if (!match) throw new DataboxError(`no team found matching ${team}`);
    return match.id;
  }

  /**
   * Create a project via the `create_project` action. Unlike issues, `team_id` is
   * required and not pinned server-side, so the team is resolved to a UUID first.
   * Pass `simulated: true` to route through Databox's simulator (no real project).
   */
  async createProject(
    input: CreateProjectInput,
    opts: { simulated?: boolean; signal?: AbortSignal } = {},
  ): Promise<TrackerProject> {
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
    return {
      id: res.result.project_id,
      name: res.result.name || input.name,
      url: res.result.url,
      status: res.result.state || input.state,
      teams: [input.team],
    };
  }

  /**
   * Update a project via the `update_project` action. Only the fields present on
   * {@link UpdateProjectInput} are sent. Pass `simulated: true` to dry-run.
   */
  async updateProject(
    input: UpdateProjectInput,
    opts: { simulated?: boolean; signal?: AbortSignal } = {},
  ): Promise<TrackerProject> {
    const action = await this.actionAlias("update_project", opts.signal);
    const params = buildUpdateProjectParams(input);
    const args = ["action", "invoke", action, "--params", JSON.stringify(params)];
    if (opts.simulated) args.push("--simulated");
    const res = await this.run<InvokeResponse<ProjectMutationResult>>(args, opts.signal);
    if (!res.result?.project_id) {
      throw new DataboxError("update project action returned no project id");
    }
    return {
      id: res.result.project_id,
      name: res.result.name || input.name || "",
      url: res.result.url,
      status: res.result.state || input.state,
    };
  }

  // ── Teams (read-only reference) ──

  async listTeams(limit = 50, signal?: AbortSignal): Promise<TrackerTeam[]> {
    const dataset = await this.datasetAlias("teams", signal);
    const res = await this.run<ListResponse<DataboxTeam>>(
      ["list", dataset, "--limit", String(limit)],
      signal,
    );
    return (res.items ?? []).map(toTrackerTeam);
  }

  /** Get one team by key (e.g. "TAV"), name, or UUID. Matches client-side. */
  async getTeam(keyOrName: string, limit = 1000, signal?: AbortSignal): Promise<TrackerTeam> {
    const teams = await this.listTeams(limit, signal);
    const match = teams.find(
      (t) =>
        t.id === keyOrName ||
        t.key.toLowerCase() === keyOrName.toLowerCase() ||
        t.name.toLowerCase() === keyOrName.toLowerCase(),
    );
    if (!match) throw new DataboxError(`no team found matching ${keyOrName}`);
    return match;
  }
}
