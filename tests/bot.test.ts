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

describe("TelegramBot.start — failed turn notification", () => {
  test("sends an error message to the user when a turn throws", async () => {
    const sent: Array<{ chatId: number; text: string }> = [];
    let callCount = 0;
    // ctx.stop is set after bot is created so the closure can reach bot.stop()
    // without a `let` variable for the bot reference.
    const ctx: { stop: () => void } = { stop: () => {} };

    const client = {
      getUpdates: async () => {
        callCount++;
        if (callCount === 1) {
          return [{ updateId: 1, message: { chatId: 99, text: "hello" } }];
        }
        ctx.stop();
        return [];
      },
      sendMessage: async (chatId: number, text: string) => {
        sent.push({ chatId, text });
      },
      sendChatAction: async () => {},
    } as unknown as TelegramClient;

    const built = {
      agent: {
        state: { messages: [] },
        subscribe: () => () => {},
        prompt: async () => {
          throw new Error("model call failed");
        },
      },
      ppm: {},
      databox: {},
      proteos: {},
      memoryContext: { hook: async (m: unknown[]) => m, sliceTokens: () => 0 },
    } as unknown as BuiltAgent;

    const config = makeTestConfig();
    const store = mockStore();
    const session = new ChatSession(config, { store });
    session.attach(built);
    const bot = new TelegramBot(config, built, session, { client, store });
    ctx.stop = () => bot.stop();

    await bot.start();

    const errorMsg = sent.find((m) => m.chatId === 99 && m.text.includes("model call failed"));
    expect(errorMsg).toBeDefined();
  });

  test("error message includes error.message but not the stack trace", async () => {
    const sent: Array<{ chatId: number; text: string }> = [];
    let callCount = 0;
    let thrownError: Error | undefined;
    const ctx: { stop: () => void } = { stop: () => {} };

    const client = {
      getUpdates: async () => {
        callCount++;
        if (callCount === 1) {
          return [{ updateId: 1, message: { chatId: 7, text: "hi" } }];
        }
        ctx.stop();
        return [];
      },
      sendMessage: async (chatId: number, text: string) => {
        sent.push({ chatId, text });
      },
      sendChatAction: async () => {},
    } as unknown as TelegramClient;

    const built = {
      agent: {
        state: { messages: [] },
        subscribe: () => () => {},
        prompt: async () => {
          thrownError = new Error("short human message");
          throw thrownError;
        },
      },
      ppm: {},
      databox: {},
      proteos: {},
      memoryContext: { hook: async (m: unknown[]) => m, sliceTokens: () => 0 },
    } as unknown as BuiltAgent;

    const config = makeTestConfig();
    const store = mockStore();
    const session = new ChatSession(config, { store });
    session.attach(built);
    const bot = new TelegramBot(config, built, session, { client, store });
    ctx.stop = () => bot.stop();

    await bot.start();

    const userMsgs = sent.filter((m) => m.chatId === 7);
    expect(userMsgs.length).toBeGreaterThan(0);
    // Message includes the human-readable error message…
    expect(userMsgs.some((m) => m.text.includes("short human message"))).toBe(true);
    // …but not the raw stack trace (error.stack contains "    at " frames).
    expect(userMsgs.every((m) => !m.text.includes("    at "))).toBe(true);
    // Ensure thrownError actually had a stack so the test isn't vacuous.
    expect(thrownError?.stack).toContain("    at ");
  });
});
