import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { TraceRecorder } from "../src/trace/recorder.ts";
import { handleViewerRequest, listSessions, loadSession } from "../src/trace/viewer-server.ts";

function makeRequest(path: string, method = "GET"): Request {
  return new Request(`http://localhost${path}`, { method });
}

describe("trace viewer over a real traces directory", () => {
  let root: string;
  let tracesDir: string;

  beforeEach(() => {
    root = mkdtempSync(join(import.meta.dir, ".viewerroot-"));
    tracesDir = join(root, "traces");
    const recorder = new TraceRecorder(tracesDir);
    recorder.setSession("s-1");
    recorder.record({ type: "turn_start" });
    recorder.record({ type: "tool_start", tool: "memory_list", args: {} });
    recorder.record({ type: "tool_end", tool: "memory_list", isError: false });
    recorder.record({ type: "turn_end", durationMs: 42 });
    recorder.setSession("s-2");
    recorder.record({ type: "turn_start" });
    recorder.record({ type: "turn_end", durationMs: 7, error: "boom" });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("listSessions returns a summary per trace file, most recent first", () => {
    const sessions = listSessions(tracesDir);
    expect(sessions.length).toBe(2);
    const ids = sessions.map((s) => s.sessionId).sort();
    expect(ids).toEqual(["s-1", "s-2"]);
    const s1 = sessions.find((s) => s.sessionId === "s-1");
    expect(s1?.turns).toBe(1);
    expect(s1?.events).toBe(4);
    expect(s1?.erroredTurns).toBe(0);
  });

  test("listSessions returns an empty list when the traces dir doesn't exist yet", () => {
    expect(listSessions(join(root, "never-created"))).toEqual([]);
  });

  test("loadSession returns the full report and raw events for a known session", () => {
    const detail = loadSession(tracesDir, "s-2");
    expect(detail).toBeDefined();
    expect(detail?.report.erroredTurns).toBe(1);
    expect(detail?.events.length).toBe(2);
  });

  test("loadSession returns undefined for an unknown session", () => {
    expect(loadSession(tracesDir, "does-not-exist")).toBeUndefined();
  });

  test("loadSession is not fooled by a path-traversal session id", () => {
    expect(loadSession(tracesDir, "../../../etc/passwd")).toBeUndefined();
  });

  test("GET / serves the HTML page", async () => {
    const res = handleViewerRequest(makeRequest("/"), tracesDir);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/html");
    const body = await res.text();
    expect(body).toContain("<title>ppmagent — trace viewer</title>");
  });

  test("GET /api/sessions returns JSON summaries", async () => {
    const res = handleViewerRequest(makeRequest("/api/sessions"), tracesDir);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sessionId: string }[];
    expect(body.length).toBe(2);
  });

  test("GET /api/sessions/:id returns the session detail", async () => {
    const res = handleViewerRequest(makeRequest("/api/sessions/s-1"), tracesDir);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { report: { turns: number }; events: unknown[] };
    expect(body.report.turns).toBe(1);
    expect(body.events.length).toBe(4);
  });

  test("GET /api/sessions/:id returns 404 for an unknown id", () => {
    const res = handleViewerRequest(makeRequest("/api/sessions/nope"), tracesDir);
    expect(res.status).toBe(404);
  });

  test("returns 404 for unknown paths", () => {
    const res = handleViewerRequest(makeRequest("/health"), tracesDir);
    expect(res.status).toBe(404);
  });

  test("returns 405 for non-GET methods", () => {
    const res = handleViewerRequest(makeRequest("/", "POST"), tracesDir);
    expect(res.status).toBe(405);
  });
});
