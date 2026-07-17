import { describe, expect, test } from "bun:test";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { FauxProviderHandle } from "@earendil-works/pi-ai";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import type { EvalOutcome } from "../evals/harness.ts";
import { JUDGE_CRITERIA, judgeCriterion, judgeOutcome, judgeOutcomes } from "../evals/judge.ts";
import { makeTestConfig } from "./support/config.ts";

function makeOutcome(overrides: Partial<EvalOutcome> = {}): EvalOutcome {
  return {
    id: "case-1",
    rule: "CLARIFY",
    description: "A vague request",
    prompt: "we should do something about onboarding drop-off",
    pass: true,
    reason: "asked exactly one clarifying question and stopped",
    report: {
      sessionId: "case-1",
      events: 0,
      turns: 1,
      erroredTurns: 0,
      turnDurationMs: { avg: 0, max: 0 },
      tools: {},
      compactions: { count: 0, tokensReclaimed: 0 },
      lints: [],
    },
    toolCalls: ["ask_user"],
    finalText: "What metric defines success for this onboarding change?",
    ...overrides,
  };
}

function fauxSetup() {
  const faux: FauxProviderHandle = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }] });
  const models = createModels();
  models.setProvider(faux.provider);
  const streamFn: StreamFn = (model, context, options) =>
    models.streamSimple(model, context, options);
  return { faux, streamFn };
}

describe("JUDGE_CRITERIA.appliesTo", () => {
  test("clarify-question-quality applies only when ask_user was called", () => {
    const criterion = JUDGE_CRITERIA.find((c) => c.id === "clarify-question-quality");
    expect(criterion?.appliesTo(makeOutcome({ toolCalls: ["ask_user"] }))).toBe(true);
    expect(criterion?.appliesTo(makeOutcome({ toolCalls: ["memory_list"] }))).toBe(false);
  });

  test("task-scoping-quality applies only when tracker_create_task was called", () => {
    const criterion = JUDGE_CRITERIA.find((c) => c.id === "task-scoping-quality");
    expect(criterion?.appliesTo(makeOutcome({ toolCalls: ["tracker_create_task"] }))).toBe(true);
    expect(criterion?.appliesTo(makeOutcome({ toolCalls: ["ask_user"] }))).toBe(false);
  });
});

describe("judgeCriterion", () => {
  test("parses the submit_score tool call into a CriterionScore", async () => {
    const { faux, streamFn } = fauxSetup();
    faux.setResponses([
      fauxAssistantMessage([
        fauxToolCall("submit_score", {
          score: 4,
          rationale: "Targets the missing metric directly.",
        }),
      ]),
    ]);
    const criterion = JUDGE_CRITERIA[0];
    if (!criterion) throw new Error("expected at least one judge criterion");

    const score = await judgeCriterion(makeOutcome(), criterion, makeTestConfig(), {
      model: faux.getModel(),
      streamFn,
    });

    expect(score.criterionId).toBe(criterion.id);
    expect(score.score).toBe(4);
    expect(score.rationale).toBe("Targets the missing metric directly.");
  });

  test("falls back to a low score when the judge model never calls submit_score", async () => {
    const { faux, streamFn } = fauxSetup();
    faux.setResponses([fauxAssistantMessage("this looks fine to me")]);
    const criterion = JUDGE_CRITERIA[0];
    if (!criterion) throw new Error("expected at least one judge criterion");

    const score = await judgeCriterion(makeOutcome(), criterion, makeTestConfig(), {
      model: faux.getModel(),
      streamFn,
    });

    expect(score.score).toBe(1);
    expect(score.rationale).toContain("did not call submit_score");
  });
});

describe("judgeOutcome", () => {
  test("grades every applicable criterion and skips the rest", async () => {
    const { faux, streamFn } = fauxSetup();
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("submit_score", { score: 5, rationale: "Great." })]),
    ]);

    const result = await judgeOutcome(makeOutcome({ toolCalls: ["ask_user"] }), makeTestConfig(), {
      model: faux.getModel(),
      streamFn,
    });

    expect(result.outcomeId).toBe("case-1");
    expect(result.scores.length).toBe(1);
    expect(result.scores[0]?.criterionId).toBe("clarify-question-quality");
  });
});

describe("judgeOutcomes", () => {
  test("skips outcomes with no applicable criteria (e.g. ORIENT cases)", async () => {
    const { faux, streamFn } = fauxSetup();
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("submit_score", { score: 3, rationale: "OK." })]),
    ]);

    const outcomes = [
      makeOutcome({ id: "clarify-case", toolCalls: ["ask_user"] }),
      makeOutcome({ id: "orient-case", rule: "ORIENT", toolCalls: ["memory_list"] }),
    ];

    const results = await judgeOutcomes(outcomes, makeTestConfig(), {
      model: faux.getModel(),
      streamFn,
    });

    expect(results.length).toBe(1);
    expect(results[0]?.outcomeId).toBe("clarify-case");
  });
});
