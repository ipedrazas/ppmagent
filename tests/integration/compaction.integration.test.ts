import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { Config } from "../../src/config.ts";
import { makeTransformContext } from "../../src/memory/context.ts";
import { PpmClient } from "../../src/memory/ppm.ts";
import { makeTestConfig } from "../support/config.ts";
import { type FauxAgent, fauxToolTurn, makeFauxAgent } from "../support/faux-agent.ts";

// Step 4: spike claim 4 — after the transcript is compacted, a fact established
// BEFORE compaction is still recalled, because durable facts live in `ppm` and
// are re-injected before every request. Deterministic (faux model + real ppm).
const ppmBin = Bun.which("ppm");
const PROJECT = "onboarding";
const DECISION = "Ship the email nudge only; defer the dashboard redesign.";

function testConfig(root: string): Config {
  return makeTestConfig({
    ppmBin: ppmBin ?? "ppm",
    ppmMemoryRoot: root,
    sessionFile: join(root, "session.json"),
  });
}

describe.skipIf(!ppmBin)("compaction preserves memory (claim 4)", () => {
  let root: string;
  let ppm: PpmClient;
  let agent: FauxAgent;

  beforeEach(async () => {
    root = mkdtempSync(join(import.meta.dir, ".compactroot-"));
    ppm = new PpmClient({ bin: ppmBin ?? "ppm", root });
    await ppm.run(["init"]);
    await ppm.projectCreate(PROJECT, "Onboarding drop-off");
    agent = await makeFauxAgent(testConfig(root), {
      project: () => PROJECT,
      keepRecentTokens: 1,
    });
  });

  afterEach(async () => {
    await agent.close();
    if (root) rmSync(root, { recursive: true, force: true });
  });

  test("a pre-compaction decision is gone from the transcript but recalled from memory", async () => {
    const { runtime } = agent.built;
    const conversation = await runtime.createConversation();
    agent.built.observe(conversation);
    await runtime.observing(conversation);

    // Turn 1: the agent records a decision in memory.
    agent.faux.setResponses([
      fauxToolTurn(
        fauxToolCall("memory_write", { project: PROJECT, type: "decision", content: DECISION }),
      ),
      fauxAssistantMessage("Recorded."),
    ]);
    await runtime.runTurn(conversation, "scope the onboarding work");
    // Bloat the transcript so the decision lands in the summarized-away region.
    for (let i = 0; i < 3; i++) {
      agent.faux.setResponses([fauxAssistantMessage(`later unrelated answer ${i}`)]);
      await runtime.runTurn(conversation, `later unrelated message ${i}`);
    }
    const before = await runtime.messages(conversation);
    expect(JSON.stringify(before)).toContain(DECISION); // sanity: it's in the transcript now

    agent.faux.setResponses([
      fauxAssistantMessage("SUMMARY: scoped onboarding to the email nudge."),
    ]);
    const { compacted } = await runtime.compact(conversation);

    // The transcript shrank and no longer carries the decision text.
    expect(compacted).toBe(true);
    const after = await runtime.messages(conversation);
    expect(after.length).toBeLessThan(before.length);
    expect(JSON.stringify(after)).not.toContain(DECISION);

    // But the decision is recalled — re-injected from memory before the next request.
    const { hook: transform } = makeTransformContext({
      ppm,
      recent: 5,
      getActiveProject: () => PROJECT,
    });
    const injected = await transform(after);
    const slice = injected.find(
      (m) =>
        "content" in m && typeof m.content === "string" && m.content.includes("memory-context"),
    );
    expect(slice && "content" in slice ? String(slice.content) : "").toContain(DECISION);

    // And the summary was flushed as a durable conversation checkpoint.
    const deadline = Date.now() + 3_000;
    let checkpoints = 0;
    while (Date.now() < deadline && checkpoints < 1) {
      checkpoints = (await ppm.projectShow(PROJECT)).data.counts.conversation ?? 0;
      if (checkpoints < 1) await new Promise((r) => setTimeout(r, 50));
    }
    expect(checkpoints).toBeGreaterThanOrEqual(1);
  });

  test("with nothing old enough to summarize the transcript is left untouched", async () => {
    const { runtime } = agent.built;
    const conversation = await runtime.createConversation();
    agent.faux.setResponses([fauxAssistantMessage("ok")]);
    await runtime.runTurn(conversation, "hello");
    const snapshot = await runtime.messages(conversation);

    const { compacted } = await runtime.compact(conversation);
    expect(compacted).toBe(false);
    expect(await runtime.messages(conversation)).toEqual(snapshot);
  });
});
