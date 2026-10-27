import { afterEach, describe, expect, test } from "bun:test";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { SessionStore } from "../src/session/store.ts";
import { TelegramBot } from "../src/telegram/bot.ts";
import { ChatSession } from "../src/telegram/chat-session.ts";
import type { TelegramClient } from "../src/telegram/client.ts";
import type { AppTool } from "../src/tool-helpers.ts";
import { makeTestConfig } from "./support/config.ts";
import { type FauxAgent, fauxToolTurn, makeFauxAgent, scriptedTool } from "./support/faux-agent.ts";

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

/** Run one inbound "hi" through a bot whose model calls `toolName` once, then answers. */
async function runWithTool(
  showToolCalls: boolean,
  tool: AppTool,
  args: Record<string, string | number>,
): Promise<Array<{ chatId: number; text: string }>> {
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

  const config = makeTestConfig({ showToolCalls });
  const agent = await makeFauxAgent(config, { tools: [tool] });
  agents.push(agent);
  agent.faux.setResponses([
    fauxToolTurn(fauxToolCall(tool.name, args)),
    fauxAssistantMessage("all done"),
  ]);
  const store = mockStore();
  const session = new ChatSession(config, { store });
  session.attach(agent.built);
  const bot = new TelegramBot(config, agent.built, session, { client, store });
  ctx.stop = () => bot.stop();
  await bot.start();
  return sent;
}

describe("PPMA_SHOW_TOOL_CALLS", () => {
  test("disabled by default: no tool-status messages are sent", async () => {
    const sent = await runWithTool(
      false,
      scriptedTool("some_tool", () => ({ text: "ok" })),
      { a: 1 },
    );
    expect(sent.some((m) => m.text.includes("some_tool"))).toBe(false);
    expect(sent.some((m) => m.text === "all done")).toBe(true);
  });

  test("enabled: sends a message for tool start and tool end, in order", async () => {
    const sent = await runWithTool(
      true,
      scriptedTool("tracker_create_task", () => ({ text: "created TAV-1" })),
      { title: "fix bug" },
    );

    const toolMsgs = sent.filter((m) => m.chatId === 5 && m.text.includes("tracker_create_task"));
    expect(toolMsgs.length).toBe(2);
    expect(toolMsgs[0]?.text).toContain("Calling");
    expect(toolMsgs[0]?.text).toContain("fix bug");
    expect(toolMsgs[1]?.text).toContain("created TAV-1");
    // Status messages precede the final reply.
    expect(sent.findIndex((m) => m.text === "all done")).toBeGreaterThan(
      sent.findIndex((m) => m.text.includes("created TAV-1")),
    );
  });

  test("enabled: an error result is marked distinctly from success", async () => {
    const sent = await runWithTool(
      true,
      scriptedTool("exec_run", () => ({ text: "boom", fail: true })),
      { cmd: "ls" },
    );

    const endMsg = sent.find((m) => m.chatId === 5 && m.text.includes("boom"));
    expect(endMsg?.text).toContain("failed");
  });
});
