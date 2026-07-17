/**
 * Trace viewing surface (TAV-115, phase 3): a small HTTP server that turns the raw
 * JSONL traces `TraceRecorder` writes into a browsable session timeline — tool calls,
 * assistant turns, and the `analyzeSession` lints — without reading raw lines.
 *
 * Same shape as {@link import("../metrics/server.ts").MetricsServer}: a pure request
 * handler (unit-testable without a real listener) wrapped by a thin `Bun.serve` class.
 * No frontend build step — the page is a single inlined HTML/CSS/JS string served at
 * `/`, fetching JSON from `/api/sessions` and `/api/sessions/:id`.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import type { Logger } from "../logger.ts";
import { analyzeSession, collectTraceFiles, parseTrace, type SessionReport } from "./extract.ts";
import type { TraceEvent } from "./recorder.ts";

export interface SessionSummary {
  sessionId: string;
  events: number;
  turns: number;
  erroredTurns: number;
  lints: number;
  mtimeMs: number;
}

export interface SessionDetail {
  report: SessionReport;
  events: TraceEvent[];
}

function listTraceFiles(tracesDir: string): string[] {
  if (!existsSync(tracesDir)) return [];
  return collectTraceFiles([tracesDir]);
}

/** Every session under `tracesDir`, most recently modified first. */
export function listSessions(tracesDir: string): SessionSummary[] {
  return listTraceFiles(tracesDir)
    .map((file) => {
      const sessionId = basename(file, ".jsonl");
      const report = analyzeSession(sessionId, parseTrace(readFileSync(file, "utf8")));
      return {
        sessionId,
        events: report.events,
        turns: report.turns,
        erroredTurns: report.erroredTurns,
        lints: report.lints.length,
        mtimeMs: statSync(file).mtimeMs,
      };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/** One session's full report + raw events, or `undefined` if no trace file matches. */
export function loadSession(tracesDir: string, sessionId: string): SessionDetail | undefined {
  // basename() strips any path components a caller-supplied id might carry, so this
  // can never resolve outside tracesDir regardless of what the URL segment contains.
  const safeId = basename(sessionId);
  const file = join(tracesDir, `${safeId}.jsonl`);
  if (!existsSync(file)) return undefined;
  const events = parseTrace(readFileSync(file, "utf8"));
  return { report: analyzeSession(safeId, events), events };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const INDEX_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>ppmagent — trace viewer</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  #layout { display: flex; height: 100vh; }
  #sidebar { width: 300px; overflow-y: auto; border-right: 1px solid #8884; flex-shrink: 0; }
  #sidebar h1 { font-size: 15px; padding: 12px; margin: 0; border-bottom: 1px solid #8884; }
  .session-item { padding: 10px 12px; border-bottom: 1px solid #8882; cursor: pointer; }
  .session-item:hover { background: #8881; }
  .session-item.active { background: #4a90e21a; border-left: 3px solid #4a90e2; }
  .session-item .id { font-weight: 600; word-break: break-all; }
  .session-item .meta { font-size: 12px; opacity: 0.7; margin-top: 2px; }
  .badge { display: inline-block; border-radius: 3px; padding: 0 5px; font-size: 11px; margin-right: 4px; }
  .badge.err { background: #e2504a33; color: #e2504a; }
  .badge.lint { background: #e2a54a33; color: #e2a54a; }
  #main { flex: 1; overflow-y: auto; padding: 16px 24px; }
  #empty { opacity: 0.6; padding: 24px; }
  .event { display: flex; gap: 10px; padding: 6px 0; border-bottom: 1px solid #8881; align-items: baseline; }
  .event .ts { font-size: 11px; opacity: 0.55; width: 78px; flex-shrink: 0; }
  .event .type { font-size: 11px; text-transform: uppercase; letter-spacing: 0.03em; width: 130px; flex-shrink: 0; opacity: 0.8; }
  .event .detail { flex: 1; white-space: pre-wrap; word-break: break-word; }
  .event.tool_start .type { color: #4a90e2; }
  .event.tool_end .type { color: #4a90e2; }
  .event.tool_end.error .detail { color: #e2504a; }
  .event.assistant_message .type { color: #7b4ae2; }
  .event.turn_start .type, .event.turn_end .type { color: #4ae27b; font-weight: 600; }
  .event.compaction .type { color: #e2a54a; }
  #lints { margin: 16px 0; padding: 10px 14px; background: #e2a54a14; border: 1px solid #e2a54a55; border-radius: 6px; }
  #lints h2 { font-size: 13px; margin: 0 0 6px; }
  #lints .lint { font-size: 12.5px; padding: 2px 0; }
  #summary { font-size: 13px; opacity: 0.75; margin-bottom: 14px; }
  code { font-family: ui-monospace, SFMono-Regular, monospace; font-size: 12.5px; }
</style>
</head>
<body>
<div id="layout">
  <div id="sidebar">
    <h1>Sessions</h1>
    <div id="session-list">Loading…</div>
  </div>
  <div id="main"><div id="empty">Select a session to view its timeline.</div></div>
</div>
<script>
async function fetchJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(res.status + " " + res.statusText);
  return res.json();
}

function fmtTs(ts) {
  const d = new Date(ts);
  return d.toISOString().slice(11, 23);
}

function eventDetail(ev) {
  switch (ev.type) {
    case "tool_start":
      return (ev.tool || "") + " " + JSON.stringify(ev.args ?? {});
    case "tool_end":
      return (ev.tool || "") + (ev.isError ? " FAILED" : " ok") +
        (ev.result !== undefined ? " " + JSON.stringify(ev.result) : "");
    case "assistant_message":
      return ev.text || "(no text)";
    case "turn_start":
      return "turn started";
    case "turn_end":
      return "turn ended in " + (ev.durationMs ?? "?") + "ms" + (ev.error ? " — error: " + ev.error : "");
    case "compaction":
      return "compacted " + (ev.tokensBefore ?? "?") + " → " + (ev.tokensAfter ?? "?") + " tokens";
    default:
      return JSON.stringify(ev);
  }
}

function renderSessionList(sessions, activeId) {
  const el = document.getElementById("session-list");
  if (sessions.length === 0) {
    el.innerHTML = '<div id="empty">No trace files found.</div>';
    return;
  }
  el.innerHTML = sessions.map((s) => \`
    <div class="session-item \${s.sessionId === activeId ? 'active' : ''}" data-id="\${s.sessionId}">
      <div class="id">\${s.sessionId}</div>
      <div class="meta">\${s.turns} turns · \${s.events} events
        \${s.erroredTurns ? \`<span class="badge err">\${s.erroredTurns} errored</span>\` : ''}
        \${s.lints ? \`<span class="badge lint">\${s.lints} lint</span>\` : ''}
      </div>
    </div>\`).join("");
  el.querySelectorAll(".session-item").forEach((node) => {
    node.addEventListener("click", () => selectSession(node.dataset.id, sessions));
  });
}

function renderDetail(detail) {
  const main = document.getElementById("main");
  const r = detail.report;
  const lints = r.lints.length
    ? \`<div id="lints"><h2>Lint findings (\${r.lints.length})</h2>\${
        r.lints.map((l) => \`<div class="lint">turn \${l.turn} — <code>\${l.rule}</code>: \${l.message}</div>\`).join("")
      }</div>\`
    : "";
  const events = detail.events.map((ev) => \`
    <div class="event \${ev.type}\${ev.isError ? ' error' : ''}">
      <div class="ts">\${fmtTs(ev.ts)}</div>
      <div class="type">\${ev.type}</div>
      <div class="detail">\${eventDetail(ev)}</div>
    </div>\`).join("");
  main.innerHTML = \`
    <div id="summary">\${r.turns} turns (\${r.erroredTurns} errored) · \${r.events} events ·
      avg turn \${r.turnDurationMs.avg}ms (max \${r.turnDurationMs.max}ms)</div>
    \${lints}
    \${events}\`;
}

async function selectSession(id, sessions) {
  renderSessionList(sessions, id);
  const detail = await fetchJSON("/api/sessions/" + encodeURIComponent(id));
  renderDetail(detail);
}

(async function init() {
  const sessions = await fetchJSON("/api/sessions");
  renderSessionList(sessions, null);
})().catch((err) => {
  document.getElementById("session-list").textContent = "Failed to load: " + err.message;
});
</script>
</body>
</html>
`;

/** Pure request handler, exported for unit testing without starting a real server. */
export function handleViewerRequest(req: Request, tracesDir: string): Response {
  if (req.method !== "GET") {
    return new Response("Method Not Allowed", { status: 405 });
  }
  const url = new URL(req.url);

  if (url.pathname === "/") {
    return new Response(INDEX_HTML, {
      status: 200,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }
  if (url.pathname === "/api/sessions") {
    return jsonResponse(listSessions(tracesDir));
  }
  const match = url.pathname.match(/^\/api\/sessions\/([^/]+)$/);
  if (match?.[1]) {
    const detail = loadSession(tracesDir, decodeURIComponent(match[1]));
    if (!detail) return new Response("Not Found", { status: 404 });
    return jsonResponse(detail);
  }
  return new Response("Not Found", { status: 404 });
}

export interface TraceViewerServerOptions {
  port: number;
  tracesDir: string;
  logger: Logger;
}

export class TraceViewerServer {
  private server: ReturnType<typeof Bun.serve> | null = null;

  constructor(private readonly opts: TraceViewerServerOptions) {}

  start(): void {
    const { port, tracesDir, logger } = this.opts;
    this.server = Bun.serve({
      port,
      fetch: (req) => handleViewerRequest(req, tracesDir),
    });
    logger.withMetadata({ port }).info("trace viewer server listening");
  }

  stop(): void {
    this.server?.stop();
    this.server = null;
  }
}
