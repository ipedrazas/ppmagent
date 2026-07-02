import { describe, expect, test } from "bun:test";
import { execCommand } from "../src/exec.ts";

describe("execCommand", () => {
  test("returns exit code 0 for a successful process", async () => {
    const result = await execCommand("true", []);
    expect(result.exitCode).toBe(0);
  });

  test("returns the non-zero exit code from the process", async () => {
    const result = await execCommand("sh", ["-c", "exit 42"]);
    expect(result.exitCode).toBe(42);
  });

  test("captures stdout and stderr", async () => {
    const result = await execCommand("sh", ["-c", "echo hello && echo err >&2"]);
    expect(result.stdout.trim()).toBe("hello");
    expect(result.stderr.trim()).toBe("err");
    expect(result.exitCode).toBe(0);
  });

  test("reports a signal-killed process as failure", async () => {
    // The process sends SIGTERM to itself; Node sees code=null, signal='SIGTERM'.
    // Before the fix this returned exitCode 0 (false success).
    const result = await execCommand("sh", ["-c", "kill -TERM $$"]);
    expect(result.exitCode).not.toBe(0);
  });
});
