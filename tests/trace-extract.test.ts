import { describe, expect, test } from "bun:test";
import { analyzeSession, parseTrace, renderReport } from "../src/trace/extract.ts";
import type { TraceEvent } from "../src/trace/recorder.ts";

let ts = 0;
const ev = (type: string, fields: Record<string, unknown> = {}): TraceEvent => ({
  ts: ++ts,
  type,
  ...fields,
});

const toolStart = (tool: string, args: Record<string, unknown> = {}) =>
  ev("tool_start", { tool, toolCallId: `c-${ts}`, args });
const toolEnd = (tool: string, isError = false) =>
  ev("tool_end", { tool, toolCallId: `c-${ts}`, isError });

describe("parseTrace", () => {
  test("parses JSONL and skips torn/garbage lines", () => {
    const raw = [
      JSON.stringify({ ts: 1, type: "turn_start" }),
      "{ torn line",
      "",
      JSON.stringify({ ts: 2, type: "turn_end", durationMs: 5 }),
      '"not an object"',
    ].join("\n");
    const events = parseTrace(raw);
    expect(events.length).toBe(2);
    expect(events[0]?.type).toBe("turn_start");
    expect(events[1]?.type).toBe("turn_end");
  });
});

describe("analyzeSession metrics", () => {
  test("counts turns, durations, tool calls/errors, and compactions", () => {
    const report = analyzeSession("s-1", [
      ev("turn_start", { chatId: 1, chars: 10 }),
      toolStart("memory_list"),
      toolEnd("memory_list"),
      toolStart("tracker_list_tasks"),
      toolEnd("tracker_list_tasks", true),
      ev("turn_end", { durationMs: 100, replies: 1 }),
      ev("compaction", { tokensBefore: 5_000, tokensAfter: 2_000, messagesAfter: 7 }),
      ev("turn_start", { chatId: 1, chars: 5 }),
      ev("turn_end", { durationMs: 300, error: "boom" }),
    ]);
    expect(report.turns).toBe(2);
    expect(report.erroredTurns).toBe(1);
    expect(report.turnDurationMs).toEqual({ avg: 200, max: 300 });
    expect(report.tools.memory_list).toEqual({ calls: 1, errors: 0 });
    expect(report.tools.tracker_list_tasks).toEqual({ calls: 1, errors: 1 });
    expect(report.compactions).toEqual({ count: 1, tokensReclaimed: 3_000 });
  });

  test("an empty session reports zeros and no lints", () => {
    const report = analyzeSession("s-0", []);
    expect(report.turns).toBe(0);
    expect(report.turnDurationMs).toEqual({ avg: 0, max: 0 });
    expect(report.lints).toEqual([]);
  });
});

describe("lints", () => {
  test("orient-before-read: targeted memory_read before any memory_list", () => {
    const report = analyzeSession("s", [
      ev("turn_start"),
      toolStart("memory_read", { project: "a2", type: "decision" }),
      toolEnd("memory_read"),
      ev("turn_end", { durationMs: 1 }),
    ]);
    expect(report.lints.map((l) => l.rule)).toEqual(["orient-before-read"]);
  });

  test("orient-before-read does not fire after memory_list, or for index reads", () => {
    const report = analyzeSession("s", [
      ev("turn_start"),
      toolStart("memory_read", {}), // workspace index — orientation itself
      toolEnd("memory_read"),
      toolStart("memory_list"),
      toolEnd("memory_list"),
      toolStart("memory_read", { project: "a2", type: "decision" }),
      toolEnd("memory_read"),
      ev("turn_end", { durationMs: 1 }),
    ]);
    expect(report.lints).toEqual([]);
  });

  test("ask-user-batched: another tool after ask_user in the same turn", () => {
    const report = analyzeSession("s", [
      ev("turn_start"),
      toolStart("ask_user", { question: "which team?", project: "a2" }),
      toolStart("tracker_list_teams"),
      ev("turn_end", { durationMs: 1 }),
    ]);
    expect(report.lints.map((l) => l.rule)).toEqual(["ask-user-batched"]);
  });

  test("ask-user-batched does not fire across turns", () => {
    const report = analyzeSession("s", [
      ev("turn_start"),
      toolStart("ask_user", { question: "q", project: "a2" }),
      ev("turn_end", { durationMs: 1 }),
      ev("turn_start"),
      toolStart("tracker_list_teams"),
      ev("turn_end", { durationMs: 1 }),
    ]);
    expect(report.lints).toEqual([]);
  });

  test("ask-user-no-project: the open question is not persisted", () => {
    const report = analyzeSession("s", [
      ev("turn_start"),
      toolStart("ask_user", { question: "which team?" }),
      ev("turn_end", { durationMs: 1 }),
    ]);
    expect(report.lints.map((l) => l.rule)).toEqual(["ask-user-no-project"]);
  });

  test("missing-task-rationale: create with no memory_write in the turn", () => {
    const report = analyzeSession("s", [
      ev("turn_start"),
      toolStart("tracker_create_task", { title: "t" }),
      toolEnd("tracker_create_task"),
      ev("turn_end", { durationMs: 1 }),
    ]);
    expect(report.lints.map((l) => l.rule)).toEqual(["missing-task-rationale"]);
    expect(report.lints[0]?.turn).toBe(1);
  });

  test("missing-task-rationale satisfied by a memory_write in the same turn", () => {
    const report = analyzeSession("s", [
      ev("turn_start"),
      toolStart("tracker_create_task", { title: "t" }),
      toolEnd("tracker_create_task"),
      toolStart("memory_write", { project: "a2", type: "task", ref: "TAV-1" }),
      toolEnd("memory_write"),
      ev("turn_end", { durationMs: 1 }),
    ]);
    expect(report.lints).toEqual([]);
  });

  test("missing-task-rationale not triggered by a failed create", () => {
    const report = analyzeSession("s", [
      ev("turn_start"),
      toolStart("tracker_create_task", { title: "t" }),
      toolEnd("tracker_create_task", true),
      ev("turn_end", { durationMs: 1 }),
    ]);
    expect(report.lints).toEqual([]);
  });

  test("tool-retry-loop: three consecutive errors of the same tool, flagged once", () => {
    const report = analyzeSession("s", [
      ev("turn_start"),
      toolStart("proteos_task_get"),
      toolEnd("proteos_task_get", true),
      toolStart("proteos_task_get"),
      toolEnd("proteos_task_get", true),
      toolStart("proteos_task_get"),
      toolEnd("proteos_task_get", true),
      toolStart("proteos_task_get"),
      toolEnd("proteos_task_get", true),
      ev("turn_end", { durationMs: 1 }),
    ]);
    expect(report.lints.filter((l) => l.rule === "tool-retry-loop").length).toBe(1);
  });

  test("tool-retry-loop reset by a success or a different tool", () => {
    const report = analyzeSession("s", [
      ev("turn_start"),
      toolStart("proteos_task_get"),
      toolEnd("proteos_task_get", true),
      toolStart("proteos_task_get"),
      toolEnd("proteos_task_get", true),
      toolStart("proteos_task_get"),
      toolEnd("proteos_task_get"), // success resets the streak
      toolStart("proteos_task_get"),
      toolEnd("proteos_task_get", true),
      ev("turn_end", { durationMs: 1 }),
    ]);
    expect(report.lints).toEqual([]);
  });
});

describe("renderReport", () => {
  test("includes headline, tool lines, and lint lines", () => {
    const report = analyzeSession("abc123", [
      ev("turn_start"),
      toolStart("ask_user", { question: "q" }),
      ev("turn_end", { durationMs: 10, replies: 1 }),
    ]);
    const text = renderReport(report);
    expect(text).toContain("session abc123 — 1 turns");
    expect(text).toContain("ask_user: 1 calls");
    expect(text).toContain("LINT [ask-user-no-project]");
  });
});
