import { execCommand } from "../exec.ts";
import { type Logger, nullLogger } from "../logger.ts";
import { redactArgs } from "../redact.ts";
import {
  validateArg,
  validateFreeText,
  validateRef,
  validateSearchQuery,
  validateSlug,
} from "../sanitize.ts";

/**
 * The uniform envelope every `ppm` command emits on stdout in JSON mode.
 * On error, `ok` is false and only `error` is set (no `message`/`data`); the
 * process also exits non-zero. See docs/ppm-readme.md.
 */
export interface PpmEnvelope<T = unknown> {
  ok: boolean;
  message?: string;
  data?: T;
  error?: string;
}

/** A `ppm` success envelope — `message` and `data` are always present. */
export interface PpmSuccess<T> {
  ok: true;
  message: string;
  data: T;
}

// ── Payload shapes (verified against ppm v0.1.0 — see plans §4) ──────────────

/** A full typed entry, as returned by every write command and embedded in context. */
export interface PpmEntry {
  project: string;
  type: string;
  name: string;
  frontmatter: Record<string, unknown>;
  body: string;
  relPath: string;
}

/** One line of a project's shape: type/name/title/date, plus status for questions. */
export interface ShapeEntry {
  type: string;
  name: string;
  title: string;
  date: string;
  status?: string;
}

/** `ppm project show` — the entry inventory without content. */
export interface ProjectShape {
  project: string;
  title: string;
  status: string;
  counts: Record<string, number>;
  entries: ShapeEntry[] | null;
}

export interface ProjectListData {
  projects: string[];
}

export interface ReadData {
  content: string;
}

export interface SearchHit {
  relPath: string;
  snippet: string;
}

export interface SearchData {
  hits: SearchHit[] | null;
}

/**
 * One cell of the compliance matrix: a concern (standard or initiative)
 * evaluated against one project. Also embedded in the context slice as the
 * active project's cross-cutting obligations.
 */
export interface ConcernCell {
  concern: string;
  kind: string;
  check?: string;
  severity?: string;
  project: string;
  status: string;
  reason: string;
}

/** `ppm audit` — the cross-project compliance matrix. */
export interface AuditData {
  matrix: ConcernCell[] | null;
  summary: Record<string, number>;
}

/** A standard's definition, as returned by `standard add/show/retire`. */
export interface StandardData {
  id: string;
  title: string;
  appliesTo: string;
  severity: string;
  check: string;
  status: string;
  body: string;
  relPath: string;
}

export interface StandardListData {
  standards: StandardData[] | null;
}

/** An initiative's definition, as returned by `initiative add/update`. */
export interface InitiativeData {
  id: string;
  title: string;
  appliesTo: string;
  status: string;
  body: string;
  relPath: string;
}

export interface InitiativeListData {
  initiatives: InitiativeData[] | null;
}

export interface InitiativeMember {
  project: string;
  bound: boolean;
  task?: string;
}

/** `ppm initiative show` — the definition plus the per-member bound rollup. */
export interface InitiativeShowData extends InitiativeData {
  members: InitiativeMember[] | null;
  boundCount: number;
}

/** `ppm context` — the shape-aware slice injected each turn. */
export interface ContextData {
  project: string;
  preferences: string;
  glossary: string;
  index: string;
  summary: string;
  focus: string;
  openQuestions: PpmEntry[];
  recentDecisions: PpmEntry[];
  shape: ProjectShape;
  otherProjects: ProjectShape[] | null;
  standards: ConcernCell[] | null;
  initiatives: ConcernCell[] | null;
}

/** Raised when `ppm` returns `ok: false` or its output cannot be parsed. */
export class PpmError extends Error {
  constructor(
    message: string,
    readonly envelope?: PpmEnvelope,
  ) {
    super(message);
    this.name = "PpmError";
  }
}

/**
 * Parse a `ppm` JSON-mode stdout string into a typed envelope. Pure — kept
 * separate from process spawning so it is trivially unit-testable.
 */
export function parseEnvelope<T = unknown>(stdout: string): PpmEnvelope<T> {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) {
    throw new PpmError("ppm produced no output");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new PpmError(`ppm output was not valid JSON: ${trimmed.slice(0, 200)}`);
  }
  if (typeof parsed !== "object" || parsed === null || !("ok" in parsed)) {
    throw new PpmError("ppm output was not a recognised envelope");
  }
  return parsed as PpmEnvelope<T>;
}

export interface PpmClientOptions {
  /** `ppm` binary (path or name on PATH). */
  bin: string;
  /** Memory workspace root, passed to every call as --root. */
  root: string;
  /** Logger; defaults to the discarding logger so the client stays test-quiet. */
  logger?: Logger;
  /** Cap combined subprocess output (stdout+stderr) at this many bytes. 0 = unlimited. */
  maxOutputBytes?: number;
}

/**
 * Thin typed wrapper over the `ppm` CLI. Every call appends `--root <root>` and
 * `-o json`, parses the envelope, and throws {@link PpmError} on `ok: false`
 * (carrying ppm's `error` text). The memory AgentTools (see ./tools.ts) are thin
 * shims over these methods.
 */
export class PpmClient {
  private readonly log: Logger;

  constructor(private readonly opts: PpmClientOptions) {
    this.log = (opts.logger ?? nullLogger).child().withContext({ component: "ppm" });
  }

  /**
   * Run an arbitrary `ppm` subcommand. Throws {@link PpmError} on `ok: false`,
   * so the returned envelope is always a success (`message` + `data` present).
   */
  async run<T = unknown>(args: string[], signal?: AbortSignal): Promise<PpmSuccess<T>> {
    const fullArgs = [...args, "--root", this.opts.root, "-o", "json"];
    const result = await execCommand(this.opts.bin, fullArgs, {
      signal,
      logger: this.log,
      maxOutputBytes: this.opts.maxOutputBytes,
    });
    let envelope: PpmEnvelope<T>;
    try {
      envelope = parseEnvelope<T>(result.stdout);
    } catch (error) {
      this.log
        .withError(error)
        .withMetadata({ args: redactArgs(args) })
        .error("ppm output could not be parsed");
      throw error;
    }
    if (!envelope.ok || envelope.data === undefined || envelope.message === undefined) {
      this.log
        .withMetadata({ args: redactArgs(args), error: envelope.error })
        .warn("ppm returned an error envelope");
      throw new PpmError(envelope.error ?? envelope.message ?? "ppm failed", envelope);
    }
    return { ok: true, message: envelope.message, data: envelope.data };
  }

  // ── Read side ──

  projectList(signal?: AbortSignal) {
    return this.run<ProjectListData>(["project", "list"], signal);
  }

  projectShow(project: string, signal?: AbortSignal) {
    return this.run<ProjectShape>(["project", "show", validateSlug(project)], signal);
  }

  read(project?: string, opts?: { type?: string; name?: string }, signal?: AbortSignal) {
    const args = ["read"];
    if (project) args.push(validateSlug(project));
    if (opts?.type) args.push("--type", validateArg(opts.type, "type"));
    if (opts?.name) args.push("--name", validateArg(opts.name, "name"));
    return this.run<ReadData>(args, signal);
  }

  search(query: string, signal?: AbortSignal) {
    return this.run<SearchData>(["search", validateSearchQuery(query, "query")], signal);
  }

  context(project: string, recent: number, signal?: AbortSignal) {
    return this.run<ContextData>(
      ["context", validateSlug(project), "--recent", String(recent)],
      signal,
    );
  }

  audit(params: AuditParams = {}, signal?: AbortSignal) {
    return this.run<AuditData>(buildAuditArgs(params), signal);
  }

  standard(params: StandardParams, signal?: AbortSignal) {
    return this.run<StandardData | StandardListData>(buildStandardArgs(params), signal);
  }

  initiative(params: InitiativeParams, signal?: AbortSignal) {
    return this.run<InitiativeData | InitiativeListData | InitiativeShowData | PpmEntry>(
      buildInitiativeArgs(params),
      signal,
    );
  }

  // ── Write side ──

  projectCreate(slug: string, title: string, signal?: AbortSignal) {
    return this.run<{ project: string; title: string }>(
      ["project", "create", validateSlug(slug), "--title", validateFreeText(title, "title")],
      signal,
    );
  }

  /** Run a write subcommand (built by {@link buildWriteArgs}); returns the new entry. */
  write(args: string[], signal?: AbortSignal) {
    return this.run<PpmEntry>(args, signal);
  }

  projectUpdate(params: ProjectUpdateParams, signal?: AbortSignal) {
    return this.run<PpmEntry>(buildProjectUpdateArgs(params), signal);
  }

  verdict(params: VerdictParams, signal?: AbortSignal) {
    return this.run<PpmEntry>(buildVerdictArgs(params), signal);
  }

  waive(params: WaiveParams, signal?: AbortSignal) {
    return this.run<PpmEntry>(buildWaiveArgs(params), signal);
  }
}

/** The closed set of writable entry types (mirrors the tool schema). */
export type WriteEntryType =
  | "summary"
  | "focus"
  | "decision"
  | "question"
  | "task"
  | "note"
  | "conversation";

export interface WriteParams {
  project: string;
  type: WriteEntryType;
  content: string;
  name?: string;
  /** For type=question: resolve an existing question instead of adding one. */
  resolve?: boolean;
  /** For type=task: the tracker reference (e.g. ENG-123). */
  ref?: string;
  /** For type=task: the tracker URL. */
  url?: string;
}

/**
 * Translate a type-addressable `memory_write` into the matching `ppm` argv.
 * Pure and exported so the mapping is unit-testable without spawning ppm.
 */
export function buildWriteArgs(params: WriteParams): string[] {
  const { project, type, content, name, resolve, ref, url } = params;
  const safeProject = validateSlug(project);
  const safeContent = validateFreeText(content, "content");
  const safeName = name ? validateArg(name, "name") : undefined;
  switch (type) {
    case "summary":
      return ["summary", "set", safeProject, "--content", safeContent];
    case "focus":
      return ["focus", "set", safeProject, "--content", safeContent];
    case "decision":
      return ["decision", "add", safeProject, "--content", safeContent];
    case "question":
      if (resolve) {
        if (!safeName) throw new PpmError("resolving a question requires `name`");
        return ["question", "resolve", safeProject, safeName, "--content", safeContent];
      }
      return [
        "question",
        "add",
        safeProject,
        ...(safeName ? ["--name", safeName] : []),
        "--content",
        safeContent,
      ];
    case "task": {
      if (!ref) throw new PpmError("type=task requires `ref`");
      const safeRef = validateRef(ref);
      const urlArgs = url ? ["--url", validateFreeText(url, "url")] : [];
      return ["task", "add", safeProject, "--ref", safeRef, ...urlArgs, "--content", safeContent];
    }
    case "note":
      return [
        "note",
        "add",
        safeProject,
        ...(safeName ? ["--name", safeName] : []),
        "--content",
        safeContent,
      ];
    case "conversation":
      return [
        "conversation",
        "add",
        safeProject,
        ...(safeName ? ["--name", safeName] : []),
        "--content",
        safeContent,
      ];
  }
}

// ── Cross-cutting (governance) argv builders ─────────────────────────────────
// Pure and exported, like buildWriteArgs, so each mapping is unit-testable
// without spawning ppm.

export interface AuditParams {
  /** Run a single standard by id. */
  standard?: string;
  /** Run a single initiative by id. */
  initiative?: string;
  /** Ad-hoc built-in check, e.g. has-summary | no-stale-questions:14d. */
  check?: string;
  /** Restrict the project axis to this tag. */
  tag?: string;
  /** Restrict the project axis to a single project. */
  project?: string;
}

export function buildAuditArgs(params: AuditParams): string[] {
  const args = ["audit"];
  if (params.standard) args.push("--standard", validateArg(params.standard, "standard id"));
  if (params.initiative) args.push("--initiative", validateArg(params.initiative, "initiative id"));
  if (params.check) args.push("--check", validateArg(params.check, "check"));
  if (params.tag) args.push("--tag", validateArg(params.tag, "tag"));
  if (params.project) args.push("--project", validateSlug(params.project));
  return args;
}

export type StandardAction = "add" | "list" | "show" | "retire";

export interface StandardParams {
  action: StandardAction;
  /** Standard id; required for every action except list. */
  id?: string;
  /** For add: what the standard requires (the entry body). */
  content?: string;
  title?: string;
  /** For add: built-in check id, or 'manual' for agent-judged (ppm default). */
  check?: string;
  severity?: "info" | "warn" | "block";
  /** For add: all | tag:<t> | comma-separated slugs (ppm default: all). */
  appliesTo?: string;
}

export function buildStandardArgs(params: StandardParams): string[] {
  const { action, id, content, title, check, severity, appliesTo } = params;
  if (action === "list") return ["standard", "list"];
  if (!id) throw new PpmError(`standard ${action} requires \`id\``);
  const safeId = validateArg(id, "standard id");
  switch (action) {
    case "show":
      return ["standard", "show", safeId];
    case "retire":
      return ["standard", "retire", safeId];
    case "add": {
      if (!content) throw new PpmError("standard add requires `content`");
      return [
        "standard",
        "add",
        safeId,
        "--content",
        validateFreeText(content, "content"),
        ...(title ? ["--title", validateFreeText(title, "title")] : []),
        ...(check ? ["--check", validateArg(check, "check")] : []),
        ...(severity ? ["--severity", validateArg(severity, "severity")] : []),
        ...(appliesTo ? ["--applies-to", validateArg(appliesTo, "applies-to")] : []),
      ];
    }
  }
}

export type InitiativeAction = "add" | "bind" | "list" | "show" | "update";

export interface InitiativeParams {
  action: InitiativeAction;
  /** Initiative id; required for every action except list. */
  id?: string;
  /** For add: the campaign's intent (the entry body). For bind: the member task's rationale. */
  content?: string;
  title?: string;
  /** For add: all | tag:<t> | comma-separated slugs (ppm default: all). */
  appliesTo?: string;
  /** For update. */
  status?: "active" | "paused" | "done";
  /** For bind: the project to bind. */
  project?: string;
  /** For bind: tracker reference for the member task, e.g. ENG-411. */
  ref?: string;
  /** For bind: tracker URL. */
  url?: string;
}

export function buildInitiativeArgs(params: InitiativeParams): string[] {
  const { action, id, content, title, appliesTo, status, project, ref, url } = params;
  if (action === "list") return ["initiative", "list"];
  if (!id) throw new PpmError(`initiative ${action} requires \`id\``);
  const safeId = validateArg(id, "initiative id");
  switch (action) {
    case "show":
      return ["initiative", "show", safeId];
    case "add": {
      if (!content) throw new PpmError("initiative add requires `content`");
      return [
        "initiative",
        "add",
        safeId,
        "--content",
        validateFreeText(content, "content"),
        ...(title ? ["--title", validateFreeText(title, "title")] : []),
        ...(appliesTo ? ["--applies-to", validateArg(appliesTo, "applies-to")] : []),
      ];
    }
    case "update": {
      if (!status) throw new PpmError("initiative update requires `status`");
      return ["initiative", "update", safeId, "--status", validateArg(status, "status")];
    }
    case "bind": {
      if (!project) throw new PpmError("initiative bind requires `project`");
      if (!ref) throw new PpmError("initiative bind requires `ref`");
      if (!content) throw new PpmError("initiative bind requires `content`");
      return [
        "initiative",
        "bind",
        safeId,
        validateSlug(project),
        "--ref",
        validateRef(ref),
        ...(url ? ["--url", validateFreeText(url, "url")] : []),
        "--content",
        validateFreeText(content, "content"),
      ];
    }
  }
}

export interface VerdictParams {
  /** The manual standard being judged. */
  standard: string;
  project: string;
  status: "pass" | "fail";
  /** The rationale behind the judgement. */
  content: string;
}

export function buildVerdictArgs(params: VerdictParams): string[] {
  return [
    "verdict",
    validateArg(params.standard, "standard id"),
    validateSlug(params.project),
    "--status",
    validateArg(params.status, "status"),
    "--content",
    validateFreeText(params.content, "content"),
  ];
}

export interface WaiveParams {
  /** The concern (standard or initiative id) being waived. */
  concern: string;
  project: string;
  /** The reason for the exception — required by design. */
  reason: string;
}

export function buildWaiveArgs(params: WaiveParams): string[] {
  return [
    "waive",
    validateArg(params.concern, "concern id"),
    validateSlug(params.project),
    "--content",
    validateFreeText(params.reason, "reason"),
  ];
}

export interface ProjectUpdateParams {
  project: string;
  status?: "active" | "paused" | "done" | "archived";
  title?: string;
  /** Tags to add; drive tag:<t> concern scoping. */
  addTags?: string[];
  /** Tags to remove. */
  removeTags?: string[];
  /** Tracker system, e.g. linear|jira. */
  trackerSystem?: string;
  trackerProject?: string;
  trackerUrl?: string;
}

export function buildProjectUpdateArgs(params: ProjectUpdateParams): string[] {
  const { project, status, title, addTags, removeTags, trackerSystem, trackerProject, trackerUrl } =
    params;
  const args = ["project", "update", validateSlug(project)];
  if (status) args.push("--status", validateArg(status, "status"));
  if (title) args.push("--title", validateFreeText(title, "title"));
  for (const tag of addTags ?? []) args.push("--tag", validateArg(tag, "tag"));
  for (const tag of removeTags ?? []) args.push("--untag", validateArg(tag, "tag"));
  if (trackerSystem) args.push("--tracker-system", validateArg(trackerSystem, "tracker system"));
  if (trackerProject)
    args.push("--tracker-project", validateFreeText(trackerProject, "tracker project"));
  if (trackerUrl) args.push("--tracker-url", validateFreeText(trackerUrl, "tracker url"));
  if (args.length === 3) throw new PpmError("project update requires at least one field to change");
  return args;
}
