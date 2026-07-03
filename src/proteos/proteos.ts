import { execCommand } from "../exec.ts";
import { type Logger, nullLogger } from "../logger.ts";
import { redactArgs } from "../redact.ts";
import {
  ArgInjectionError,
  validateArg,
  validateBranchName,
  validateFreeText,
  validateId,
  validateRepo,
} from "../sanitize.ts";

/**
 * Format a model-supplied resource override (vcpus, MiB sizes) for argv.
 * Rejects anything but a positive integer so a negative or non-finite number
 * can never become a flag-like or malformed argument.
 */
function positiveInt(value: number, label: string): string {
  if (!Number.isInteger(value) || value <= 0)
    throw new ArgInjectionError(`${label} must be a positive integer, got: ${value}`);
  return String(value);
}

export interface ProteosClientOptions {
  /** `proteos` binary (path or name on PATH). */
  bin: string;
  /**
   * Control-plane base URL, passed as `--url`. Empty = let proteos resolve it
   * from PROTEOS_URL or the stored login. The auth token is never passed on the
   * command line: proteos reads PROTEOS_TOKEN (or the stored login) from the
   * environment, which {@link execCommand} forwards.
   */
  url?: string;
  /** Logger; defaults to the discarding logger so the client stays test-quiet. */
  logger?: Logger;
  /** Cap combined subprocess output (stdout+stderr) at this many bytes. 0 = unlimited. */
  maxOutputBytes?: number;
  /**
   * GitHub token forwarded to the `proteos` subprocess as `GITHUB_TOKEN`.
   * The `proteos` CLI reads it from its environment and injects it into ProteOS
   * machines so that `gh` is authenticated for PR creation in both the
   * `git pr` command path and headless coding-agent tasks (`task run`).
   * When omitted the inherited process environment is used as-is.
   */
  githubToken?: string;
}

export class ProteosError extends Error {
  constructor(
    message: string,
    readonly exitCode: number,
  ) {
    super(message);
    this.name = "ProteosError";
  }
}

/**
 * proteos process exit codes (cli/internal/client/client.go):
 *   0 ok · 1 generic · 2 usage · 3 auth · 4 not found · 5 task failed/canceled.
 * Exit 5 is informational — the task is still printed — so reads of a finished
 * task tolerate it rather than treating it as a CLI failure.
 */
const EXIT_OK = 0;
const EXIT_TASK_FAIL = 5;

export interface GitBranchInput {
  machine: string;
  project: string;
  name: string;
  /** Start point (branch, tag, or sha). Defaults to current HEAD. */
  from?: string;
  /** Create the branch without switching to it. */
  noCheckout?: boolean;
}

export interface GitCommitInput {
  machine: string;
  project: string;
  message: string;
  /** Repo-relative paths to commit; empty = all changes. */
  paths?: string[];
}

export interface GitPushInput {
  machine: string;
  project: string;
  branch: string;
  /** Set the upstream (-u) — needed on a new branch's first push. */
  setUpstream?: boolean;
}

export interface GitPrInput {
  machine: string;
  project: string;
  head: string;
  title: string;
  /** Target branch; defaults to the repo's default branch. */
  base?: string;
  body?: string;
}

export interface MachineCreateInput {
  /** Template id the machine is created from (see {@link listTemplates}). */
  template: string;
  /** Display name for the machine. */
  name?: string;
  /** Override vCPU count (template default when omitted). */
  vcpus?: number;
  /** Override memory in MiB (template default when omitted). */
  memMiB?: number;
  /** Override disk size in MiB (template default when omitted). */
  diskMiB?: number;
}

export interface TaskRunInput {
  machine: string;
  /** Project directory under /workspace (use {@link projectEnsure} first). */
  project: string;
  prompt: string;
  /** Agent provider for the headless lane. Defaults to proteos' own default (claude). */
  provider?: string;
}

/**
 * Thin wrapper over the `proteos` CLI, which drives the ProteOS Agent Task lane
 * (a coding agent running headless against a repo cloned in a firecracker
 * microVM). pi has no MCP client, so this is how the agent reaches ProteOS.
 *
 * Unlike {@link DataboxClient}, this does not re-parse the CLI's JSON: proteos
 * *is* the domain (there is no vocabulary to neutralize), and its default human
 * output is already compact, so each method returns the CLI's text for the model
 * to read. The control plane is the source of truth for task status — nothing is
 * mirrored into memory.
 *
 * Dispatch is async by design: {@link taskRun}/{@link taskSend} return as soon as
 * the task is dispatched (no `--wait`/`--watch`), so a chat turn never blocks for
 * minutes. Poll {@link taskGet}/{@link tasksList} for progress instead.
 */
export class ProteosClient {
  private readonly log: Logger;

  constructor(private readonly opts: ProteosClientOptions) {
    this.log = (opts.logger ?? nullLogger).child().withContext({ component: "proteos" });
  }

  /**
   * Common flags for a leaf command. proteos parses flags on the *leaf*
   * (`proteos <group> <sub> [flags]`), so callers splice these in after the two
   * command words, before any positional args.
   */
  private flags(): string[] {
    return this.opts.url ? ["--url", this.opts.url] : [];
  }

  /**
   * Run a proteos invocation and return its text output. `okCodes` lists exit
   * codes that are *not* errors (always includes 0); anything else throws a
   * {@link ProteosError} carrying stderr (or stdout) and the code. stderr notes
   * (e.g. "diff truncated") are appended to stdout so the model sees them.
   */
  private async exec(
    args: string[],
    signal?: AbortSignal,
    okCodes: readonly number[] = [EXIT_OK],
  ): Promise<string> {
    const env = this.opts.githubToken ? { GITHUB_TOKEN: this.opts.githubToken } : undefined;
    const result = await execCommand(this.opts.bin, args, {
      signal,
      logger: this.log,
      maxOutputBytes: this.opts.maxOutputBytes,
      env,
    });
    if (!okCodes.includes(result.exitCode)) {
      const message =
        result.stderr.trim() || result.stdout.trim() || `proteos exited ${result.exitCode}`;
      this.log
        .withMetadata({ args: redactArgs(args), exitCode: result.exitCode })
        .warn("proteos returned an error");
      throw new ProteosError(message, result.exitCode);
    }
    const out = result.stdout.trim();
    const err = result.stderr.trim();
    if (out && err) return `${out}\n${err}`;
    return out || err;
  }

  // ── Machines / templates / repos (read-only discovery) ──

  listMachines(signal?: AbortSignal): Promise<string> {
    return this.exec(["machines", "ls", ...this.flags()], signal);
  }

  getMachine(id: string, signal?: AbortSignal): Promise<string> {
    return this.exec(["machines", "get", ...this.flags(), validateId(id)], signal);
  }

  // ── Machine lifecycle (create / start / stop) ──

  /**
   * Create a machine from a template. Async: the server boots it in the
   * background, so the returned state is usually still `provisioning` — poll
   * {@link getMachine} until it is running.
   */
  createMachine(input: MachineCreateInput, signal?: AbortSignal): Promise<string> {
    const args = ["machines", "create", ...this.flags(), "--template", validateId(input.template)];
    if (input.name) args.push("--name", validateArg(input.name, "machine name"));
    if (input.vcpus !== undefined) args.push("--vcpus", positiveInt(input.vcpus, "vcpus"));
    if (input.memMiB !== undefined) args.push("--mem-mib", positiveInt(input.memMiB, "memMiB"));
    if (input.diskMiB !== undefined) args.push("--disk-mib", positiveInt(input.diskMiB, "diskMiB"));
    return this.exec(args, signal);
  }

  /** Start a stopped machine by id. */
  startMachine(id: string, signal?: AbortSignal): Promise<string> {
    return this.exec(["machines", "start", ...this.flags(), validateId(id)], signal);
  }

  /** Stop a running machine by id. */
  stopMachine(id: string, signal?: AbortSignal): Promise<string> {
    return this.exec(["machines", "stop", ...this.flags(), validateId(id)], signal);
  }

  listTemplates(signal?: AbortSignal): Promise<string> {
    return this.exec(["templates", "ls", ...this.flags()], signal);
  }

  listRepos(signal?: AbortSignal): Promise<string> {
    return this.exec(["repo", "ls", ...this.flags()], signal);
  }

  // ── Projects (repos cloned on a machine) ──

  listProjects(machine: string, signal?: AbortSignal): Promise<string> {
    return this.exec(["project", "ls", ...this.flags(), "--machine", validateId(machine)], signal);
  }

  /** Clone owner/repo onto a machine. Async: returns once the clone is dispatched. */
  cloneProject(machine: string, repo: string, signal?: AbortSignal): Promise<string> {
    return this.exec(
      ["project", "clone", ...this.flags(), "--machine", validateId(machine), validateRepo(repo)],
      signal,
    );
  }

  /**
   * Clone owner/repo onto a machine only if not already present. Idempotent, and
   * the agent-friendly step before {@link taskRun}. Blocks until the repo appears
   * (proteos' own clone wait, default 5m).
   */
  ensureProject(machine: string, repo: string, signal?: AbortSignal): Promise<string> {
    return this.exec(
      ["project", "ensure", ...this.flags(), "--machine", validateId(machine), validateRepo(repo)],
      signal,
    );
  }

  // ── Git (explicit review → commit → push → PR over a task's dirty tree) ──

  gitStatus(machine: string, project: string, signal?: AbortSignal): Promise<string> {
    return this.exec(
      [
        "git",
        "status",
        ...this.flags(),
        "--machine",
        validateId(machine),
        "--project",
        validateArg(project, "project"),
      ],
      signal,
    );
  }

  gitDiff(machine: string, project: string, staged = false, signal?: AbortSignal): Promise<string> {
    const args = [
      "git",
      "diff",
      ...this.flags(),
      "--machine",
      validateId(machine),
      "--project",
      validateArg(project, "project"),
    ];
    if (staged) args.push("--staged");
    return this.exec(args, signal);
  }

  gitBranch(input: GitBranchInput, signal?: AbortSignal): Promise<string> {
    const args = [
      "git",
      "branch",
      ...this.flags(),
      "--machine",
      validateId(input.machine),
      "--project",
      validateArg(input.project, "project"),
    ];
    if (input.from) args.push("--from", validateBranchName(input.from));
    if (input.noCheckout) args.push("--no-checkout");
    args.push(validateBranchName(input.name));
    return this.exec(args, signal);
  }

  gitCommit(input: GitCommitInput, signal?: AbortSignal): Promise<string> {
    const args = [
      "git",
      "commit",
      ...this.flags(),
      "--machine",
      validateId(input.machine),
      "--project",
      validateArg(input.project, "project"),
      "-m",
      validateFreeText(input.message, "message"),
    ];
    // `--` guards paths that might begin with a dash from flag parsing.
    if (input.paths && input.paths.length > 0) args.push("--", ...input.paths);
    return this.exec(args, signal);
  }

  /** Push a branch to origin. Async: returns once the push is dispatched. */
  gitPush(input: GitPushInput, signal?: AbortSignal): Promise<string> {
    const args = [
      "git",
      "push",
      ...this.flags(),
      "--machine",
      validateId(input.machine),
      "--project",
      validateArg(input.project, "project"),
      "--branch",
      validateBranchName(input.branch),
    ];
    if (input.setUpstream) args.push("--set-upstream");
    return this.exec(args, signal);
  }

  gitPr(input: GitPrInput, signal?: AbortSignal): Promise<string> {
    const args = [
      "git",
      "pr",
      ...this.flags(),
      "--machine",
      validateId(input.machine),
      "--project",
      validateArg(input.project, "project"),
      "--head",
      validateBranchName(input.head),
      "--title",
      validateFreeText(input.title, "title"),
    ];
    if (input.base) args.push("--base", validateBranchName(input.base));
    if (input.body) args.push("--body", validateFreeText(input.body, "body"));
    return this.exec(args, signal);
  }

  // ── Tasks (the headless agent lane) ──

  /**
   * Dispatch a headless agent task and return immediately with its id (no
   * `--wait`/`--watch`). The prompt is passed after `--` so a prompt beginning
   * with a dash is not mistaken for a flag.
   */
  taskRun(input: TaskRunInput, signal?: AbortSignal): Promise<string> {
    const args = [
      "task",
      "run",
      ...this.flags(),
      "--machine",
      validateId(input.machine),
      "--project",
      validateArg(input.project, "project"),
    ];
    if (input.provider) args.push("--provider", validateArg(input.provider, "provider"));
    args.push("--", validateFreeText(input.prompt, "prompt"));
    return this.exec(args, signal);
  }

  tasksList(machine: string, signal?: AbortSignal): Promise<string> {
    return this.exec(["task", "ls", ...this.flags(), "--machine", validateId(machine)], signal);
  }

  /** Show one task's status and (when finished) result. Tolerates exit 5 (failed/canceled). */
  taskGet(machine: string, taskId: string, signal?: AbortSignal): Promise<string> {
    return this.exec(
      ["task", "get", ...this.flags(), "--machine", validateId(machine), validateId(taskId)],
      signal,
      [EXIT_OK, EXIT_TASK_FAIL],
    );
  }

  /**
   * Send a follow-up turn that resumes a finished task's agent session. Async:
   * returns once the follow-up is dispatched. taskId is positional and comes
   * before the prompt, both after `--`.
   */
  taskSend(machine: string, taskId: string, prompt: string, signal?: AbortSignal): Promise<string> {
    return this.exec(
      [
        "task",
        "send",
        ...this.flags(),
        "--machine",
        validateId(machine),
        "--",
        validateId(taskId),
        validateFreeText(prompt, "prompt"),
      ],
      signal,
    );
  }

  /** Cancel one task. */
  taskCancel(machine: string, taskId: string, signal?: AbortSignal): Promise<string> {
    return this.exec(
      ["task", "cancel", ...this.flags(), "--machine", validateId(machine), validateId(taskId)],
      signal,
    );
  }

  /** Cancel every running/queued task on a machine. */
  cancelAllTasks(machine: string, signal?: AbortSignal): Promise<string> {
    return this.exec(
      ["task", "cancel", ...this.flags(), "--machine", validateId(machine), "--all-running"],
      signal,
    );
  }
}
