import { execCommand } from "../exec.ts";
import { type Logger, nullLogger } from "../logger.ts";
import { redactArgs } from "../redact.ts";
import { validateArg, validateFreeText, validateId } from "../sanitize.ts";

export interface PulseClientOptions {
  /** `pulse` binary (path or name on PATH). */
  bin: string;
  /** Logger; defaults to the discarding logger so the client stays test-quiet. */
  logger?: Logger;
  /** Cap combined subprocess output (stdout+stderr) at this many bytes. 0 = unlimited. */
  maxOutputBytes?: number;
}

export class PulseError extends Error {
  constructor(
    message: string,
    readonly exitCode: number,
  ) {
    super(message);
    this.name = "PulseError";
  }
}

export interface ComposeInput {
  /** Node/agent name to target. Omit to use pulse's default node. */
  node?: string;
  /** Path to the docker-compose file on the node. Omit to use pulse's default. */
  compose?: string;
}

/**
 * Thin wrapper over the `pulse` CLI, which drives Docker stacks (containers,
 * images, compose up/down/logs) across remote agents (nodes/VMs). pi has no
 * MCP client, so this is how the agent reaches pulse.
 *
 * Like {@link import("../proteos/proteos.ts").ProteosClient}, this does not
 * re-parse the CLI's output: pulse's default human output is already compact
 * text, so each method returns it verbatim for the model to read. pulse itself
 * is the source of truth for node/container/image state — nothing is mirrored
 * into memory.
 */
export class PulseClient {
  private readonly log: Logger;

  constructor(private readonly opts: PulseClientOptions) {
    this.log = (opts.logger ?? nullLogger).child().withContext({ component: "pulse" });
  }

  /**
   * Run a pulse invocation and return its trimmed text output. Throws
   * {@link PulseError} on a non-zero exit, carrying stderr (or stdout) and the
   * code. Rejects (without a {@link PulseError}) if the binary itself cannot be
   * spawned (e.g. `pulse` not on PATH) — {@link execCommand} surfaces that as a
   * plain spawn error.
   */
  private async exec(args: string[], signal?: AbortSignal): Promise<string> {
    const result = await execCommand(this.opts.bin, args, {
      signal,
      logger: this.log,
      maxOutputBytes: this.opts.maxOutputBytes,
    });
    if (result.exitCode !== 0) {
      const message =
        result.stderr.trim() || result.stdout.trim() || `pulse exited ${result.exitCode}`;
      this.log
        .withMetadata({ args: redactArgs(args), exitCode: result.exitCode })
        .warn("pulse returned an error");
      throw new PulseError(message, result.exitCode);
    }
    const out = result.stdout.trim();
    const err = result.stderr.trim();
    if (out && err) return `${out}\n${err}`;
    return out || err;
  }

  private nodeFlag(node?: string): string[] {
    return node ? ["--node", validateId(node)] : [];
  }

  private composeFlag(compose?: string): string[] {
    return compose ? ["--compose", validateFreeText(compose, "compose")] : [];
  }

  /** List all agents (nodes/VMs) pulse knows about. */
  listNodes(signal?: AbortSignal): Promise<string> {
    return this.exec(["nodes"], signal);
  }

  /** List containers on a node (pulse's default node when omitted). */
  listContainers(node?: string, signal?: AbortSignal): Promise<string> {
    return this.exec(["ps", ...this.nodeFlag(node)], signal);
  }

  /** List images on a node (pulse's default node when omitted). */
  listImages(node?: string, signal?: AbortSignal): Promise<string> {
    return this.exec(["images", ...this.nodeFlag(node)], signal);
  }

  /** Pull an image on a node (pulse's default node when omitted). */
  pullImage(image: string, node?: string, signal?: AbortSignal): Promise<string> {
    return this.exec(["pull", validateArg(image, "image"), ...this.nodeFlag(node)], signal);
  }

  /** Deploy/restart a Docker Compose stack on a node. */
  up(input: ComposeInput = {}, signal?: AbortSignal): Promise<string> {
    return this.exec(
      ["up", ...this.nodeFlag(input.node), ...this.composeFlag(input.compose)],
      signal,
    );
  }

  /** Stop a Docker Compose stack on a node. */
  down(input: ComposeInput = {}, signal?: AbortSignal): Promise<string> {
    return this.exec(
      ["down", ...this.nodeFlag(input.node), ...this.composeFlag(input.compose)],
      signal,
    );
  }

  /** View logs of a Docker Compose stack on a node. */
  logs(input: ComposeInput = {}, signal?: AbortSignal): Promise<string> {
    return this.exec(
      ["logs", ...this.nodeFlag(input.node), ...this.composeFlag(input.compose)],
      signal,
    );
  }
}
