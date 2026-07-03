import { describe, expect, test } from "bun:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { BuiltAgent } from "../src/agent.ts";
import type { SessionState, SessionStore } from "../src/session/store.ts";
import { ChatSession } from "../src/telegram/chat-session.ts";
import { CommandRouter } from "../src/telegram/command-router.ts";
import { makeTestConfig } from "./support/config.ts";

function memStore(seed?: SessionState): SessionStore {
  let current = seed ?? null;
  return {
    load: () => current,
    save: (s: SessionState) => {
      current = s;
    },
    list: () => (current ? [{ ...current, messageCount: current.messages.length }] : []),
    find: () => undefined,
  } as unknown as SessionStore;
}

function fakeBuilt(): BuiltAgent {
  return {
    agent: { state: { messages: [] as AgentMessage[] } },
    ppm: { write: async () => ({}) },
    memoryContext: { hook: async (m: AgentMessage[]) => m, sliceTokens: () => 0 },
  } as unknown as BuiltAgent;
}

/** A CommandRouter wired to a real ChatSession, capturing what it sends. */
function makeRouter() {
  const sent: Array<{ chatId: number; messages: string[] }> = [];
  const config = makeTestConfig();
  const session = new ChatSession(config, { store: memStore() });
  session.attach(fakeBuilt());
  const router = new CommandRouter({
    session,
    config,
    send: async (chatId, messages) => {
      sent.push({ chatId, messages });
    },
    abortSignal: new AbortController().signal,
  });
  return { router, session, sent };
}

describe("CommandRouter.route", () => {
  test("returns null for a non-command message (caller runs it as a turn)", async () => {
    const { router, sent } = makeRouter();
    expect(await router.route(1, "just a normal message")).toBeNull();
    expect(sent).toHaveLength(0); // nothing sent — it's not a command
  });

  test("/help returns and sends the command list", async () => {
    const { router, sent } = makeRouter();
    const replies = await router.route(1, "/help");
    expect(replies?.[0]).toContain("/project");
    expect(replies?.[0]).toContain("/cancel");
    expect(sent.at(-1)?.messages[0]).toContain("Available commands:");
  });

  test("/project sets the active project on the session", async () => {
    const { router, session } = makeRouter();
    const replies = await router.route(1, "/project onboarding");
    expect(replies?.[0]).toContain("onboarding");
    expect(session.activeProject).toBe("onboarding");
  });

  test("/project with no slug reports usage and does not change the project", async () => {
    const { router, session } = makeRouter();
    const replies = await router.route(1, "/project");
    expect(replies?.[0]).toContain("Usage: /project");
    expect(session.activeProject).toBeUndefined();
  });
});
