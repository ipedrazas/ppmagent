/**
 * TAV-136: a clarifying question (ask_user, or any tool that terminates the
 * loop) must appear in the reply AFTER the assistant's leading context text,
 * not before it. The reply is assembled from the committed transcript — the
 * last assistant message first, then the terminating tool's result — so the
 * order holds regardless of when events are delivered.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import type { SessionStore } from "../src/session/store.ts";
import { ChatSession } from "../src/telegram/chat-session.ts";
import type { TelegramClient } from "../src/telegram/client.ts";
import { TurnRunner } from "../src/telegram/turn-runner.ts";
import { makeTestConfig } from "./support/config.ts";
import { type FauxAgent, makeFauxAgent, scriptedTool } from "./support/faux-agent.ts";

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

/** A turn runner whose model says `contextText`, then calls a terminating `ask_user` with `question`. */
async function makeRunner(contextText: string, question: string): Promise<TurnRunner> {
  const config = makeTestConfig();
  const agent = await makeFauxAgent(config, {
    tools: [scriptedTool("ask_user", () => ({ text: question, terminate: true }))],
  });
  agents.push(agent);
  agent.faux.setResponses([
    fauxAssistantMessage([fauxText(contextText), fauxToolCall("ask_user", { question })], {
      stopReason: "toolUse",
    }),
  ]);
  const session = new ChatSession(config, { store: mockStore() });
  session.attach(agent.built);
  const client = {
    sendMessage: async () => {},
    sendChatAction: async () => {},
  } as unknown as TelegramClient;
  return new TurnRunner({
    session,
    built: agent.built,
    config,
    client,
    send: async () => {},
    abortSignal: new AbortController().signal,
  });
}

describe("TurnRunner — clarifying question message ordering (TAV-136)", () => {
  test("context text precedes the clarifying question in the reply", async () => {
    const contextText =
      "This is a new tab like the existing Analyse, Diff, Extract, Tools tabs. Let me clarify the scope a bit.";
    const question = "For the Visualizer tab — what should the tree represent?";
    const runner = await makeRunner(contextText, question);

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
      const runner = await makeRunner(contextText, question);
      const replies = await runner.run(1, "add a visualizer tab");
      expect(replies).toEqual([contextText, question]);
    }
  });
});
