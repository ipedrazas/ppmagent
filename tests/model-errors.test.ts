/**
 * A misconfigured or failing model must be visible, not silent.
 *
 * A failed provider call settles the durable turn as `unanswered` with reason
 * `model_error` and the provider's message as detail, and an unresolvable model
 * must fail at startup rather than per turn. Both used to end as a bare
 * "(no reply)" with nothing in the logs, so both are pinned here.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { type AssistantMessage, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { resolveModel } from "../src/agent.ts";
import type { SessionStore } from "../src/session/store.ts";
import { ChatSession } from "../src/telegram/chat-session.ts";
import type { TelegramClient } from "../src/telegram/client.ts";
import { TurnRunner } from "../src/telegram/turn-runner.ts";
import { makeTestConfig } from "./support/config.ts";
import { type FauxAgent, makeFauxAgent } from "./support/faux-agent.ts";

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

describe("resolveModel", () => {
  test("resolves a known model id", () => {
    const config = makeTestConfig({ provider: "openrouter", model: "deepseek/deepseek-v4-flash" });
    expect(resolveModel(config).id).toBe("deepseek/deepseek-v4-flash");
  });

  test("never returns undefined for an uncatalogued id", () => {
    // An unresolvable model would park every turn as `no_model` — the
    // "(no reply)" bug — so resolution must yield a model or throw.
    const config = makeTestConfig({
      provider: "openrouter",
      model: "deepseek/deepseek-v4-flash-zz9",
    });
    expect(resolveModel(config)).toBeDefined();
  });

  test("an uncatalogued id keeps the provider's real endpoint and wire API", () => {
    const config = makeTestConfig({
      provider: "openrouter",
      model: "deepseek/deepseek-v4-flash-zz9",
    });
    const model = resolveModel(config);
    expect(model.id).toBe("deepseek/deepseek-v4-flash-zz9");
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
      makeTestConfig({ provider: "openrouter", model: "deepseek/deepseek-v4-flash-zz9" }),
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
  const agents: FauxAgent[] = [];
  afterEach(async () => {
    await Promise.all(agents.splice(0).map((a) => a.close()));
  });

  async function runTurn(script: AssistantMessage[]): Promise<string[]> {
    const client = {
      sendMessage: async () => {},
      sendChatAction: async () => {},
    } as unknown as TelegramClient;
    const config = makeTestConfig();
    const agent = await makeFauxAgent(config);
    agents.push(agent);
    agent.faux.setResponses(script);
    const session = new ChatSession(config, { store: mockStore() });
    session.attach(agent.built);
    const runner = new TurnRunner({
      session,
      built: agent.built,
      config,
      client,
      send: async () => {},
      abortSignal: new AbortController().signal,
    });
    return runner.run(7, "hello");
  }

  const failure = (errorMessage: string) =>
    fauxAssistantMessage("", { stopReason: "error", errorMessage });

  test("reports the provider error instead of '(no reply)'", async () => {
    const replies = await runTurn([failure("No API provider registered for api: unknown")]);
    expect(replies).toHaveLength(1);
    expect(replies[0]).toContain("No API provider registered for api: unknown");
    expect(replies[0]).not.toContain("(no reply)");
  });

  test("names the model that failed", async () => {
    const replies = await runTurn([failure("401 Unauthorized")]);
    expect(replies[0]).toContain("faux/faux-1");
  });

  test("still falls back to '(no reply)' when the turn ends with no error", async () => {
    const replies = await runTurn([fauxAssistantMessage("")]);
    expect(replies).toEqual(["(no reply)"]);
  });
});
