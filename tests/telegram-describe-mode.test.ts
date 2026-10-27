import { afterEach, describe, expect, test } from "bun:test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import type { SessionStore } from "../src/session/store.ts";
import { TelegramBot } from "../src/telegram/bot.ts";
import { ChatSession } from "../src/telegram/chat-session.ts";
import type { TelegramClient } from "../src/telegram/client.ts";
import { makeTestConfig } from "./support/config.ts";
import { type FauxAgent, lastUserText, makeFauxAgent } from "./support/faux-agent.ts";

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

/** Drive inbound messages through a fresh TelegramBot and record the user text the model saw. */
async function makeBot(prompts: string[]) {
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
  const agent = await makeFauxAgent(config);
  agents.push(agent);
  agent.faux.setResponses(
    Array.from({ length: 8 }, () => (context: Parameters<typeof lastUserText>[0]) => {
      prompts.push(lastUserText(context));
      return fauxAssistantMessage("ok");
    }),
  );
  const session = new ChatSession(config, { store });
  session.attach(agent.built);
  const bot = new TelegramBot(config, agent.built, session, { client, store });
  ctx.stop = () => bot.stop();
  return { bot, enqueue: (text: string) => messages.push(text) };
}

describe("/describe mode", () => {
  test("disabled by default: the user message passes through unchanged", async () => {
    const prompts: string[] = [];
    const { bot, enqueue } = await makeBot(prompts);
    enqueue("hello there");
    await bot.start();
    expect(prompts).toEqual(["hello there"]);
  });

  test("once enabled, the reasoning prompt is prepended to subsequent turns", async () => {
    const prompts: string[] = [];
    const { bot, enqueue } = await makeBot(prompts);
    enqueue("/describe on");
    enqueue("hello there");
    await bot.start();
    expect(prompts).toHaveLength(1); // only the agent turn reaches the model; /describe is local
    expect(prompts[0]).toContain("You are in describe mode.");
    expect(prompts[0]).toContain("hello there");
  });

  test("turning it back off restores the unmodified message", async () => {
    const prompts: string[] = [];
    const { bot, enqueue } = await makeBot(prompts);
    enqueue("/describe on");
    enqueue("/describe off");
    enqueue("hello there");
    await bot.start();
    expect(prompts).toEqual(["hello there"]);
  });
});
