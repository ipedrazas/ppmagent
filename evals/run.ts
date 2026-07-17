/**
 * CLI entrypoint for the TAV-114/TAV-115 eval suite: runs every case in `cases.ts`
 * against the real, configured model, reports pass/fail per operating rule, and
 * optionally grades outcome quality with the phase-3 LLM judge.
 *
 * Usage:
 *   bun evals/run.ts             # run every case
 *   bun evals/run.ts --json      # machine-readable output
 *   bun evals/run.ts --judge     # also run the LLM-judge rubric (extra model calls)
 *
 * Never run in CI (real API key + tokens + non-deterministic model output) — see
 * evals/README.md.
 */

import { tmpdir } from "node:os";
import { EVAL_CASES } from "./cases.ts";
import {
  describeProvider,
  type EvalOutcome,
  missingRequirements,
  resolveEvalConfig,
  runEvalCase,
} from "./harness.ts";
import { type JudgeResult, judgeOutcomes, renderJudgeResult } from "./judge.ts";

function renderOutcome(outcome: EvalOutcome): string {
  const icon = outcome.pass ? "PASS" : "FAIL";
  const lines = [
    `[${icon}] ${outcome.id} (${outcome.rule})`,
    `  ${outcome.description}`,
    `  tools called: [${outcome.toolCalls.join(", ") || "none"}]`,
    `  ${outcome.reason}`,
  ];
  if (outcome.report.lints.length > 0) {
    for (const lint of outcome.report.lints) {
      lines.push(`  LINT [${lint.rule}] turn ${lint.turn}: ${lint.message}`);
    }
  }
  return lines.join("\n");
}

async function main(argv: string[]): Promise<void> {
  const json = argv.includes("--json");
  const runJudge = argv.includes("--judge");

  const problem = missingRequirements();
  if (problem) {
    console.error(`cannot run evals: ${problem}`);
    process.exit(1);
  }

  if (!json) {
    const judgeNote = runJudge ? " (+ LLM judge)" : "";
    console.log(
      `running ${EVAL_CASES.length} eval case(s) against ${describeProvider()}${judgeNote}\n`,
    );
  }

  const outcomes: EvalOutcome[] = [];
  for (const evalCase of EVAL_CASES) {
    outcomes.push(await runEvalCase(evalCase));
  }

  let judged: JudgeResult[] = [];
  if (runJudge) {
    judged = await judgeOutcomes(outcomes, resolveEvalConfig(tmpdir()));
  }

  if (json) {
    console.log(JSON.stringify(runJudge ? { outcomes, judge: judged } : outcomes, null, 2));
  } else {
    console.log(outcomes.map(renderOutcome).join("\n\n"));
    if (runJudge) {
      console.log(`\n${judged.map(renderJudgeResult).join("\n")}`);
    }
  }

  const failed = outcomes.filter((o) => !o.pass);
  if (!json) {
    console.log(`\n${outcomes.length} case(s), ${failed.length} failed.`);
  }
  process.exit(failed.length > 0 ? 1 : 0);
}

if (import.meta.main) await main(process.argv.slice(2));
