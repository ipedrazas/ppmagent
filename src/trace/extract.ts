/**
 * Deterministic session-trace extractor: metrics + rule-lints over the JSONL
 * traces the {@link import("./recorder.ts").TraceRecorder} appends. No LLM —
 * every finding is a mechanical check, most derived from the operating rules
 * in the agent's SYSTEM_PROMPT (which is a checkable spec, not prose).
 *
 * Run it directly:
 *   bun src/trace/extract.ts [--json] [dir-or-file ...]
 * With no path arguments it reads ./.session/traces/*.jsonl.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import type { TraceEvent } from "./recorder.ts";

// ── Report shapes ────────────────────────────────────────────────────────────

export interface ToolStats {
  calls: number;
  errors: number;
}

export interface Lint {
  /** Stable rule id, e.g. "orient-before-read". */
  rule: string;
  /** 1-based turn number the finding occurred in (0 = outside any turn). */
  turn: number;
  message: string;
}

export interface SessionReport {
  sessionId: string;
  events: number;
  turns: number;
  erroredTurns: number;
  /** From turn_end durations; zeros when the session has no completed turns. */
  turnDurationMs: { avg: number; max: number };
  tools: Record<string, ToolStats>;
  compactions: { count: number; tokensReclaimed: number };
  lints: Lint[];
}

// ── Parsing ──────────────────────────────────────────────────────────────────

/** Parse JSONL, skipping malformed lines (a torn tail write must not kill analysis). */
export function parseTrace(raw: string): TraceEvent[] {
  const events: TraceEvent[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as TraceEvent;
      if (typeof parsed === "object" && parsed !== null && typeof parsed.type === "string") {
        events.push(parsed);
      }
    } catch {
      // skip torn/garbage line
    }
  }
  return events;
}

// ── Analysis ─────────────────────────────────────────────────────────────────

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const num = (v: unknown): number => (typeof v === "number" ? v : 0);
const rec = (v: unknown): Record<string, unknown> =>
  typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};

/** Consecutive same-tool errors at or past this count flag a retry loop. */
export const RETRY_LOOP_THRESHOLD = 3;

/**
 * Analyze one session's events. Pure — the CLI wrapper handles files.
 *
 * Lints (rule ids) and the SYSTEM_PROMPT rules they check:
 * - orient-before-read      "ORIENT before acting: call memory_list before
 *                           reading specific entries" — a targeted memory_read
 *                           (project + type/name) with no earlier memory_list.
 * - ask-user-batched        "Never batch ask_user with other tools" — another
 *                           tool started after ask_user in the same turn.
 * - ask-user-no-project     ask_user without `project`: the open question is
 *                           not recorded durably in memory.
 * - missing-task-rationale  "After tracker_create_task ... record the
 *                           rationale with memory_write" — a successful create
 *                           with no memory_write in the same turn.
 * - tool-retry-loop         >= RETRY_LOOP_THRESHOLD consecutive errors from
 *                           the same tool.
 */
export function analyzeSession(sessionId: string, events: TraceEvent[]): SessionReport {
  const tools: Record<string, ToolStats> = {};
  const lints: Lint[] = [];
  const durations: number[] = [];

  let turn = 0;
  let erroredTurns = 0;
  let compactions = 0;
  let tokensReclaimed = 0;

  let seenMemoryList = false;
  // Per-turn state, reset on turn_start.
  let askUserSeenInTurn = false;
  let createsPendingRationale: string[] = [];
  let memoryWriteInTurn = false;
  // Retry-loop state, spanning turns.
  let streakTool = "";
  let streakLen = 0;
  let streakFlagged = false;

  const closeTurn = () => {
    for (const ref of createsPendingRationale) {
      if (!memoryWriteInTurn) {
        lints.push({
          rule: "missing-task-rationale",
          turn,
          message: `tracker create (${ref}) with no memory_write in the same turn — rationale not recorded`,
        });
      }
    }
    createsPendingRationale = [];
    memoryWriteInTurn = false;
    askUserSeenInTurn = false;
  };

  for (const event of events) {
    switch (event.type) {
      case "turn_start": {
        closeTurn();
        turn += 1;
        break;
      }
      case "turn_end": {
        durations.push(num(event.durationMs));
        if (event.error !== undefined) erroredTurns += 1;
        closeTurn();
        break;
      }
      case "compaction": {
        compactions += 1;
        tokensReclaimed += Math.max(0, num(event.tokensBefore) - num(event.tokensAfter));
        break;
      }
      case "tool_start": {
        const tool = str(event.tool);
        const args = rec(event.args);
        tools[tool] ??= { calls: 0, errors: 0 };
        tools[tool].calls += 1;

        if (tool === "memory_list") seenMemoryList = true;
        if (tool === "memory_write") memoryWriteInTurn = true;

        if (
          tool === "memory_read" &&
          !seenMemoryList &&
          str(args.project) &&
          (str(args.type) || str(args.name))
        ) {
          lints.push({
            rule: "orient-before-read",
            turn,
            message: `memory_read of ${str(args.project)}/${str(args.type) || str(args.name)} before any memory_list`,
          });
        }

        if (tool === "ask_user") {
          askUserSeenInTurn = true;
          if (!str(args.project)) {
            lints.push({
              rule: "ask-user-no-project",
              turn,
              message: "ask_user without `project` — the open question is not recorded in memory",
            });
          }
        } else if (askUserSeenInTurn) {
          lints.push({
            rule: "ask-user-batched",
            turn,
            message: `${tool} called after ask_user in the same turn — ask_user must stand alone`,
          });
        }
        break;
      }
      case "tool_end": {
        const tool = str(event.tool);
        const isError = event.isError === true;
        tools[tool] ??= { calls: 0, errors: 0 };
        if (isError) tools[tool].errors += 1;

        if (!isError && (tool === "tracker_create_task" || tool === "tracker_create_project")) {
          createsPendingRationale.push(tool);
        }

        if (isError && tool === streakTool) {
          streakLen += 1;
        } else {
          streakTool = isError ? tool : "";
          streakLen = isError ? 1 : 0;
          streakFlagged = false;
        }
        if (streakLen >= RETRY_LOOP_THRESHOLD && !streakFlagged) {
          streakFlagged = true;
          lints.push({
            rule: "tool-retry-loop",
            turn,
            message: `${tool} failed ${streakLen}+ times in a row`,
          });
        }
        break;
      }
      default:
        break; // command/session events carry context, no metrics yet
    }
  }
  closeTurn();

  const avg =
    durations.length === 0
      ? 0
      : Math.round(durations.reduce((a, b) => a + b, 0) / durations.length);
  return {
    sessionId,
    events: events.length,
    turns: turn,
    erroredTurns,
    turnDurationMs: { avg, max: Math.max(0, ...durations) },
    tools,
    compactions: { count: compactions, tokensReclaimed },
    lints,
  };
}

// ── Rendering ────────────────────────────────────────────────────────────────

export function renderReport(report: SessionReport): string {
  const lines: string[] = [];
  lines.push(
    `session ${report.sessionId} — ${report.turns} turns (${report.erroredTurns} errored), ` +
      `${report.events} events, avg turn ${report.turnDurationMs.avg}ms (max ${report.turnDurationMs.max}ms)`,
  );
  if (report.compactions.count > 0) {
    lines.push(
      `  compactions: ${report.compactions.count} (~${report.compactions.tokensReclaimed.toLocaleString()} tokens reclaimed)`,
    );
  }
  const toolNames = Object.keys(report.tools).sort(
    (a, b) => (report.tools[b]?.calls ?? 0) - (report.tools[a]?.calls ?? 0),
  );
  for (const name of toolNames) {
    const t = report.tools[name];
    if (!t) continue;
    lines.push(`  ${name}: ${t.calls} calls${t.errors ? `, ${t.errors} errors` : ""}`);
  }
  if (report.lints.length === 0) {
    lines.push("  lints: none");
  } else {
    for (const lint of report.lints) {
      lines.push(`  LINT [${lint.rule}] turn ${lint.turn}: ${lint.message}`);
    }
  }
  return lines.join("\n");
}

// ── CLI ──────────────────────────────────────────────────────────────────────

/** Expand path args (files or directories of .jsonl) into trace file paths. */
export function collectTraceFiles(paths: string[]): string[] {
  const files: string[] = [];
  for (const path of paths) {
    if (statSync(path).isDirectory()) {
      for (const f of readdirSync(path)) {
        if (f.endsWith(".jsonl")) files.push(join(path, f));
      }
    } else {
      files.push(path);
    }
  }
  return files.sort();
}

function main(argv: string[]): void {
  const json = argv.includes("--json");
  const paths = argv.filter((a) => !a.startsWith("--"));
  const files = collectTraceFiles(paths.length > 0 ? paths : ["./.session/traces"]);
  const reports = files.map((file) =>
    analyzeSession(basename(file, ".jsonl"), parseTrace(readFileSync(file, "utf8"))),
  );
  if (json) {
    console.log(JSON.stringify(reports, null, 2));
    return;
  }
  if (reports.length === 0) {
    console.log("no trace files found");
    return;
  }
  console.log(reports.map(renderReport).join("\n\n"));
  const lints = reports.reduce((n, r) => n + r.lints.length, 0);
  console.log(`\n${reports.length} session(s), ${lints} lint finding(s).`);
}

if (import.meta.main) main(process.argv.slice(2));
