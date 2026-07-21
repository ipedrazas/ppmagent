/**
 * TAV-136: a clarifying question (ask_user, or any tool that terminates the
 * loop) must appear in the reply AFTER the assistant's leading context text,
 * not before it. `tool_execution_end` fires synchronously inside
 * `agent.prompt()`, before that same turn's assistant message is readable
 * back out of `session.messages` — so the two texts must be assembled in
 * explicit chronological order rather than push order.
 */
import { describe, expect, test } from "bun:test";
import type { BuiltAgent } from "../src/agent.ts";
import type { SessionStore } from "../src/session/store.ts";
import { ChatSession } from "../src/telegram/chat-session.ts";
import type { TelegramClient } from "../src/telegram/client.ts";
import { TurnRunner } from "../src/telegram/turn-runner.ts";
import { makeTestConfig } from "./support/config.ts";

type AgentEventListener = (
  event: { type: string; [k: string]: unknown },
  signal: AbortSignal,
) => void;

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

/**
 * Builds a mock `BuiltAgent` whose `prompt()` reproduces the real agent
 * loop's event ordering for a turn that ends in a terminating tool call: the
 * assistant message (context text + tool call) lands in `state.messages`
 * first, then `tool_execution_end` fires for the terminating tool — both
 * before `prompt()` resolves — matching `agent-loop.js`'s
 * `executeToolCalls()` → `turn_end` sequencing.
 */
function makeBuiltWithClarifyingQuestion(contextText: string, question: string): BuiltAgent {
  const listeners: AgentEventListener[] = [];
  const agent = {
    state: { messages: [] as unknown[] },
    beforeToolCall: undefined,
    abort() {},
    subscribe(listener: AgentEventListener) {
      listeners.push(listener);
      return () => {};
    },
    async prompt() {
      (agent.state.messages as unknown[]).push({
        role: "assistant",
        content: [
          { type: "text", text: contextText },
          { type: "toolCall", id: "tc1", name: "ask_user", arguments: { question } },
        ],
      });
      const sig = new AbortController().signal;
      for (const l of listeners) {
        l(
          {
            type: "tool_execution_end",
            toolName: "ask_user",
            toolCallId: "tc1",
            isError: false,
            result: { content: [{ type: "text", text: question }], terminate: true },
          },
          sig,
        );
      }
    },
  };
  return {
    agent,
    ppm: {},
    databox: {},
    proteos: {},
    memoryContext: { hook: async (m: unknown[]) => m, sliceTokens: () => 0 },
  } as unknown as BuiltAgent;
}

function makeTurnRunner(built: BuiltAgent): {
  runner: TurnRunner;
  sent: { chatId: number; text: string }[];
} {
  const config = makeTestConfig();
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
  });

  return { runner, sent };
}

describe("TurnRunner — clarifying question message ordering (TAV-136)", () => {
  test("context text precedes the clarifying question in the reply", async () => {
    const contextText =
      "This is a new tab like the existing Analyse, Diff, Extract, Tools tabs. Let me clarify the scope a bit.";
    const question = "For the Visualizer tab — what should the tree represent?";
    const { runner } = makeTurnRunner(makeBuiltWithClarifyingQuestion(contextText, question));

    const replies = await runner.run(1, "add a visualizer tab");
    expect(replies).toEqual([contextText, question]);
  });

  test("context text precedes the question across multiple independent clarifying turns", async () => {
    const rounds: Array<[string, string]> = [
      ["Let me clarify the scope a bit.", "What should the tree represent?"],
      ["One more thing before I start.", "Should it support drag-and-drop reordering?"],
      ["Quick follow-up.", "Which repos should the tab cover?"],
    ];

    for (const [contextText, question] of rounds) {
      const { runner } = makeTurnRunner(makeBuiltWithClarifyingQuestion(contextText, question));
      const replies = await runner.run(1, "add a visualizer tab");
      expect(replies).toEqual([contextText, question]);
    }
  });
});
