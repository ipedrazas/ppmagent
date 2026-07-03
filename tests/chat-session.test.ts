import { describe, expect, test } from "bun:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { BuiltAgent } from "../src/agent.ts";
import type { SessionState, SessionStore } from "../src/session/store.ts";
import { ChatSession } from "../src/telegram/chat-session.ts";
import { makeTestConfig } from "./support/config.ts";

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
    list: () => (current ? [{ ...current, messageCount: current.messages.length }] : []),
    find: () => undefined,
  } as unknown as SessionStore;
  return { store, saved };
}

/** A fake BuiltAgent whose transcript is a plain array. */
function fakeBuilt(): BuiltAgent {
  return {
    agent: { state: { messages: [] as AgentMessage[] } },
    ppm: { write: async () => ({}) },
  } as unknown as BuiltAgent;
}

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

  test("attach points the agent transcript at the session's messages", () => {
    const seed: SessionState = {
      sessionId: "s-1",
      messages: [{ role: "user", content: "hi", timestamp: 1 }] as AgentMessage[],
      createdAt: 1,
      updatedAt: 1,
    };
    const { store } = memStore(seed);
    const session = new ChatSession(makeTestConfig(), { store });
    const built = fakeBuilt();
    session.attach(built);
    expect(built.agent.state.messages).toBe(seed.messages);
    expect(session.messages).toHaveLength(1);
  });
});

describe("ChatSession — session lifecycle", () => {
  test("startNew carries the active project forward and clears the transcript", () => {
    const { store, saved } = memStore();
    const session = new ChatSession(makeTestConfig(), { store });
    const built = fakeBuilt();
    session.attach(built);
    session.activeProject = "onboarding";
    built.agent.state.messages.push({ role: "user", content: "old", timestamp: 1 } as AgentMessage);

    const fresh = session.startNew("review");

    expect(fresh.name).toBe("review");
    expect(session.activeProject).toBe("onboarding"); // carried forward
    expect(session.messages).toHaveLength(0); // transcript cleared
    expect(saved.at(-1)?.sessionId).toBe(fresh.sessionId); // persisted
  });

  test("name get/set round-trips and persists via /name usage", () => {
    const { store } = memStore();
    const session = new ChatSession(makeTestConfig(), { store });
    session.attach(fakeBuilt());
    session.name = "metrics-review";
    session.persist();
    expect(session.name).toBe("metrics-review");
  });

  test("resume with no argument lists saved sessions", () => {
    const { store } = memStore();
    const session = new ChatSession(makeTestConfig(), { store });
    session.attach(fakeBuilt());
    expect(session.resume("")).toContain("No saved sessions yet.");
  });
});
