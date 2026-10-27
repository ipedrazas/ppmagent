import { afterEach, describe, expect, test } from "bun:test";
import type { SessionState, SessionStore } from "../src/session/store.ts";
import { ChatSession } from "../src/telegram/chat-session.ts";
import { makeTestConfig } from "./support/config.ts";
import { type FauxAgent, makeFauxAgent } from "./support/faux-agent.ts";

/** In-memory SessionStore: enough of the surface ChatSession touches. */
function memStore(seed?: SessionState): { store: SessionStore; saved: SessionState[] } {
  const saved: SessionState[] = [];
  let current = seed ?? null;
  const store = {
    load: () => current,
    save: (s: SessionState) => {
      current = s;
      saved.push(structuredClone(s));
    },
    list: () => (current ? [{ ...current }] : []),
    find: () => undefined,
  } as unknown as SessionStore;
  return { store, saved };
}

let agent: FauxAgent | undefined;
afterEach(async () => {
  await agent?.close();
  agent = undefined;
});

describe("ChatSession — holder-fix seam", () => {
  test("activeProject is readable and settable BEFORE attach (no agent needed)", () => {
    const { store } = memStore();
    const session = new ChatSession(makeTestConfig(), { store });
    // This is the guarantee that lets buildAgent's memory seam close over the
    // session instead of a mutable bot holder.
    expect(session.activeProject).toBeUndefined();
    session.activeProject = "onboarding";
    expect(session.activeProject).toBe("onboarding");
  });

  test("a session has no durable conversation until first use", async () => {
    const { store } = memStore();
    const session = new ChatSession(makeTestConfig(), { store });
    agent = await makeFauxAgent(makeTestConfig());
    session.attach(agent.built);
    expect(session.conversationId).toBeUndefined();
    expect(await session.messages()).toEqual([]);

    const id = await session.ensureConversation();
    expect(session.conversationId).toBe(id);
    // Idempotent: the same conversation is reused.
    expect(await session.ensureConversation()).toBe(id);
  });

  test("a persisted conversation id the store no longer knows is replaced", async () => {
    const seed: SessionState = {
      sessionId: "s-1",
      conversationId: 9999,
      messages: [],
      messageCount: 4,
      createdAt: 1,
      updatedAt: 1,
    };
    const { store } = memStore(seed);
    const session = new ChatSession(makeTestConfig(), { store });
    agent = await makeFauxAgent(makeTestConfig());
    session.attach(agent.built);
    const id = await session.ensureConversation();
    expect(id).not.toBe(9999);
  });
});

describe("ChatSession — session lifecycle", () => {
  test("startNew carries the active project forward and starts without a conversation", async () => {
    const { store, saved } = memStore();
    const session = new ChatSession(makeTestConfig(), { store });
    agent = await makeFauxAgent(makeTestConfig());
    session.attach(agent.built);
    session.activeProject = "onboarding";
    const old = await session.ensureConversation();

    const fresh = session.startNew("review");

    expect(fresh.name).toBe("review");
    expect(session.activeProject).toBe("onboarding"); // carried forward
    expect(session.conversationId).toBeUndefined(); // fresh transcript
    expect(saved.at(-1)?.sessionId).toBe(fresh.sessionId); // persisted
    expect(saved.some((s) => s.conversationId === old)).toBe(true); // outgoing session kept its link
  });

  test("name get/set round-trips and persists via /name usage", async () => {
    const { store } = memStore();
    const session = new ChatSession(makeTestConfig(), { store });
    agent = await makeFauxAgent(makeTestConfig());
    session.attach(agent.built);
    session.name = "metrics-review";
    session.persist();
    expect(session.name).toBe("metrics-review");
  });

  test("resume with no argument lists saved sessions", async () => {
    const { store } = memStore();
    const session = new ChatSession(makeTestConfig(), { store });
    agent = await makeFauxAgent(makeTestConfig());
    session.attach(agent.built);
    expect(session.resume("")).toContain("No saved sessions yet.");
  });
});
