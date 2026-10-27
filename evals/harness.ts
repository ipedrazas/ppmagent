/**
 * Real-model eval harness (TAV-114, phase 2).
 *
 * The faux-provider integration tests (`tests/integration/agent.integration.test.ts`)
 * prove wiring against scripted model outputs — they never touch a real model, so they
 * cannot tell us whether the configured provider actually follows the operating rules in
 * `SYSTEM_PROMPT` (e.g. CLARIFY: ask ONE question on an under-specified request instead
 * of guessing a task into the backlog). This harness closes that gap: it drives
 * `buildAgent` against the real, configured provider and grades the resulting trace with
 * the same `analyzeSession` linter `src/trace/extract.ts` runs over production traces.
 *
 * Requires a working `ppm` binary on PATH and a real provider API key. Costs real tokens
 * and is non-deterministic — never run as part of `bun test` / CI. Invoke directly:
 *   bun evals/run.ts
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { buildAgent } from "../src/agent.ts";
import { type Config, type Env, loadConfig } from "../src/config.ts";
import { nullLogger } from "../src/logger.ts";
import { PpmClient } from "../src/memory/ppm.ts";
import { analyzeSession, type SessionReport } from "../src/trace/extract.ts";
import type { TraceEvent } from "../src/trace/recorder.ts";

/** One eval case: a prompt plus a judge over the graded trace it produced. */
export interface EvalCase {
  /** Stable id, also used as the trace's sessionId. */
  id: string;
  /** Which operating rule this case exercises — grouped in the report. */
  rule: string;
  description: string;
  prompt: string;
  judge: (report: SessionReport, toolCalls: string[]) => JudgeVerdict;
}

export interface JudgeVerdict {
  pass: boolean;
  reason: string;
}

export interface EvalOutcome {
  id: string;
  rule: string;
  description: string;
  /** The prompt sent to the model — the LLM judge grades against this, not just the description. */
  prompt: string;
  pass: boolean;
  reason: string;
  report: SessionReport;
  toolCalls: string[];
  finalText: string;
}

/**
 * Resolve a real-provider `Config` for eval runs: reuses `loadConfig`'s provider/model/
 * apiKey resolution (so eval provider selection stays in lockstep with production, aliases
 * and all) but points memory at a disposable root and neuters the tracker/ProteOS binaries.
 * Databox and ProteOS need live credentials this harness doesn't have; pointing their `bin`
 * at a binary that always fails still lets an *attempted* call show up in the trace (a
 * `tool_start` + errored `tool_end`) instead of silently doing nothing — good enough to
 * judge "did the model try to act instead of asking", which is what these cases grade.
 */
export function resolveEvalConfig(root: string): Config {
  const env: Env = {
    ...process.env,
    PPMA_TELEGRAM_BOT_TOKEN: process.env.PPMA_TELEGRAM_BOT_TOKEN ?? "eval",
    PPMA_TELEGRAM_ALLOWED_CHAT_ID: process.env.PPMA_TELEGRAM_ALLOWED_CHAT_ID ?? "1",
  };
  const config = loadConfig(env);
  return {
    ...config,
    ppmMemoryRoot: root,
    sessionFile: join(root, "session.json"),
    dbxcliBin: "false",
    proteosBin: "false",
  };
}

/** Missing-prerequisite message, or undefined when the harness can run. */
export function missingRequirements(): string | undefined {
  if (!Bun.which("ppm")) {
    return "ppm binary not found on PATH — install it (see evals/README.md) before running evals.";
  }
  const config = resolveEvalConfig(tmpdir());
  if (!config.apiKey && config.provider !== "ollama") {
    return `no API key configured for provider "${config.provider}" — set its API key env var.`;
  }
  return undefined;
}

/** `provider/model` the harness will run against, for the report header. */
export function describeProvider(): string {
  const config = resolveEvalConfig(tmpdir());
  return `${config.provider}/${config.model}`;
}

/**
 * Run one eval case against the real, configured model and grade its trace.
 *
 * Mirrors what `TurnRunner.run` records in production (`turn_start` → tool events from
 * the runtime's event stream → `turn_end`), then hands the same event shape to `analyzeSession` —
 * an eval failure here is the identical lint a failing production trace would surface.
 */
export async function runEvalCase(
  evalCase: EvalCase,
  project = "eval-fixture",
): Promise<EvalOutcome> {
  const root = mkdtempSync(join(tmpdir(), "ppmagent-eval-"));
  try {
    const config = resolveEvalConfig(root);
    const ppm = new PpmClient({ bin: config.ppmBin, root });
    await ppm.run(["init"]);
    await ppm.projectCreate(project, "Eval fixture project");

    const events: TraceEvent[] = [];
    const toolCalls: string[] = [];
    // In-memory store: an eval case is one disposable conversation.
    const { runtime } = await buildAgent(config, () => project, {
      logger: nullLogger,
      storage: new MemoryStorage(),
    });
    const conversation = await runtime.createConversation();

    const unsubscribe = runtime.subscribe(conversation, (event) => {
      if (event.type === "tool_execution_start") {
        toolCalls.push(event.toolName);
        events.push({ ts: Date.now(), type: "tool_start", tool: event.toolName, args: event.args });
      } else if (event.type === "tool_execution_end") {
        events.push({
          ts: Date.now(),
          type: "tool_end",
          tool: event.toolName,
          isError:
            event.entry === undefined || event.entry.model?.[0]?.role !== "toolResult"
              ? true
              : (event.entry.model[0] as { isError?: boolean }).isError === true,
        });
      }
    });
    await runtime.observing(conversation);

    events.push({ ts: Date.now(), type: "turn_start" });
    const startedAt = performance.now();
    let error: unknown;
    let finalText = "";
    try {
      const outcome = await runtime.runTurn(conversation, evalCase.prompt);
      finalText = outcome.assistantText;
      if (outcome.modelError) error = new Error(outcome.modelError);
    } catch (err) {
      error = err;
    }
    events.push({
      ts: Date.now(),
      type: "turn_end",
      durationMs: Math.round(performance.now() - startedAt),
      ...(error !== undefined ? { error: String(error) } : {}),
    });
    unsubscribe();
    await runtime.close();

    const report = analyzeSession(evalCase.id, events);
    const { pass, reason } = error
      ? { pass: false, reason: `agent turn threw: ${String(error)}` }
      : evalCase.judge(report, toolCalls);

    return {
      id: evalCase.id,
      rule: evalCase.rule,
      description: evalCase.description,
      prompt: evalCase.prompt,
      pass,
      reason,
      report,
      toolCalls,
      finalText,
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
