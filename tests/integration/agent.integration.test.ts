import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, type Message } from "@earendil-works/pi-ai";
import type { Config } from "../../src/config.ts";
import { makeTransformContext } from "../../src/memory/context.ts";
import { PpmClient } from "../../src/memory/ppm.ts";
import { MetricsCollector } from "../../src/metrics/collector.ts";
import { TraceRecorder } from "../../src/trace/recorder.ts";
import { makeTestConfig } from "../support/config.ts";
import { type FauxAgent, fauxToolTurn, makeFauxAgent } from "../support/faux-agent.ts";

// Step 2 (agent + ask_user) driven by pi's faux provider on a real pi-durable
// runtime — deterministic, no API key. Needs the real `ppm` binary for the
// open-question write, so it skips when ppm is absent (CI installs it).
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

/** Names of the tools the model called, in order. */
function toolNames(messages: Message[]): string[] {
  return messages.flatMap((m) =>
    m.role === "assistant" ? m.content.filter((c) => c.type === "toolCall").map((c) => c.name) : [],
  );
}

describe.skipIf(!ppmBin)("agent + ask_user", () => {
  let root: string;
  let ppm: PpmClient;
  let agent: FauxAgent;

  beforeEach(async () => {
    root = mkdtempSync(join(import.meta.dir, ".agentroot-"));
    ppm = new PpmClient({ bin: ppmBin ?? "ppm", root });
    await ppm.run(["init"]);
    await ppm.projectCreate(PROJECT, "Onboarding drop-off");
    agent = await makeFauxAgent(testConfig(root), { project: () => PROJECT });
  });

  afterEach(async () => {
    await agent.close();
    if (root) rmSync(root, { recursive: true, force: true });
  });

  /** Run one turn on a fresh conversation of the agent under test. */
  async function runTurn(text: string, built = agent.built) {
    const conversation = await built.runtime.createConversation();
    return { conversation, outcome: await built.runtime.runTurn(conversation, text) };
  }

  test("a vague prompt yields one clarifying question, records it, and stops", async () => {
    agent.faux.setResponses([
      fauxToolTurn(
        fauxToolCall("ask_user", {
          question: "What metric defines onboarding drop-off success?",
          project: PROJECT,
        }),
      ),
    ]);

    const { outcome } = await runTurn("we should do something about onboarding drop-off");

    // One model turn only — terminate stopped the loop before a second call.
    expect(agent.faux.state.callCount).toBe(1);
    expect(toolNames(outcome.messages)).toEqual(["ask_user"]);
    expect(outcome.status).toBe("done");
    expect(outcome.terminatingReplies.join(" ")).toContain("What metric defines");

    // The question is recorded as an OPEN question in memory.
    const ctx = await ppm.context(PROJECT, 5);
    const bodies = ctx.data.openQuestions.map((q) => q.body);
    expect(bodies).toContain("What metric defines onboarding drop-off success?");
  });

  test("the recorded open question reappears in the next injected slice", async () => {
    agent.faux.setResponses([
      fauxToolTurn(
        fauxToolCall("ask_user", { question: "Who owns the onboarding metric?", project: PROJECT }),
      ),
    ]);
    await runTurn("improve onboarding");

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

  test("the model sees the injected memory slice on every request, and it is never stored", async () => {
    const seen: string[] = [];
    agent.faux.setResponses([
      (context) => {
        seen.push(JSON.stringify(context.messages));
        return fauxAssistantMessage("ok");
      },
    ]);
    const { conversation } = await runTurn("hello");

    expect(seen[0]).toContain("memory-context");
    const stored = await agent.built.runtime.messages(conversation);
    expect(JSON.stringify(stored)).not.toContain("memory-context");
  });

  test("the agent loops through a memory_write tool call and finishes", async () => {
    agent.faux.setResponses([
      fauxToolTurn(
        fauxToolCall("memory_write", {
          project: PROJECT,
          type: "decision",
          content: "Scope the first task to the email nudge only.",
        }),
      ),
      fauxAssistantMessage("Recorded the decision."),
    ]);

    const { outcome } = await runTurn("scope the onboarding work");

    // Two model turns: the tool call, then the natural-language wrap-up.
    expect(agent.faux.state.callCount).toBe(2);
    expect(toolNames(outcome.messages)).toEqual(["memory_write"]);
    expect(outcome.assistantText).toBe("Recorded the decision.");

    const { data } = await ppm.context(PROJECT, 5);
    const decisions = data.recentDecisions.map((d) => d.body);
    expect(decisions.some((b) => b.includes("email nudge only"))).toBe(true);
  });

  test("trace records tool results and assistant text; metrics record provider usage", async () => {
    const traceDir = mkdtempSync(join(root, "traces-"));
    const recorder = new TraceRecorder(traceDir);
    recorder.setSession("s-1");
    const metrics = new MetricsCollector();

    const traced = await makeFauxAgent(testConfig(root), {
      project: () => PROJECT,
      recorder,
      metrics,
    });
    traced.faux.setResponses([
      fauxToolTurn(
        fauxToolCall("memory_write", {
          project: PROJECT,
          type: "decision",
          content: "Scope the first task to the email nudge only.",
        }),
      ),
      fauxAssistantMessage("Recorded the decision."),
    ]);
    try {
      const conversation = await traced.built.runtime.createConversation();
      traced.built.observe(conversation);
      await traced.built.runtime.observing(conversation);
      await traced.built.runtime.runTurn(conversation, "scope the onboarding work");
    } finally {
      await traced.close();
    }

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
