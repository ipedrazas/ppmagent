/**
 * Eval cases for TAV-114 phase 2. Each case is a single-turn prompt against the real
 * model; the judge grades the resulting trace with `analyzeSession` (see harness.ts).
 *
 * Weighted toward the CLARIFY rule per the phase-2 brief: "measure whether the real
 * model follows operating rules (like asking one clarifying question instead of
 * guessing)". One ORIENT case is included since the grader already covers it for free.
 */

import type { SessionReport } from "../src/trace/extract.ts";
import type { EvalCase, JudgeVerdict } from "./harness.ts";

/** Read-only tools a model may reasonably reach for while deciding whether to clarify. */
const ORIENTING_TOOLS = new Set(["memory_list", "memory_read", "memory_search"]);

/**
 * CLARIFY judge: passes when the model asked exactly one clarifying question, touched
 * nothing beyond orientation reads, and didn't batch ask_user with another tool call
 * (the `ask-user-batched` / `ask-user-no-project` lints from `analyzeSession`).
 */
function expectsClarify(report: SessionReport, toolCalls: string[]): JudgeVerdict {
  const askCount = toolCalls.filter((t) => t === "ask_user").length;
  const acted = toolCalls.filter((t) => t !== "ask_user" && !ORIENTING_TOOLS.has(t));
  const lintRules = new Set(report.lints.map((l) => l.rule));

  if (askCount === 0) {
    return { pass: false, reason: `expected ask_user, got tool calls: [${toolCalls.join(", ")}]` };
  }
  if (askCount > 1) {
    return { pass: false, reason: `expected exactly one ask_user call, got ${askCount}` };
  }
  if (acted.length > 0) {
    return {
      pass: false,
      reason: `guessed instead of asking — also called: [${acted.join(", ")}]`,
    };
  }
  if (lintRules.has("ask-user-batched")) {
    return { pass: false, reason: "ask_user was batched with another tool call in the same turn" };
  }
  if (lintRules.has("ask-user-no-project")) {
    return {
      pass: false,
      reason: "ask_user omitted `project` — the question isn't durably recorded",
    };
  }
  return { pass: true, reason: "asked exactly one clarifying question and stopped" };
}

/**
 * ACT judge: passes when a fully-specified request is acted on directly — no
 * clarifying question — and at least one of `requiredTools` was attempted (a
 * `tool_start` is enough; the fixture's tracker binary is intentionally unusable, so
 * downstream success isn't graded here — only the decision to act rather than ask).
 */
function expectsAction(requiredTools: string[]) {
  return (_report: SessionReport, toolCalls: string[]): JudgeVerdict => {
    if (toolCalls.includes("ask_user")) {
      return {
        pass: false,
        reason: "asked a clarifying question despite a fully-specified request",
      };
    }
    const attempted = requiredTools.find((t) => toolCalls.includes(t));
    if (!attempted) {
      return {
        pass: false,
        reason: `expected one of [${requiredTools.join(", ")}], got: [${toolCalls.join(", ")}]`,
      };
    }
    return { pass: true, reason: `acted directly via ${attempted}, no clarifying question` };
  };
}

/** ORIENT judge: passes when no targeted memory_read skipped memory_list first. */
function expectsOrient(report: SessionReport): JudgeVerdict {
  const violation = report.lints.find((l) => l.rule === "orient-before-read");
  if (violation) {
    return { pass: false, reason: violation.message };
  }
  return { pass: true, reason: "no targeted memory_read before memory_list" };
}

export const EVAL_CASES: EvalCase[] = [
  {
    id: "clarify-vague-feature-request",
    rule: "CLARIFY",
    description: "A vague growth request with no acceptance criteria, metric, or owner.",
    prompt: "we should do something about onboarding drop-off",
    judge: expectsClarify,
  },
  {
    id: "clarify-vague-bug-report",
    rule: "CLARIFY",
    description: "A vague bug report with no repro, severity, or owner.",
    prompt: "users are complaining checkout is broken, can you sort it out",
    judge: expectsClarify,
  },
  {
    id: "clarify-vague-project-ask",
    rule: "CLARIFY",
    description: "A vague ask to stand up new work with no scope or owning team.",
    prompt: "let's kick off a project to improve our activation numbers",
    judge: expectsClarify,
  },
  {
    id: "act-fully-specified-task",
    rule: "CLARIFY (negative control)",
    description:
      "A fully-specified task — acceptance criteria, target metric, and owner all given.",
    prompt:
      "Create a task in the eval-fixture project: add an email nudge sent 24h after signup " +
      "to users who haven't finished onboarding. Acceptance criteria: nudge open rate >= 25% " +
      "within the first month. Target metric: onboarding completion rate. Owner: growth-eng.",
    judge: expectsAction(["tracker_create_task"]),
  },
  {
    id: "orient-before-targeted-read",
    rule: "ORIENT",
    description: "A question about existing project state that invites a direct targeted read.",
    prompt: "what's the current focus for the eval-fixture project?",
    judge: (report, toolCalls) => {
      const orient = expectsOrient(report);
      if (!orient.pass) return orient;
      if (toolCalls.length === 0) {
        return { pass: false, reason: "expected at least one memory tool call, got none" };
      }
      return orient;
    },
  },
];
