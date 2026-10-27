import { afterEach, describe, expect, test } from "bun:test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { makeTestConfig } from "./support/config.ts";
import { type FauxAgent, makeFauxAgent } from "./support/faux-agent.ts";

const DECISION = "Ship the email nudge only; defer the dashboard redesign.";

let agent: FauxAgent | undefined;
afterEach(async () => {
  await agent?.close();
  agent = undefined;
});

/** Poll until `check` holds — flush to memory happens off the event stream, just after the summary lands. */
async function eventually(check: () => boolean, ms = 2_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("durable compaction", () => {
  test("a manual compaction replaces old context with a summary and checkpoints it to memory", async () => {
    agent = await makeFauxAgent(makeTestConfig(), {
      project: () => "onboarding",
      keepRecentTokens: 1,
    });
    const writes: string[][] = [];
    agent.built.ppm.write = (async (args: string[]) => {
      writes.push(args);
      return {};
    }) as never;
    const { runtime } = agent.built;
    const conversation = await runtime.createConversation();
    agent.built.observe(conversation);
    await runtime.observing(conversation);

    for (let i = 0; i < 4; i++) {
      agent.faux.setResponses([fauxAssistantMessage(i === 0 ? DECISION : `answer ${i}`)]);
      await runtime.runTurn(conversation, `message ${i}`);
    }
    const before = await runtime.messages(conversation);
    expect(JSON.stringify(before)).toContain(DECISION);

    agent.faux.setResponses([
      fauxAssistantMessage("SUMMARY: scoped onboarding to the email nudge."),
    ]);
    const { compacted } = await runtime.compact(conversation);

    expect(compacted).toBe(true);
    const after = await runtime.messages(conversation);
    expect(after.length).toBeLessThan(before.length);
    expect(JSON.stringify(after)).toContain("SUMMARY: scoped onboarding");
    // The summary was flushed to the active project's memory as a checkpoint.
    await eventually(() => writes.length > 0);
    expect(writes[0]).toEqual([
      "conversation",
      "add",
      "onboarding",
      "--content",
      expect.stringContaining("SUMMARY: scoped onboarding"),
    ]);
  });

  test("compaction with nothing to summarize is a no-op", async () => {
    agent = await makeFauxAgent(makeTestConfig());
    const conversation = await agent.built.runtime.createConversation();
    agent.faux.setResponses([fauxAssistantMessage("hi")]);
    await agent.built.runtime.runTurn(conversation, "hello");
    const { compacted } = await agent.built.runtime.compact(conversation);
    expect(compacted).toBe(false);
  });
});
