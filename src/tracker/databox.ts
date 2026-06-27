import { execCommand } from "../exec.ts";
import { type Logger, nullLogger } from "../logger.ts";

export interface DataboxClientOptions {
  /** `dbxcli` binary (path or name on PATH). */
  bin: string;
  /** dbxcli config file (DataboxPPM endpoint + auth). Empty = dbxcli default. */
  config: string;
  /** Dataset alias holding issues (e.g. "issues"). */
  dataset: string;
  /** Action alias that creates an issue (e.g. "create_issue_linear"). */
  createAction: string;
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

interface ListResponse {
  items: DataboxIssue[];
  meta?: { total?: number; limit?: number; offset?: number };
}

/** `action invoke` envelope: the action result lives under `result`. */
interface InvokeResponse {
  metadata?: { simulated?: boolean; replayed?: boolean };
  result: { identifier: string; issue_id: string; url: string };
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

/**
 * Thin wrapper over the `dbxcli` CLI, which fronts the DataboxPPM datasource.
 * pi has no MCP client, so this is how the agent reaches the tracker. Linear /
 * Jira vocabulary stays inside this file; the rest of the agent sees only
 * {@link TrackerTask}.
 *
 * Verified surface (see plans/implementation-plan.md §5):
 *   list/search   → `{ items: DataboxIssue[], meta }`
 *   get           → a single `DataboxIssue`
 *   action invoke → `{ metadata, result: { identifier, issue_id, url } }`
 */
export class DataboxClient {
  private readonly log: Logger;

  constructor(private readonly opts: DataboxClientOptions) {
    this.log = (opts.logger ?? nullLogger).child().withContext({ component: "databox" });
  }

  private baseArgs(): string[] {
    const args = ["--format", "json"];
    if (this.opts.config) args.push("--config", this.opts.config);
    return args;
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

  async listTasks(limit = 50, signal?: AbortSignal): Promise<TrackerTask[]> {
    const res = await this.run<ListResponse>(
      ["list", this.opts.dataset, "--limit", String(limit)],
      signal,
    );
    return (res.items ?? []).map(toTrackerTask);
  }

  async searchTasks(query: string, limit = 50, signal?: AbortSignal): Promise<TrackerTask[]> {
    const res = await this.run<ListResponse>(
      ["search", this.opts.dataset, query, "--limit", String(limit)],
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
    const tasks = await this.listTasks(limit, signal);
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
    const params = buildCreateParams(input);
    const args = ["action", "invoke", this.opts.createAction, "--params", JSON.stringify(params)];
    if (opts.simulated) args.push("--simulated");
    const res = await this.run<InvokeResponse>(args, opts.signal);
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
}
