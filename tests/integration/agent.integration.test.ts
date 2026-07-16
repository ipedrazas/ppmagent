import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { FauxProviderHandle } from "@earendil-works/pi-ai";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import { buildAgent } from "../../src/agent.ts";
import type { Config } from "../../src/config.ts";
import { makeTransformContext } from "../../src/memory/context.ts";
import { PpmClient } from "../../src/memory/ppm.ts";
import { MetricsCollector } from "../../src/metrics/collector.ts";
import { TraceRecorder } from "../../src/trace/recorder.ts";
import { makeTestConfig } from "../support/config.ts";

// Step 2 (agent + ask_user) driven by pi's faux provider — deterministic, no
// API key. Needs the real `ppm` binary for the open-question write, so it skips
// when ppm is absent (CI installs it).
const ppmBin = Bun.which("ppm");
const PROJECT = "onboarding";

function testConfig(root: string): Config {
  return makeTestConfig({
    ppmBin: ppmBin ?? "ppm",
    ppmMemoryRoot: root,
    contextRecent: 3,
    sessionFile: join(root, "session.json"),
  });
}

describe.skipIf(!ppmBin)("agent + ask_user", () => {
  let root: string;
  let ppm: PpmClient;
  let faux: FauxProviderHandle;
  let models: ReturnType<typeof createModels>;
  const fauxStream: StreamFn = (model, context, options) =>
    models.streamSimple(model, context, options);

  beforeEach(async () => {
    root = mkdtempSync(join(import.meta.dir, ".agentroot-"));
    ppm = new PpmClient({ bin: ppmBin ?? "ppm", root });
    await ppm.run(["init"]);
    await ppm.projectCreate(PROJECT, "Onboarding drop-off");
    faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }] });
    models = createModels();
    models.setProvider(faux.provider);
  });

  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  test("a vague prompt yields one clarifying question, records it, and stops", async () => {
    faux.setResponses([
      fauxAssistantMessage([
        fauxToolCall("ask_user", {
          question: "What metric defines onboarding drop-off success?",
          project: PROJECT,
        }),
      ]),
    ]);

    const { agent } = buildAgent(testConfig(root), () => PROJECT, {
      model: faux.getModel(),
      streamFn: fauxStream,
    });
    const toolStarts: string[] = [];
    let ended = false;
    agent.subscribe((e) => {
      if (e.type === "tool_execution_start") toolStarts.push(e.toolName);
      if (e.type === "agent_end") ended = true;
    });

    await agent.prompt("we should do something about onboarding drop-off");

    // One model turn only — terminate stopped the loop before a second call.
    expect(faux.state.callCount).toBe(1);
    expect(toolStarts).toEqual(["ask_user"]);
    expect(ended).toBe(true);

    // The question is recorded as an OPEN question in memory.
    const ctx = await ppm.context(PROJECT, 5);
    const bodies = ctx.data.openQuestions.map((q) => q.body);
    expect(bodies).toContain("What metric defines onboarding drop-off success?");
  });

  test("the recorded open question reappears in the next injected slice", async () => {
    faux.setResponses([
      fauxAssistantMessage([
        fauxToolCall("ask_user", { question: "Who owns the onboarding metric?", project: PROJECT }),
      ]),
    ]);
    const { agent } = buildAgent(testConfig(root), () => PROJECT, {
      model: faux.getModel(),
      streamFn: fauxStream,
    });
    await agent.prompt("improve onboarding");

    const { hook: transform } = makeTransformContext({
      ppm,
      recent: 3,
      getActiveProject: () => PROJECT,
    });
    const injected = await transform([{ role: "user", content: "next message", timestamp: 1 }]);
    const slice = injected.find(
      (m) =>
        "content" in m && typeof m.content === "string" && m.content.includes("memory-context"),
    );
    const text = slice && "content" in slice ? String(slice.content) : "";
    expect(text).toContain("Who owns the onboarding metric?");
  });

  test("the agent loops through a memory_write tool call and finishes", async () => {
    faux.setResponses([
      fauxAssistantMessage([
        fauxToolCall("memory_write", {
          project: PROJECT,
          type: "decision",
          content: "Scope the first task to the email nudge only.",
        }),
      ]),
      fauxAssistantMessage("Recorded the decision."),
    ]);

    const { agent } = buildAgent(testConfig(root), () => PROJECT, {
      model: faux.getModel(),
      streamFn: fauxStream,
    });
    const toolStarts: string[] = [];
    agent.subscribe((e) => {
      if (e.type === "tool_execution_start") toolStarts.push(e.toolName);
    });

    await agent.prompt("scope the onboarding work");

    // Two model turns: the tool call, then the natural-language wrap-up.
    expect(faux.state.callCount).toBe(2);
    expect(toolStarts).toEqual(["memory_write"]);

    const { data } = await ppm.context(PROJECT, 5);
    const decisions = data.recentDecisions.map((d) => d.body);
    expect(decisions.some((b) => b.includes("email nudge only"))).toBe(true);
  });

  test("trace records tool results and assistant text; metrics record provider usage", async () => {
    faux.setResponses([
      fauxAssistantMessage([
        fauxToolCall("memory_write", {
          project: PROJECT,
          type: "decision",
          content: "Scope the first task to the email nudge only.",
        }),
      ]),
      fauxAssistantMessage("Recorded the decision."),
    ]);

    const traceDir = mkdtempSync(join(root, "traces-"));
    const recorder = new TraceRecorder(traceDir);
    recorder.setSession("s-1");
    const metrics = new MetricsCollector();

    const { agent } = buildAgent(testConfig(root), () => PROJECT, {
      model: faux.getModel(),
      streamFn: fauxStream,
      recorder,
      metrics,
    });

    await agent.prompt("scope the onboarding work");

    const events = readFileSync(join(traceDir, "s-1.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as Record<string, unknown>);

    const toolEnd = events.find((e) => e.type === "tool_end") as
      | { result?: { content?: unknown } }
      | undefined;
    expect(toolEnd?.result).toBeDefined();

    const assistantMessages = events.filter((e) => e.type === "assistant_message");
    expect(assistantMessages.length).toBe(2);
    expect(assistantMessages.some((e) => e.text === "Recorded the decision.")).toBe(true);

    // The faux provider estimates real token counts from message content, so
    // provider-reported usage flows through even though the faux cost is 0.
    expect(metrics.snapshot().tokens.total).toBeGreaterThan(0);
  });
});
