import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MAX_PAYLOAD_CHARS, TraceRecorder, clipPayload } from "../src/trace/recorder.ts";

describe("clipPayload", () => {
  test("passes small values through untouched", () => {
    const value = { project: "a2", type: "decision" };
    expect(clipPayload(value)).toBe(value);
  });

  test("replaces oversized values with a truncation marker", () => {
    const value = { prompt: "x".repeat(MAX_PAYLOAD_CHARS * 2) };
    const clipped = clipPayload(value) as { truncated: string };
    expect(clipped.truncated.length).toBe(MAX_PAYLOAD_CHARS);
    expect(clipped.truncated).toContain('"prompt"');
  });
});

describe("TraceRecorder", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(import.meta.dir, ".traceroot-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const readLines = (dir: string, sessionId: string) =>
    readFileSync(join(dir, `${sessionId}.jsonl`), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as Record<string, unknown>);

  test("appends one JSON line per event with a timestamp", () => {
    const dir = join(root, "traces");
    const recorder = new TraceRecorder(dir);
    recorder.setSession("s-1");
    recorder.record({ type: "turn_start", chatId: 7 });
    recorder.record({ type: "turn_end", durationMs: 42 });

    const lines = readLines(dir, "s-1");
    expect(lines.length).toBe(2);
    expect(lines[0]?.type).toBe("turn_start");
    expect(lines[0]?.chatId).toBe(7);
    expect(typeof lines[0]?.ts).toBe("number");
    expect(lines[1]?.type).toBe("turn_end");
  });

  test("setSession redirects subsequent events to the new session's file", () => {
    const dir = join(root, "traces");
    const recorder = new TraceRecorder(dir);
    recorder.setSession("s-1");
    recorder.record({ type: "turn_start" });
    recorder.setSession("s-2");
    recorder.record({ type: "turn_start" });

    expect(readLines(dir, "s-1").length).toBe(1);
    expect(readLines(dir, "s-2").length).toBe(1);
  });

  test("drops events silently when no session was ever set", () => {
    const recorder = new TraceRecorder(join(root, "traces"));
    expect(() => recorder.record({ type: "turn_start" })).not.toThrow();
  });

  test("an unwritable directory drops the event instead of throwing", () => {
    // The "directory" is a file, so mkdir/append inside it must fail.
    const blocked = join(root, "not-a-dir");
    writeFileSync(blocked, "occupied");
    const recorder = new TraceRecorder(blocked);
    recorder.setSession("s-1");
    expect(() => recorder.record({ type: "turn_start" })).not.toThrow();
  });
});
