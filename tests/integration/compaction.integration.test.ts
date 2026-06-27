import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { FauxProviderRegistration } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { buildAgent } from "../../src/agent.ts";
import { maybeCompact, placeholderSummarizer } from "../../src/compaction.ts";
import type { Config } from "../../src/config.ts";
import { makeTransformContext } from "../../src/memory/context.ts";
import { PpmClient } from "../../src/memory/ppm.ts";

// Step 4: spike claim 4 — after the transcript is compacted, a fact established
// BEFORE compaction is still recalled, because durable facts live in `ppm` and
// are re-injected by `transformContext`. Deterministic (faux model + ppm).
const ppmBin = Bun.which("ppm");
const PROJECT = "onboarding";
const DECISION = "Ship the email nudge only; defer the dashboard redesign.";

function testConfig(root: string): Config {
  return {
    anthropicApiKey: "test-key",
    model: "faux-1",
    ppmBin: ppmBin ?? "ppm",
    ppmMemoryRoot: root,
    contextRecent: 5,
    dbxcliBin: "dbxcli",
    dbxcliConfig: "",
    dbxcliDataset: "issues",
    dbxcliCreateAction: "create_issue_linear",
    telegramBotToken: "test",
    telegramAllowedChatId: undefined,
    sessionFile: join(root, "session.json"),
    compactionTokenThreshold: 0,
    logLevel: "info",
    logFormat: "json",
  };
}

describe.skipIf(!ppmBin)("compaction preserves memory (claim 4)", () => {
  let root: string;
  let ppm: PpmClient;
  let faux: FauxProviderRegistration;

  beforeEach(async () => {
    root = mkdtempSync(join(import.meta.dir, ".compactroot-"));
    ppm = new PpmClient({ bin: ppmBin ?? "ppm", root });
    await ppm.run(["init"]);
    await ppm.projectCreate(PROJECT, "Onboarding drop-off");
    faux = registerFauxProvider({ provider: "faux", models: [{ id: "faux-1" }] });
  });

  afterEach(() => {
    faux.unregister();
    if (root) rmSync(root, { recursive: true, force: true });
  });

  test("a pre-compaction decision is gone from the transcript but recalled from memory", async () => {
    // Turn 1: the agent records a decision in memory.
    faux.setResponses([
      fauxAssistantMessage([
        fauxToolCall("memory_write", { project: PROJECT, type: "decision", content: DECISION }),
      ]),
    ]);
    const { agent } = buildAgent(testConfig(root), () => PROJECT, { model: faux.getModel() });
    await agent.prompt("scope the onboarding work");

    // Bloat the transcript so the decision lands in the summarized-away region.
    const filler: AgentMessage[] = Array.from({ length: 6 }, (_, i) => ({
      role: "user",
      content: `later unrelated message ${i}`,
      timestamp: 100 + i,
    }));
    const before = [...agent.state.messages, ...filler];
    expect(JSON.stringify(before)).toContain(DECISION); // sanity: it's in the transcript now

    // A flush that persists a durable checkpoint before the summary.
    const outcome = await maybeCompact({
      messages: before,
      policy: { threshold: 1, keepRecent: 2 },
      summarize: placeholderSummarizer,
      flush: async () => {
        await ppm.write([
          "conversation",
          "add",
          PROJECT,
          "--content",
          "Compaction checkpoint: scoped onboarding to the email nudge.",
        ]);
      },
    });
    agent.state.messages = outcome.messages;

    // The transcript shrank and no longer carries the decision text.
    expect(outcome.compacted).toBe(true);
    expect(outcome.messages.length).toBeLessThan(before.length);
    expect(JSON.stringify(outcome.messages)).not.toContain(DECISION);

    // But the decision is recalled — re-injected from memory by transformContext.
    const transform = makeTransformContext({ ppm, recent: 5, getActiveProject: () => PROJECT });
    const injected = await transform(outcome.messages);
    const slice = injected.find(
      (m) =>
        "content" in m && typeof m.content === "string" && m.content.includes("memory-context"),
    );
    expect(slice && "content" in slice ? String(slice.content) : "").toContain(DECISION);

    // And the flush wrote a durable conversation checkpoint.
    const shape = await ppm.projectShow(PROJECT);
    expect(shape.data.counts.conversation).toBeGreaterThanOrEqual(1);
  });

  test("below threshold the transcript is left untouched", async () => {
    faux.setResponses([fauxAssistantMessage("ok")]);
    const { agent } = buildAgent(testConfig(root), () => PROJECT, { model: faux.getModel() });
    await agent.prompt("hello");
    const snapshot = [...agent.state.messages];

    const outcome = await maybeCompact({
      messages: agent.state.messages,
      policy: { threshold: 1_000_000_000, keepRecent: 2 },
      summarize: placeholderSummarizer,
    });
    expect(outcome.compacted).toBe(false);
    expect(outcome.messages).toEqual(snapshot);
  });
});
