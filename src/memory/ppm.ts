import { execCommand } from "../exec.ts";
import { type Logger, nullLogger } from "../logger.ts";

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
    const result = await execCommand(this.opts.bin, fullArgs, { signal, logger: this.log });
    let envelope: PpmEnvelope<T>;
    try {
      envelope = parseEnvelope<T>(result.stdout);
    } catch (error) {
      this.log.withError(error).withMetadata({ args }).error("ppm output could not be parsed");
      throw error;
    }
    if (!envelope.ok || envelope.data === undefined || envelope.message === undefined) {
      this.log.withMetadata({ args, error: envelope.error }).warn("ppm returned an error envelope");
      throw new PpmError(envelope.error ?? envelope.message ?? "ppm failed", envelope);
    }
    return { ok: true, message: envelope.message, data: envelope.data };
  }

  // ── Read side ──

  projectList(signal?: AbortSignal) {
    return this.run<ProjectListData>(["project", "list"], signal);
  }

  projectShow(project: string, signal?: AbortSignal) {
    return this.run<ProjectShape>(["project", "show", project], signal);
  }

  read(project?: string, opts?: { type?: string; name?: string }, signal?: AbortSignal) {
    const args = ["read"];
    if (project) args.push(project);
    if (opts?.type) args.push("--type", opts.type);
    if (opts?.name) args.push("--name", opts.name);
    return this.run<ReadData>(args, signal);
  }

  search(query: string, signal?: AbortSignal) {
    return this.run<SearchData>(["search", query], signal);
  }

  context(project: string, recent: number, signal?: AbortSignal) {
    return this.run<ContextData>(["context", project, "--recent", String(recent)], signal);
  }

  // ── Write side ──

  projectCreate(slug: string, title: string, signal?: AbortSignal) {
    return this.run<{ project: string; title: string }>(
      ["project", "create", slug, "--title", title],
      signal,
    );
  }

  /** Run a write subcommand (built by {@link buildWriteArgs}); returns the new entry. */
  write(args: string[], signal?: AbortSignal) {
    return this.run<PpmEntry>(args, signal);
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
  switch (type) {
    case "summary":
      return ["summary", "set", project, "--content", content];
    case "focus":
      return ["focus", "set", project, "--content", content];
    case "decision":
      return ["decision", "add", project, "--content", content];
    case "question":
      if (resolve) {
        if (!name) throw new PpmError("resolving a question requires `name`");
        return ["question", "resolve", project, name, "--content", content];
      }
      return ["question", "add", project, ...(name ? ["--name", name] : []), "--content", content];
    case "task": {
      if (!ref) throw new PpmError("type=task requires `ref`");
      const urlArgs = url ? ["--url", url] : [];
      return ["task", "add", project, "--ref", ref, ...urlArgs, "--content", content];
    }
    case "note":
      return ["note", "add", project, ...(name ? ["--name", name] : []), "--content", content];
    case "conversation":
      return [
        "conversation",
        "add",
        project,
        ...(name ? ["--name", name] : []),
        "--content",
        content,
      ];
  }
}
