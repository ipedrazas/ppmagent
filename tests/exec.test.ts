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

describe("execCommand — output cap (maxOutputBytes)", () => {
  test("does not truncate when output is within the limit", async () => {
    const result = await execCommand("sh", ["-c", "printf 'hello'"], {
      maxOutputBytes: 1000,
    });
    expect(result.stdout).toBe("hello");
    expect(result.truncated).toBeUndefined();
  });

  test("truncates stdout when combined output exceeds the cap", async () => {
    // Emit 200 bytes then check that cap=100 truncates it.
    const result = await execCommand("sh", ["-c", "printf '%200s' | tr ' ' 'a'"], {
      maxOutputBytes: 100,
    });
    expect(result.truncated).toBe(true);
    expect(result.stdout).toContain("[output truncated: limit 100 bytes]");
  });

  test("truncated result still has a valid exit code", async () => {
    const result = await execCommand("sh", ["-c", "printf '%200s' | tr ' ' 'a'"], {
      maxOutputBytes: 50,
    });
    expect(result.exitCode).toBe(0);
    expect(result.truncated).toBe(true);
  });

  test("counts combined stdout+stderr toward the cap", async () => {
    // 60 bytes to stdout + 60 bytes to stderr = 120 bytes total, cap = 100
    const result = await execCommand(
      "sh",
      ["-c", "printf '%60s' | tr ' ' 'a'; printf '%60s' | tr ' ' 'b' >&2"],
      { maxOutputBytes: 100 },
    );
    expect(result.truncated).toBe(true);
  });

  test("maxOutputBytes=0 means unlimited", async () => {
    const result = await execCommand("sh", ["-c", "printf '%500s' | tr ' ' 'x'"], {
      maxOutputBytes: 0,
    });
    expect(result.truncated).toBeUndefined();
    expect(result.stdout).toHaveLength(500);
  });
});
