import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SessionStore, newSession } from "../src/session/store.ts";

const dir = mkdtempSync(join(import.meta.dir, ".sessroot-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("SessionStore", () => {
  test("returns null before anything is saved", () => {
    expect(new SessionStore(join(dir, "missing.json")).load()).toBeNull();
  });

  test("round-trips a session through disk", () => {
    const store = new SessionStore(join(dir, "nested", "session.json"));
    const state = {
      sessionId: "sid-1",
      activeProject: "onboarding",
      messages: [{ role: "user" as const, content: "hi", timestamp: 1 }],
    };
    store.save(state);
    expect(store.load()).toEqual(state);
  });

  test("treats malformed JSON as no session", () => {
    const path = join(dir, "bad.json");
    writeFileSync(path, "{not json");
    expect(new SessionStore(path).load()).toBeNull();
  });
});

describe("newSession", () => {
  test("produces a fresh id and empty transcript", () => {
    const a = newSession();
    expect(a.sessionId.length).toBeGreaterThan(0);
    expect(a.messages).toEqual([]);
    expect(a.activeProject).toBeUndefined();
  });
});
