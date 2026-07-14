import { describe, expect, test } from "bun:test";
import type { BuiltAgent } from "../src/agent.ts";
import type { SessionStore } from "../src/session/store.ts";
import { TelegramBot } from "../src/telegram/bot.ts";
import { ChatSession } from "../src/telegram/chat-session.ts";
import type { TelegramClient } from "../src/telegram/client.ts";
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

/** A fake `BuiltAgent` that records every prompt it receives. */
function fakeBuiltAgent(prompts: string[]): BuiltAgent {
  return {
    agent: {
      state: { messages: [] },
      subscribe: () => () => {},
      prompt: async (text: string) => {
        prompts.push(text);
      },
    },
    ppm: {},
    databox: {},
    proteos: {},
    memoryContext: { hook: async (m: unknown[]) => m, sliceTokens: () => 0 },
  } as unknown as BuiltAgent;
}

/** Drive a single inbound message through a fresh TelegramBot and return prompts seen. */
function makeBot(prompts: string[]) {
  let callCount = 0;
  const messages: string[] = [];
  const ctx: { stop: () => void } = { stop: () => {} };
  const client = {
    getUpdates: async () => {
      callCount++;
      const msg = messages[callCount - 1];
      if (msg !== undefined) return [{ updateId: callCount, message: { chatId: 5, text: msg } }];
      ctx.stop();
      return [];
    },
    sendMessage: async () => {},
    sendChatAction: async () => {},
  } as unknown as TelegramClient;

  const config = makeTestConfig();
  const store = mockStore();
  const built = fakeBuiltAgent(prompts);
  const session = new ChatSession(config, { store });
  session.attach(built);
  const bot = new TelegramBot(config, built, session, { client, store });
  ctx.stop = () => bot.stop();
  return { bot, enqueue: (text: string) => messages.push(text) };
}

describe("/describe mode", () => {
  test("disabled by default: the user message passes through unchanged", async () => {
    const prompts: string[] = [];
    const { bot, enqueue } = makeBot(prompts);
    enqueue("hello there");
    await bot.start();
    expect(prompts).toEqual(["hello there"]);
  });

  test("once enabled, the reasoning prompt is prepended to subsequent turns", async () => {
    const prompts: string[] = [];
    const { bot, enqueue } = makeBot(prompts);
    enqueue("/describe on");
    enqueue("hello there");
    await bot.start();
    expect(prompts).toHaveLength(1); // only the agent turn calls prompt(); /describe is local
    expect(prompts[0]).toContain("You are in describe mode.");
    expect(prompts[0]).toContain("hello there");
  });

  test("turning it back off restores the unmodified message", async () => {
    const prompts: string[] = [];
    const { bot, enqueue } = makeBot(prompts);
    enqueue("/describe on");
    enqueue("/describe off");
    enqueue("hello there");
    await bot.start();
    expect(prompts).toEqual(["hello there"]);
  });
});
