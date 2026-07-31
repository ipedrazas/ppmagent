/**
 * A misconfigured or failing model must be visible, not silent.
 *
 * pi-agent-core never throws out of `Agent.prompt()`: an unresolvable model is
 * replaced by a placeholder (`api: "unknown"`) and any run failure becomes an
 * assistant message with empty text plus `errorMessage`. Both paths used to end
 * as a bare "(no reply)" with nothing in the logs, so both are pinned here.
 */
import { describe, expect, test } from "bun:test";
import type { BuiltAgent } from "../src/agent.ts";
import { resolveModel } from "../src/agent.ts";
import type { SessionStore } from "../src/session/store.ts";
import { ChatSession } from "../src/telegram/chat-session.ts";
import type { TelegramClient } from "../src/telegram/client.ts";
import { TurnRunner } from "../src/telegram/turn-runner.ts";
import { makeTestConfig } from "./support/config.ts";

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

/** A `BuiltAgent` whose `prompt()` emits the given events and appends no assistant text. */
function fakeBuiltAgent(events: Array<Record<string, unknown>>): BuiltAgent {
  const listeners = new Set<(event: unknown) => void | Promise<void>>();
  return {
    agent: {
      state: { messages: [] },
      subscribe: (listener: (event: unknown) => void | Promise<void>) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      prompt: async () => {
        for (const event of events) {
          for (const listener of listeners) await listener(event);
        }
      },
      abort: () => {},
    },
    model: { id: "deepseek/deepseek-v4-flash", provider: "openrouter" },
    ppm: {},
    databox: {},
    proteos: {},
    pulse: {},
    memoryContext: { hook: async (m: unknown[]) => m, sliceTokens: () => 0 },
  } as unknown as BuiltAgent;
}

/** A `turn_end` event shaped like pi's synthetic failure message. */
function failedTurn(errorMessage: string): Record<string, unknown> {
  return {
    type: "turn_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "" }],
      model: "deepseek/deepseek-v4-flash",
      provider: "openrouter",
      stopReason: "error",
      errorMessage,
      usage: { totalTokens: 0, cost: { total: 0 } },
    },
    toolResults: [],
  };
}

describe("resolveModel", () => {
  test("resolves a known model id", () => {
    const config = makeTestConfig({ provider: "openrouter", model: "deepseek/deepseek-v4-flash" });
    expect(resolveModel(config).id).toBe("deepseek/deepseek-v4-flash");
  });

  test("never returns undefined for an uncatalogued id", () => {
    // An undefined model is what pi replaces with its `api: "unknown"`
    // placeholder, which fails every turn silently — the "(no reply)" bug.
    const config = makeTestConfig({
      provider: "openrouter",
      model: "deepseek/deepseek-v4-flash-0731",
    });
    expect(resolveModel(config)).toBeDefined();
  });

  test("an uncatalogued id keeps the provider's real endpoint and wire API", () => {
    const config = makeTestConfig({
      provider: "openrouter",
      model: "deepseek/deepseek-v4-flash-0731",
    });
    const model = resolveModel(config);
    expect(model.id).toBe("deepseek/deepseek-v4-flash-0731");
    expect(model.provider).toBe("openrouter");
    expect(model.api).toBe("openai-completions");
    expect(model.baseUrl).toBe("https://openrouter.ai/api/v1");
  });

  test("an uncatalogued id is warned about, naming the closest catalog entries", () => {
    const warnings: Array<{ message: string; metadata: Record<string, unknown> }> = [];
    let metadata: Record<string, unknown> = {};
    const logger = {
      withMetadata(meta: Record<string, unknown>) {
        metadata = meta;
        return this;
      },
      warn(message: string) {
        warnings.push({ message, metadata });
      },
    } as unknown as Parameters<typeof resolveModel>[1];

    resolveModel(
      makeTestConfig({ provider: "openrouter", model: "deepseek/deepseek-v4-flash-0731" }),
      logger,
    );

    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.message).toContain("not in pi's catalog");
    expect(warnings[0]?.metadata.closestCatalogIds).toContain("deepseek/deepseek-v4-flash");
  });

  test("throws for a provider whose wire format cannot be synthesized", () => {
    const config = makeTestConfig({ provider: "anthropic", model: "claude-not-a-real-model" });
    expect(() => resolveModel(config)).toThrow(/Unknown model "claude-not-a-real-model"/);
  });

  test("ollama bypasses the catalog (no fixed model list)", () => {
    const config = makeTestConfig({
      provider: "ollama",
      model: "some-local-model",
      baseUrl: "http://localhost:11434/v1",
    });
    expect(resolveModel(config).id).toBe("some-local-model");
  });
});

describe("a failed model call", () => {
  async function runTurn(events: Array<Record<string, unknown>>): Promise<string[]> {
    const client = {
      sendMessage: async () => {},
      sendChatAction: async () => {},
    } as unknown as TelegramClient;
    const config = makeTestConfig();
    const built = fakeBuiltAgent(events);
    const session = new ChatSession(config, { store: mockStore() });
    session.attach(built);
    const runner = new TurnRunner({
      session,
      built,
      config,
      client,
      send: async () => {},
      abortSignal: new AbortController().signal,
    });
    return runner.run(7, "hello");
  }

  test("reports the provider error instead of '(no reply)'", async () => {
    const replies = await runTurn([failedTurn("No API provider registered for api: unknown")]);
    expect(replies).toHaveLength(1);
    expect(replies[0]).toContain("No API provider registered for api: unknown");
    expect(replies[0]).not.toContain("(no reply)");
  });

  test("names the model that failed", async () => {
    const replies = await runTurn([failedTurn("401 Unauthorized")]);
    expect(replies[0]).toContain("openrouter/deepseek/deepseek-v4-flash");
  });

  test("still falls back to '(no reply)' when the turn ends with no error", async () => {
    const replies = await runTurn([]);
    expect(replies).toEqual(["(no reply)"]);
  });
});
