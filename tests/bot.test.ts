import { afterEach, describe, expect, test } from "bun:test";
import type { SessionStore } from "../src/session/store.ts";
import { TelegramBot } from "../src/telegram/bot.ts";
import { ChatSession } from "../src/telegram/chat-session.ts";
import type { TelegramClient } from "../src/telegram/client.ts";
import { makeTestConfig } from "./support/config.ts";
import { type FauxAgent, makeFauxAgent } from "./support/faux-agent.ts";

const agents: FauxAgent[] = [];
afterEach(async () => {
  await Promise.all(agents.splice(0).map((a) => a.close()));
});

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

    const config = makeTestConfig();
    const agent = await makeFauxAgent(config);
    agents.push(agent);
    // The durable runtime itself failing (as opposed to a model error, which
    // settles the turn) must still reach the user.
    agent.built.runtime.runTurn = async () => {
      throw new Error("model call failed");
    };
    const built = agent.built;
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

    const config = makeTestConfig();
    const agent = await makeFauxAgent(config);
    agents.push(agent);
    agent.built.runtime.runTurn = async () => {
      thrownError = new Error("short human message");
      throw thrownError;
    };
    const built = agent.built;
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

describe("TelegramBot.start — non-text message handling", () => {
  test("sends a helpful reply for photo messages instead of silently ignoring them", async () => {
    const sent: Array<{ chatId: number; text: string }> = [];
    let callCount = 0;
    const ctx: { stop: () => void } = { stop: () => {} };

    const client = {
      getUpdates: async () => {
        callCount++;
        if (callCount === 1) {
          return [{ updateId: 1, message: { chatId: 42, nonText: "photo" } }];
        }
        ctx.stop();
        return [];
      },
      sendMessage: async (chatId: number, text: string) => {
        sent.push({ chatId, text });
      },
      sendChatAction: async () => {},
    } as unknown as TelegramClient;

    const config = makeTestConfig();
    const agent = await makeFauxAgent(config);
    agents.push(agent);
    const built = agent.built;
    const store = mockStore();
    const session = new ChatSession(config, { store });
    session.attach(built);
    const bot = new TelegramBot(config, built, session, { client, store });
    ctx.stop = () => bot.stop();

    await bot.start();

    const reply = sent.find((m) => m.chatId === 42 && m.text.includes("photo"));
    expect(reply).toBeDefined();
    expect(reply?.text).toContain("text messages");
  });
});
