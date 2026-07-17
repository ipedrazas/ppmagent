/**
 * LLM-judge tier (TAV-115, phase 3).
 *
 * Phase 2's `analyzeSession` lints are deterministic — they catch shape violations
 * (batched ask_user, a create with no rationale) but can't tell whether the clarifying
 * question was the *right* question, or whether a created task is well-scoped. This
 * module grades an {@link EvalOutcome} against a small rubric using the same real,
 * configured provider the harness drives — a second model call, not a heuristic.
 *
 * Costs tokens and is non-deterministic, same caveats as the harness itself (see
 * evals/README.md). Opt in via `bun evals/run.ts --judge`.
 */

import { Agent, type StreamFn } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import { resolveModel } from "../src/agent.ts";
import type { Config } from "../src/config.ts";
import { defineTool, toolResult } from "../src/tool-helpers.ts";
import type { EvalOutcome } from "./harness.ts";

/** One rubric question, scoped to the eval outcomes it makes sense to ask about. */
export interface JudgeCriterion {
  /** Stable id, reported alongside the score. */
  id: string;
  /** The rubric question put to the judge model. */
  question: string;
  /** Whether this criterion applies to a given outcome (e.g. only cases that asked a question). */
  appliesTo: (outcome: EvalOutcome) => boolean;
}

export interface CriterionScore {
  criterionId: string;
  /** 1 (poor) – 5 (excellent). */
  score: number;
  rationale: string;
}

export interface JudgeResult {
  outcomeId: string;
  scores: CriterionScore[];
}

export const JUDGE_CRITERIA: JudgeCriterion[] = [
  {
    id: "clarify-question-quality",
    question:
      "The agent asked a clarifying question instead of acting on the request directly. Was the " +
      "question well-targeted — does it ask for the SPECIFIC missing information (acceptance " +
      "criteria, target metric, or owner) needed to scope the request, rather than a generic or " +
      "overly broad question a product owner wouldn't actually ask?",
    appliesTo: (outcome) => outcome.toolCalls.includes("ask_user"),
  },
  {
    id: "task-scoping-quality",
    question:
      "The agent created a tracker task for the request. Is the task well-scoped — does its " +
      "description capture clear acceptance criteria, a target metric, and an owner, in enough " +
      "detail that a contributor could pick it up without asking a follow-up question?",
    appliesTo: (outcome) => outcome.toolCalls.includes("tracker_create_task"),
  },
];

const JUDGE_SYSTEM_PROMPT = `You are grading a single response from an AI Project/Product-Owner agent against ONE rubric criterion. Score strictly and consistently:
1 = fails the criterion outright
2 = mostly fails, minor redeeming quality
3 = partially meets the criterion
4 = meets the criterion with a minor gap
5 = fully meets the criterion

Base your score ONLY on the given criterion and the evidence provided — do not grade unrelated aspects of the response. Call submit_score exactly once with your score and a one-sentence rationale. Do not call any other tool.`;

const SCORE_SCHEMA = Type.Object({
  score: Type.Integer({ minimum: 1, maximum: 5 }),
  rationale: Type.String({ description: "One sentence justifying the score." }),
});

function buildSubmitScoreTool(onSubmit: (score: number, rationale: string) => void) {
  return defineTool({
    name: "submit_score",
    description: "Submit your rubric score (1-5) and a one-sentence rationale.",
    label: "Submit score",
    parameters: SCORE_SCHEMA,
    execute: async (_id, params) => {
      onSubmit(params.score, params.rationale);
      return toolResult(`score ${params.score}: ${params.rationale}`, params, {
        terminate: true,
      });
    },
  });
}

function judgePrompt(outcome: EvalOutcome, criterion: JudgeCriterion): string {
  return [
    `Criterion: ${criterion.question}`,
    "",
    `Original request sent to the agent: "${outcome.prompt}"`,
    `Tools called, in order: [${outcome.toolCalls.join(", ") || "none"}]`,
    `Agent's final reply to the user: ${outcome.finalText || "(no text reply)"}`,
  ].join("\n");
}

export interface JudgeOverrides {
  /** Inject a model (e.g. a faux provider in tests) instead of resolving from config. */
  model?: ReturnType<typeof resolveModel>;
  /** Inject the stream function (e.g. a faux provider) instead of the real provider. */
  streamFn?: StreamFn;
}

/** Run one criterion's judge call over one outcome and parse its verdict. */
export async function judgeCriterion(
  outcome: EvalOutcome,
  criterion: JudgeCriterion,
  config: Config,
  overrides: JudgeOverrides = {},
): Promise<CriterionScore> {
  let verdict: { score: number; rationale: string } | undefined;
  const tool = buildSubmitScoreTool((score, rationale) => {
    verdict = { score, rationale };
  });

  const agent = new Agent({
    initialState: {
      systemPrompt: JUDGE_SYSTEM_PROMPT,
      model: overrides.model ?? resolveModel(config),
      tools: [tool],
    },
    streamFn: overrides.streamFn,
    getApiKey: () => config.apiKey,
  });

  await agent.prompt(judgePrompt(outcome, criterion));

  if (!verdict) {
    return {
      criterionId: criterion.id,
      score: 1,
      rationale: "judge model did not call submit_score",
    };
  }
  return { criterionId: criterion.id, score: verdict.score, rationale: verdict.rationale };
}

/** Grade one outcome against every criterion that applies to it. */
export async function judgeOutcome(
  outcome: EvalOutcome,
  config: Config,
  overrides: JudgeOverrides = {},
): Promise<JudgeResult> {
  const applicable = JUDGE_CRITERIA.filter((c) => c.appliesTo(outcome));
  const scores: CriterionScore[] = [];
  for (const criterion of applicable) {
    scores.push(await judgeCriterion(outcome, criterion, config, overrides));
  }
  return { outcomeId: outcome.id, scores };
}

/**
 * Grade every outcome that has at least one applicable criterion. Outcomes with none
 * (e.g. ORIENT cases, which neither ask nor create) are skipped rather than scored — an
 * empty `scores` array would be indistinguishable from "graded, judge saw nothing wrong".
 */
export async function judgeOutcomes(
  outcomes: EvalOutcome[],
  config: Config,
  overrides: JudgeOverrides = {},
): Promise<JudgeResult[]> {
  const results: JudgeResult[] = [];
  for (const outcome of outcomes) {
    if (!JUDGE_CRITERIA.some((c) => c.appliesTo(outcome))) continue;
    results.push(await judgeOutcome(outcome, config, overrides));
  }
  return results;
}

export function renderJudgeResult(result: JudgeResult): string {
  if (result.scores.length === 0) return `  judge: ${result.outcomeId} — no applicable criteria`;
  return result.scores
    .map((s) => `  JUDGE [${s.criterionId}] ${result.outcomeId}: ${s.score}/5 — ${s.rationale}`)
    .join("\n");
}
