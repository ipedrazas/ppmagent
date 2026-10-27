/**
 * Tests for the three resource limit features in TurnRunner:
 *   1. Session cost limit — refuse a turn when accumulated cost exceeds the cap
 *   2. Per-turn tool budget — block the call and abort when the count exceeds the cap
 *   3. Per-turn cost limit — abort mid-turn when provider-reported cost exceeds the cap
 *
 * Each runs a real TurnRunner over a real durable runtime with a scripted
 * (faux) model, so "the turn was refused / aborted" is observed as what the
 * model and tools actually did, not as a mock being called.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { fauxAssistantMessage, fauxToolCall, type Usage } from "@earendil-works/pi-ai";
import { MetricsCollector } from "../src/metrics/collector.ts";
import type { SessionStore } from "../src/session/store.ts";
import { ChatSession } from "../src/telegram/chat-session.ts";
import type { TelegramClient } from "../src/telegram/client.ts";
import { TurnRunner } from "../src/telegram/turn-runner.ts";
import { makeTestConfig } from "./support/config.ts";
import { type FauxAgent, fauxToolTurn, makeFauxAgent, scriptedTool } from "./support/faux-agent.ts";

/** Synthetic provider-reported usage carrying a given total cost, for tests. */
function usageWithCost(totalCostUsd: number, totalTokens = 0): Usage {
  return {
    input: totalTokens,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens,
    cost: { input: totalCostUsd, output: 0, cacheRead: 0, cacheWrite: 0, total: totalCostUsd },
  };
}

// ── helpers ──────────────────────────────────────────────────────────────────

function mockStore(): SessionStore {
  return {
    load: () => null,
    save: () => {},
    list: () => [],
    find: () => undefined,
    loadOffset: () => 0,
    saveOffset: () => {},
  } as unknown as SessionStore;
}

const agents: FauxAgent[] = [];
afterEach(async () => {
  await Promise.all(agents.splice(0).map((a) => a.close()));
});

/** A TurnRunner over a faux-model durable runtime whose only tool is a counting `probe`. */
async function makeTurnRunner(
  overrides: {
    metrics?: MetricsCollector;
    configOverrides?: Parameters<typeof makeTestConfig>[0];
    /** Price the faux model so turns carry real, derived cost. */
    cost?: { input: number; output: number };
  } = {},
): Promise<{
  runner: TurnRunner;
  agent: FauxAgent;
  sent: { chatId: number; text: string }[];
  probeCalls: () => number;
}> {
  const config = makeTestConfig(overrides.configOverrides);
  let probes = 0;
  const agent = await makeFauxAgent(config, {
    cost: overrides.cost,
    tools: [
      scriptedTool("probe", () => {
        probes++;
        return { text: `probe #${probes}` };
      }),
    ],
  });
  agents.push(agent);
  const session = new ChatSession(config, { store: mockStore() });
  session.attach(agent.built);
  const sent: { chatId: number; text: string }[] = [];
  const client = {
    sendMessage: async (chatId: number, text: string) => sent.push({ chatId, text }),
    sendChatAction: async () => {},
  } as unknown as TelegramClient;

  const runner = new TurnRunner({
    session,
    built: agent.built,
    config,
    client,
    send: async (chatId, msgs) => {
      for (const m of msgs) sent.push({ chatId, text: m });
    },
    abortSignal: new AbortController().signal,
    metrics: overrides.metrics,
  });

  return { runner, agent, sent, probeCalls: () => probes };
}

const probeTurn = () => fauxToolTurn(fauxToolCall("probe", {}));

// ── 1. Session cost limit ─────────────────────────────────────────────────────

describe("TurnRunner — session cost limit", () => {
  test("refuses the turn when session cost has reached the cap", async () => {
    // Provider-reported usage accumulating to $6 total.
    const metrics = new MetricsCollector();
    metrics.recordUsage(usageWithCost(6, 1_000_000));

    const { runner, agent, sent } = await makeTurnRunner({
      metrics,
      configOverrides: { sessionMaxCostUsd: 5 }, // limit is $5, spent is $6
    });
    agent.faux.setResponses([fauxAssistantMessage("should not be called")]);

    const replies = await runner.run(1, "hello");
    expect(agent.faux.state.callCount).toBe(0);
    expect(replies.join(" ")).toMatch(/cost limit/i);
    expect(sent.some((m) => m.text.match(/cost limit/i))).toBe(true);
  });

  test("allows the turn when session cost is below the cap", async () => {
    const metrics = new MetricsCollector();
    metrics.recordUsage(usageWithCost(0.6, 100_000));

    const { runner, agent } = await makeTurnRunner({
      metrics,
      configOverrides: { sessionMaxCostUsd: 5 }, // limit $5, spent $0.60
    });
    agent.faux.setResponses([fauxAssistantMessage("fine")]);

    expect(await runner.run(1, "hello")).toEqual(["fine"]);
    expect(agent.faux.state.callCount).toBe(1);
  });

  test("does not check limit when sessionMaxCostUsd is 0 (unlimited)", async () => {
    const metrics = new MetricsCollector();
    metrics.recordUsage(usageWithCost(60, 10_000_000));

    const { runner, agent } = await makeTurnRunner({
      metrics,
      configOverrides: { sessionMaxCostUsd: 0 },
    });
    agent.faux.setResponses([fauxAssistantMessage("fine")]);

    await runner.run(1, "hello");
    expect(agent.faux.state.callCount).toBe(1);
  });
});

// ── 2. Per-turn tool budget ───────────────────────────────────────────────────

describe("TurnRunner — per-turn tool budget", () => {
  test("calls within the budget run; the (budget+1)-th is blocked and ends the turn", async () => {
    const { runner, agent, probeCalls } = await makeTurnRunner({
      configOverrides: { turnMaxTools: 2 },
    });
    // The model would happily keep calling tools forever.
    agent.faux.setResponses([
      probeTurn(),
      probeTurn(),
      probeTurn(),
      probeTurn(),
      fauxAssistantMessage("never reached"),
    ]);

    const replies = await runner.run(1, "hello");

    expect(probeCalls()).toBe(2); // the 3rd was blocked, the turn aborted
    expect(replies.join(" ")).not.toContain("never reached");
    expect(agent.faux.state.callCount).toBeLessThan(5);
  });

  test("the budget is per turn: the next turn starts from zero", async () => {
    const { runner, agent, probeCalls } = await makeTurnRunner({
      configOverrides: { turnMaxTools: 2 },
    });
    agent.faux.setResponses([probeTurn(), probeTurn(), fauxAssistantMessage("first done")]);
    expect(await runner.run(1, "one")).toEqual(["first done"]);

    agent.faux.setResponses([probeTurn(), probeTurn(), fauxAssistantMessage("second done")]);
    expect(await runner.run(1, "two")).toEqual(["second done"]);
    expect(probeCalls()).toBe(4);
  });

  test("no budget is enforced when turnMaxTools is 0 (unlimited)", async () => {
    const { runner, agent, probeCalls } = await makeTurnRunner({
      configOverrides: { turnMaxTools: 0 },
    });
    agent.faux.setResponses([
      probeTurn(),
      probeTurn(),
      probeTurn(),
      probeTurn(),
      fauxAssistantMessage("done"),
    ]);

    expect(await runner.run(1, "hello")).toEqual(["done"]);
    expect(probeCalls()).toBe(4);
  });
});

// ── 3. Per-turn cost limit ────────────────────────────────────────────────────

describe("TurnRunner — per-turn cost limit", () => {
  // $1000 per million tokens: any turn costs far more than the tiny limits below.
  const pricey = { input: 1000, output: 1000 };

  test("aborts the turn once provider-reported cost goes over the limit", async () => {
    const { runner, agent, probeCalls } = await makeTurnRunner({
      cost: pricey,
      configOverrides: { turnMaxCostUsd: 0.001 }, // very low limit
    });
    agent.faux.setResponses([probeTurn(), fauxAssistantMessage("never reached")]);

    const replies = await runner.run(1, "hi");

    expect(replies.join(" ")).toMatch(/Per-turn cost limit/);
    expect(replies.join(" ")).not.toContain("never reached");
    expect(agent.faux.state.callCount).toBe(1);
    expect(probeCalls()).toBeLessThanOrEqual(1);
  });

  test("a turn under the limit completes normally", async () => {
    const { runner, agent } = await makeTurnRunner({
      cost: pricey,
      configOverrides: { turnMaxCostUsd: 5 },
    });
    agent.faux.setResponses([probeTurn(), fauxAssistantMessage("all good")]);

    expect(await runner.run(1, "hi")).toEqual(["all good"]);
  });

  test("no limit is enforced when turnMaxCostUsd is 0 (unlimited)", async () => {
    const { runner, agent } = await makeTurnRunner({
      cost: pricey,
      configOverrides: { turnMaxCostUsd: 0 },
    });
    agent.faux.setResponses([probeTurn(), fauxAssistantMessage("all good")]);

    expect(await runner.run(1, "hi")).toEqual(["all good"]);
  });
});
