import { spawn } from "node:child_process";
import { type Logger, nullLogger } from "./logger.ts";
import { redactArgs } from "./redact.ts";

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  /** True when combined stdout+stderr was cut at {@link ExecOptions.maxOutputBytes}. */
  truncated?: boolean;
}

export interface ExecOptions {
  env?: Record<string, string | undefined>;
  signal?: AbortSignal;
  /** Logger for subprocess lifecycle lines. Defaults to the discarding logger. */
  logger?: Logger;
  /**
   * Cap combined stdout+stderr at this many bytes. When exceeded, accumulation
   * stops and a warning line is appended to stdout. 0 = unlimited.
   */
  maxOutputBytes?: number;
}

/**
 * Run a subprocess and collect its output. Resolves with the captured
 * stdout/stderr and exit code (never rejects on a non-zero exit — callers
 * decide what a non-zero code means). Rejects only if the process cannot be
 * spawned at all.
 *
 * Each invocation logs at `debug` on completion (with exit code and duration)
 * and at `error` if the process fails to spawn. The argv is sanitised with
 * {@link redactArgs} before logging so sensitive flag values are masked.
 */
export function execCommand(
  bin: string,
  args: string[],
  opts: ExecOptions = {},
): Promise<ExecResult> {
  const log = (opts.logger ?? nullLogger).withContext({ bin });
  const safeArgs = redactArgs(args);
  const startedAt = performance.now();
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      env: { ...process.env, ...opts.env },
      signal: opts.signal,
    });

    let stdout = "";
    let stderr = "";
    const cap = opts.maxOutputBytes ?? 0;
    let totalBytes = 0;
    let truncated = false;

    child.stdout.on("data", (chunk: Buffer) => {
      if (cap > 0 && totalBytes >= cap) {
        truncated = true;
        return;
      }
      if (cap > 0) {
        const remaining = cap - totalBytes;
        if (chunk.length > remaining) {
          stdout += chunk.slice(0, remaining).toString();
          totalBytes = cap;
          truncated = true;
          return;
        }
        totalBytes += chunk.length;
      }
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (cap > 0 && totalBytes >= cap) {
        truncated = true;
        return;
      }
      if (cap > 0) {
        const remaining = cap - totalBytes;
        if (chunk.length > remaining) {
          stderr += chunk.slice(0, remaining).toString();
          totalBytes = cap;
          truncated = true;
          return;
        }
        totalBytes += chunk.length;
      }
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      log.withError(error).withMetadata({ args: safeArgs }).error("subprocess failed to spawn");
      reject(error);
    });
    child.on("close", (code, signal) => {
      const exitCode = code ?? (signal !== null ? 1 : 0);
      if (truncated) {
        stdout += `\n[output truncated: limit ${cap} bytes]`;
        log.withMetadata({ args: safeArgs, cap }).warn("subprocess output truncated");
      }
      log
        .withMetadata({
          args: safeArgs,
          exitCode,
          signal: signal ?? undefined,
          durationMs: Math.round(performance.now() - startedAt),
          ...(truncated ? { truncated: true } : {}),
        })
        .debug("subprocess completed");
      resolve({ stdout, stderr, exitCode, ...(truncated ? { truncated: true } : {}) });
    });
  });
}
