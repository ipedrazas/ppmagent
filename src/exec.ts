import { spawn } from "node:child_process";
import { type Logger, nullLogger } from "./logger.ts";

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface ExecOptions {
  env?: Record<string, string | undefined>;
  signal?: AbortSignal;
  /** Logger for subprocess lifecycle lines. Defaults to the discarding logger. */
  logger?: Logger;
}

/**
 * Run a subprocess and collect its output. Resolves with the captured
 * stdout/stderr and exit code (never rejects on a non-zero exit — callers
 * decide what a non-zero code means). Rejects only if the process cannot be
 * spawned at all.
 *
 * Each invocation logs at `debug` on completion (with exit code and duration)
 * and at `error` if the process fails to spawn. The argv is logged as-is; the
 * `ppm`/`dbxcli` callers do not pass secrets on the command line.
 */
export function execCommand(
  bin: string,
  args: string[],
  opts: ExecOptions = {},
): Promise<ExecResult> {
  const log = (opts.logger ?? nullLogger).withContext({ bin });
  const startedAt = performance.now();
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      env: { ...process.env, ...opts.env },
      signal: opts.signal,
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      log.withError(error).withMetadata({ args }).error("subprocess failed to spawn");
      reject(error);
    });
    child.on("close", (code) => {
      const exitCode = code ?? 0;
      log
        .withMetadata({ args, exitCode, durationMs: Math.round(performance.now() - startedAt) })
        .debug("subprocess completed");
      resolve({ stdout, stderr, exitCode });
    });
  });
}
