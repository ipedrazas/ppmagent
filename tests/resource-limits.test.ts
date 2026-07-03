/**
 * Tests for the three resource limit features in TurnRunner:
 *   1. Session cost limit — refuse a turn when accumulated cost exceeds the cap
 *   2. Per-turn tool budget — abort when tool call count exceeds the cap
 *   3. Per-turn cost limit — abort mid-turn when estimated cost exceeds the cap
 */
import { describe, expect, test } from "bun:test";
import type { BeforeToolCallContext } from "@earendil-works/pi-agent-core";
import type { BuiltAgent } from "../src/agent.ts";
import { MetricsCollector } from "../src/metrics/collector.ts";
import type { SessionStore } from "../src/session/store.ts";
import { ChatSession } from "../src/telegram/chat-session.ts";
import type { TelegramClient } from "../src/telegram/client.ts";
import { TurnRunner } from "../src/telegram/turn-runner.ts";
import { makeTestConfig } from "./support/config.ts";

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

function mockClient(): { client: TelegramClient; sent: { chatId: number; text: string }[] } {
  const sent: { chatId: number; text: string }[] = [];
  const client = {
    sendMessage: async (chatId: number, text: string) => sent.push({ chatId, text }),
    sendChatAction: async () => {},
  } as unknown as TelegramClient;
  return { client, sent };
}

type AgentEventListener = (
  event: { type: string; [k: string]: unknown },
  signal: AbortSignal,
) => void;

function makeBuilt(
  opts: {
    promptImpl?: () => Promise<void>;
    onSubscribe?: (listener: AgentEventListener) => void;
  } = {},
): {
  built: BuiltAgent;
  promptCalled: () => boolean;
  abortCalled: () => boolean;
  beforeToolCall: () =>
    | ((ctx: BeforeToolCallContext, sig?: AbortSignal) => Promise<unknown>)
    | undefined;
} {
  let promptCalled = false;
  let abortCalled = false;
  let beforeToolCallFn:
    | ((ctx: BeforeToolCallContext, sig?: AbortSignal) => Promise<unknown>)
    | undefined;

  const agent = {
    state: { messages: [] },
    get beforeToolCall() {
      return beforeToolCallFn;
    },
    set beforeToolCall(val: typeof beforeToolCallFn) {
      beforeToolCallFn = val;
    },
    abort() {
      abortCalled = true;
    },
    subscribe(listener: AgentEventListener) {
      opts.onSubscribe?.(listener);
      return () => {};
    },
    async prompt() {
      promptCalled = true;
      if (opts.promptImpl) await opts.promptImpl();
    },
  };

  const built = {
    agent,
    ppm: {},
    databox: {},
    proteos: {},
    memoryContext: { hook: async (m: unknown[]) => m, sliceTokens: () => 0 },
  } as unknown as BuiltAgent;

  return {
    built,
    promptCalled: () => promptCalled,
    abortCalled: () => abortCalled,
    beforeToolCall: () => beforeToolCallFn,
  };
}

function makeTurnRunner(
  built: BuiltAgent,
  overrides: {
    metrics?: MetricsCollector;
    configOverrides?: Parameters<typeof makeTestConfig>[0];
  } = {},
): { runner: TurnRunner; sent: { chatId: number; text: string }[] } {
  const config = makeTestConfig(overrides.configOverrides);
  const store = mockStore();
  const session = new ChatSession(config, { store });
  session.attach(built);
  const { client, sent } = mockClient();

  const runner = new TurnRunner({
    session,
    built,
    config,
    client,
    send: async (chatId, msgs) => {
      for (const m of msgs) sent.push({ chatId, text: m });
    },
    abortSignal: new AbortController().signal,
    metrics: overrides.metrics,
  });

  return { runner, sent };
}

// ── 1. Session cost limit ─────────────────────────────────────────────────────

describe("TurnRunner — session cost limit", () => {
  test("refuses the turn when session cost has reached the cap", async () => {
    // Record two turns that together cost ~$6 (1M tokens × $6/M for sonnet-4-6)
    const metrics = new MetricsCollector({ provider: "anthropic", model: "claude-sonnet-4-6" });
    metrics.recordTurn({ durationMs: 100, tokensBefore: 0, tokensAfter: 1_000_000 });

    const { built, promptCalled } = makeBuilt();
    const { runner, sent } = makeTurnRunner(built, {
      metrics,
      configOverrides: { sessionMaxCostUsd: 5 }, // limit is $5, spent is $6
    });

    const replies = await runner.run(1, "hello");
    expect(promptCalled()).toBe(false);
    expect(replies.join(" ")).toMatch(/cost limit/i);
    expect(sent.some((m) => m.text.match(/cost limit/i))).toBe(true);
  });

  test("allows the turn when session cost is below the cap", async () => {
    const metrics = new MetricsCollector({ provider: "anthropic", model: "claude-sonnet-4-6" });
    // 100k tokens = $0.60
    metrics.recordTurn({ durationMs: 100, tokensBefore: 0, tokensAfter: 100_000 });

    const { built, promptCalled } = makeBuilt();
    const { runner } = makeTurnRunner(built, {
      metrics,
      configOverrides: { sessionMaxCostUsd: 5 }, // limit $5, spent $0.60
    });

    await runner.run(1, "hello");
    expect(promptCalled()).toBe(true);
  });

  test("does not check limit when sessionMaxCostUsd is 0 (unlimited)", async () => {
    const metrics = new MetricsCollector({ provider: "anthropic", model: "claude-sonnet-4-6" });
    metrics.recordTurn({ durationMs: 100, tokensBefore: 0, tokensAfter: 10_000_000 });

    const { built, promptCalled } = makeBuilt();
    const { runner } = makeTurnRunner(built, {
      metrics,
      configOverrides: { sessionMaxCostUsd: 0 },
    });

    await runner.run(1, "hello");
    expect(promptCalled()).toBe(true);
  });
});

// ── 2. Per-turn tool budget ───────────────────────────────────────────────────

describe("TurnRunner — per-turn tool budget", () => {
  test("installs beforeToolCall when turnMaxTools > 0", async () => {
    let capturedBeforeToolCall:
      | ((ctx: BeforeToolCallContext, sig?: AbortSignal) => Promise<unknown>)
      | undefined;

    const { built } = makeBuilt({
      promptImpl: async () => {
        // Capture whatever beforeToolCall was set to during the turn
        capturedBeforeToolCall = built.agent.beforeToolCall as typeof capturedBeforeToolCall;
      },
    });

    const { runner } = makeTurnRunner(built, {
      configOverrides: { turnMaxTools: 5 },
    });

    await runner.run(1, "hello");
    expect(capturedBeforeToolCall).toBeTypeOf("function");
  });

  test("restores beforeToolCall to undefined after the turn", async () => {
    const { built } = makeBuilt();
    const { runner } = makeTurnRunner(built, {
      configOverrides: { turnMaxTools: 3 },
    });

    await runner.run(1, "hello");
    // afterthe turn, the original (undefined) should be restored
    expect(built.agent.beforeToolCall).toBeUndefined();
  });

  test("beforeToolCall allows calls within budget", async () => {
    let capturedBeforeToolCall:
      | ((ctx: BeforeToolCallContext, sig?: AbortSignal) => Promise<unknown>)
      | undefined;

    const { built } = makeBuilt({
      promptImpl: async () => {
        capturedBeforeToolCall = built.agent.beforeToolCall as typeof capturedBeforeToolCall;
      },
    });

    const { runner } = makeTurnRunner(built, {
      configOverrides: { turnMaxTools: 3 },
    });

    await runner.run(1, "hello");

    // First 3 calls should be allowed (return undefined = proceed)
    const ctx = {} as BeforeToolCallContext;
    if (!capturedBeforeToolCall) throw new Error("beforeToolCall was not captured");
    expect(await capturedBeforeToolCall(ctx)).toBeUndefined();
    expect(await capturedBeforeToolCall(ctx)).toBeUndefined();
    expect(await capturedBeforeToolCall(ctx)).toBeUndefined();
  });

  test("beforeToolCall blocks and aborts on the (budget+1)-th call", async () => {
    let capturedBeforeToolCall:
      | ((ctx: BeforeToolCallContext, sig?: AbortSignal) => Promise<unknown>)
      | undefined;
    let abortedFromGuard = false;

    const { built } = makeBuilt({
      promptImpl: async () => {
        capturedBeforeToolCall = built.agent.beforeToolCall as typeof capturedBeforeToolCall;
        // Override abort to track the call
        built.agent.abort = () => {
          abortedFromGuard = true;
        };
      },
    });

    const { runner } = makeTurnRunner(built, {
      configOverrides: { turnMaxTools: 2 },
    });

    await runner.run(1, "hello");

    const ctx = {} as BeforeToolCallContext;
    if (!capturedBeforeToolCall) throw new Error("beforeToolCall was not captured");
    // First 2 allowed
    await capturedBeforeToolCall(ctx);
    await capturedBeforeToolCall(ctx);
    // 3rd call exceeds budget
    const result = (await capturedBeforeToolCall(ctx)) as { block?: boolean; reason?: string };
    expect(result?.block).toBe(true);
    expect(result?.reason).toMatch(/budget/i);
    expect(abortedFromGuard).toBe(true);
  });

  test("does not install beforeToolCall when turnMaxTools is 0 (unlimited)", async () => {
    let beforeToolCallDuringTurn: unknown;

    const { built } = makeBuilt({
      promptImpl: async () => {
        beforeToolCallDuringTurn = built.agent.beforeToolCall;
      },
    });

    const { runner } = makeTurnRunner(built, {
      configOverrides: { turnMaxTools: 0 },
    });

    await runner.run(1, "hello");
    expect(beforeToolCallDuringTurn).toBeUndefined();
  });
});

// ── 3. Per-turn cost limit ────────────────────────────────────────────────────

describe("TurnRunner — per-turn cost limit", () => {
  test("subscribes a turn_end listener when turnMaxCostUsd > 0 and metrics is set", async () => {
    let subscribeCallCount = 0;

    const metrics = new MetricsCollector({ provider: "anthropic", model: "claude-sonnet-4-6" });
    const { built } = makeBuilt({
      onSubscribe: () => {
        subscribeCallCount++;
      },
    });

    const { runner } = makeTurnRunner(built, {
      metrics,
      configOverrides: { turnMaxCostUsd: 0.5 },
    });

    await runner.run(1, "hello");
    // At minimum 2 subscriptions: terminating-tool listener + cost-limit listener
    expect(subscribeCallCount).toBeGreaterThanOrEqual(2);
  });

  test("does not subscribe a cost listener when turnMaxCostUsd is 0 (unlimited)", async () => {
    let subscribeCallCount = 0;
    const metrics = new MetricsCollector({ provider: "anthropic", model: "claude-sonnet-4-6" });
    const { built } = makeBuilt({
      onSubscribe: () => {
        subscribeCallCount++;
      },
    });

    const { runner } = makeTurnRunner(built, {
      metrics,
      configOverrides: { turnMaxCostUsd: 0 },
    });

    await runner.run(1, "hello");
    // Only the terminating-tool listener; no cost listener
    expect(subscribeCallCount).toBe(1);
  });

  test("aborts agent when turn_end event pushes cost over limit", async () => {
    const listeners: AgentEventListener[] = [];
    let abortCalled = false;

    const metrics = new MetricsCollector({ provider: "anthropic", model: "claude-sonnet-4-6" });

    // Bootstrap 500k tokens to make cost = $3 per estimateTurnCostUsd(0, 500_000)
    // The session has 0 tokens before the turn, and after "turn_end" there are 500k tokens.
    // With turnMaxCostUsd = 1, the cost ($3) exceeds the limit.

    // We'll manipulate session messages to simulate token accumulation.
    // But since contextTokens returns 0 for empty messages and sliceTokens = 0,
    // we need to make estimateTurnCostUsd return a value > limit.
    // The easiest way: use a costPer1M and add tokens via a custom metrics that
    // returns a high cost.

    const { built } = makeBuilt({
      onSubscribe: (listener) => {
        listeners.push(listener);
      },
    });

    // Override abort on the already-created agent
    built.agent.abort = () => {
      abortCalled = true;
    };

    // Spy on estimateTurnCostUsd via the metrics instance
    // We need estimateTurnCostUsd to return > 0.01 (our limit)
    // Since session messages are empty (0 tokens), we use a provider with a high cost
    // and simulate token growth by patching memoryContext.sliceTokens
    const highCostMetrics = new MetricsCollector({
      provider: "anthropic",
      model: "claude-opus-4-8", // $30/M
    });

    const { runner } = makeTurnRunner(built, {
      metrics: highCostMetrics,
      configOverrides: { turnMaxCostUsd: 0.001 }, // very low limit
    });

    // Simulate: after the turn starts, patch sliceTokens to return 1000 tokens
    // so estimateTurnCostUsd(0, 1000) = 1000/1M * 30 = $0.03 > $0.001
    built.memoryContext.sliceTokens = () => 1000;

    // Start the run (it will set up the cost listener)
    const runPromise = runner.run(1, "hi");

    // Fire a turn_end event to trigger the cost check
    const sig = new AbortController().signal;
    for (const l of listeners) {
      l({ type: "turn_end", message: {}, toolResults: [] }, sig);
    }

    await runPromise;
    expect(abortCalled).toBe(true);
  });
});
