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

/** Build a fake `BuiltAgent` whose `prompt()` fires the given events through `subscribe`. */
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
    },
    ppm: {},
    databox: {},
    proteos: {},
    memoryContext: { hook: async (m: unknown[]) => m, sliceTokens: () => 0 },
  } as unknown as BuiltAgent;
}

describe("PPMA_SHOW_TOOL_CALLS", () => {
  test("disabled by default: no tool-status messages are sent", async () => {
    const sent: Array<{ chatId: number; text: string }> = [];
    let callCount = 0;
    const ctx: { stop: () => void } = { stop: () => {} };
    const client = {
      getUpdates: async () => {
        callCount++;
        if (callCount === 1) return [{ updateId: 1, message: { chatId: 5, text: "hi" } }];
        ctx.stop();
        return [];
      },
      sendMessage: async (chatId: number, text: string) => {
        sent.push({ chatId, text });
      },
      sendChatAction: async () => {},
    } as unknown as TelegramClient;

    const built = fakeBuiltAgent([
      { type: "tool_execution_start", toolCallId: "1", toolName: "some_tool", args: { a: 1 } },
      {
        type: "tool_execution_end",
        toolCallId: "1",
        toolName: "some_tool",
        result: {},
        isError: false,
      },
    ]);

    const config = makeTestConfig({ showToolCalls: false });
    const store = mockStore();
    const session = new ChatSession(config, { store });
    session.attach(built);
    const bot = new TelegramBot(config, built, session, { client, store });
    ctx.stop = () => bot.stop();

    await bot.start();

    expect(sent.some((m) => m.text.includes("some_tool"))).toBe(false);
  });

  test("enabled: sends a message for tool start and tool end, in order", async () => {
    const sent: Array<{ chatId: number; text: string }> = [];
    let callCount = 0;
    const ctx: { stop: () => void } = { stop: () => {} };
    const client = {
      getUpdates: async () => {
        callCount++;
        if (callCount === 1) return [{ updateId: 1, message: { chatId: 5, text: "hi" } }];
        ctx.stop();
        return [];
      },
      sendMessage: async (chatId: number, text: string) => {
        sent.push({ chatId, text });
      },
      sendChatAction: async () => {},
    } as unknown as TelegramClient;

    const built = fakeBuiltAgent([
      {
        type: "tool_execution_start",
        toolCallId: "1",
        toolName: "tracker_create_task",
        args: { title: "fix bug" },
      },
      {
        type: "tool_execution_end",
        toolCallId: "1",
        toolName: "tracker_create_task",
        result: { content: [{ type: "text", text: "created TAV-1" }] },
        isError: false,
      },
    ]);

    const config = makeTestConfig({ showToolCalls: true });
    const store = mockStore();
    const session = new ChatSession(config, { store });
    session.attach(built);
    const bot = new TelegramBot(config, built, session, { client, store });
    ctx.stop = () => bot.stop();

    await bot.start();

    const toolMsgs = sent.filter((m) => m.chatId === 5 && m.text.includes("tracker_create_task"));
    expect(toolMsgs.length).toBe(2);
    expect(toolMsgs[0]?.text).toContain("Calling");
    expect(toolMsgs[0]?.text).toContain("fix bug");
    expect(toolMsgs[1]?.text).toContain("created TAV-1");
  });

  test("enabled: an error result is marked distinctly from success", async () => {
    const sent: Array<{ chatId: number; text: string }> = [];
    let callCount = 0;
    const ctx: { stop: () => void } = { stop: () => {} };
    const client = {
      getUpdates: async () => {
        callCount++;
        if (callCount === 1) return [{ updateId: 1, message: { chatId: 5, text: "hi" } }];
        ctx.stop();
        return [];
      },
      sendMessage: async (chatId: number, text: string) => {
        sent.push({ chatId, text });
      },
      sendChatAction: async () => {},
    } as unknown as TelegramClient;

    const built = fakeBuiltAgent([
      { type: "tool_execution_start", toolCallId: "1", toolName: "exec_run", args: { cmd: "ls" } },
      {
        type: "tool_execution_end",
        toolCallId: "1",
        toolName: "exec_run",
        result: { content: [{ type: "text", text: "boom" }] },
        isError: true,
      },
    ]);

    const config = makeTestConfig({ showToolCalls: true });
    const store = mockStore();
    const session = new ChatSession(config, { store });
    session.attach(built);
    const bot = new TelegramBot(config, built, session, { client, store });
    ctx.stop = () => bot.stop();

    await bot.start();

    const endMsg = sent.find((m) => m.chatId === 5 && m.text.includes("boom"));
    expect(endMsg?.text).toContain("failed");
  });
});
