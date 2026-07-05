import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { SessionIndex } from "../src/session/session-index.ts";
import { newSession, SessionStore } from "../src/session/store.ts";

const dir = mkdtempSync(join(import.meta.dir, ".idx-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function freshStore(label: string): SessionStore {
  return new SessionStore(join(dir, label, "session.json"));
}

function freshIndex(label: string): SessionIndex {
  return new SessionIndex(join(dir, label, "index.json"));
}

describe("SessionIndex — rebuild", () => {
  test("populates entries from the store", () => {
    const store = freshStore("rebuild");
    store.save({ ...newSession("alpha"), activeProject: "proj-a" });
    store.save(newSession("beta"));

    const idx = freshIndex("rebuild");
    idx.rebuild(store);

    expect(idx.size).toBe(2);
    expect(idx.list().map((e) => e.name)).toContain("alpha");
    expect(idx.list().map((e) => e.name)).toContain("beta");
  });

  test("seeds the projects array from activeProject", () => {
    const store = freshStore("rebuild-projects");
    store.save({ ...newSession("w/ project"), activeProject: "infra" });

    const idx = freshIndex("rebuild-projects");
    idx.rebuild(store);

    const entry = idx.list()[0];
    expect(entry?.projects).toContain("infra");
  });
});

describe("SessionIndex — upsert", () => {
  test("adds a new session entry", () => {
    const idx = freshIndex("upsert-new");
    const s = newSession("new-session");
    idx.upsert(s);
    expect(idx.size).toBe(1);
    expect(idx.list()[0]?.name).toBe("new-session");
  });

  test("updates an existing entry", () => {
    const idx = freshIndex("upsert-update");
    const s = newSession("mutable");
    idx.upsert(s);
    s.name = "renamed";
    idx.upsert(s);
    expect(idx.size).toBe(1);
    expect(idx.list()[0]?.name).toBe("renamed");
  });

  test("accumulates multiple projects across upserts", () => {
    const idx = freshIndex("upsert-projects");
    const s = newSession("multi-proj");
    s.activeProject = "proj-a";
    idx.upsert(s);
    s.activeProject = "proj-b";
    idx.upsert(s);
    const entry = idx.search({ project: "proj-a" })[0];
    expect(entry?.projects).toContain("proj-a");
    expect(entry?.projects).toContain("proj-b");
  });

  test("persists entries to disk and loads them on next construction", () => {
    const path = join(dir, "persist-idx", "index.json");
    const idx1 = new SessionIndex(path);
    idx1.upsert(newSession("persisted"));

    const idx2 = new SessionIndex(path);
    expect(idx2.size).toBe(1);
    expect(idx2.list()[0]?.name).toBe("persisted");
  });
});

describe("SessionIndex — remove", () => {
  test("removes an entry by sessionId", () => {
    const idx = freshIndex("remove");
    const s = newSession("to-remove");
    idx.upsert(s);
    idx.remove(s.sessionId);
    expect(idx.size).toBe(0);
  });

  test("is a no-op for an unknown sessionId", () => {
    const idx = freshIndex("remove-noop");
    idx.upsert(newSession("keep"));
    idx.remove("nonexistent-id");
    expect(idx.size).toBe(1);
  });
});

describe("SessionIndex — search", () => {
  test("returns all entries when query is empty", () => {
    const store = freshStore("search-all");
    store.save(newSession("a"));
    store.save(newSession("b"));
    const idx = freshIndex("search-all");
    idx.rebuild(store);
    expect(idx.list()).toHaveLength(2);
  });

  test("filters by name substring (case-insensitive)", () => {
    const idx = freshIndex("search-name");
    idx.upsert(newSession("Sprint Planning"));
    idx.upsert(newSession("Backlog Review"));
    const results = idx.search({ name: "sprint" });
    expect(results).toHaveLength(1);
    expect(results[0]?.name).toBe("Sprint Planning");
  });

  test("filters by project slug (exact match)", () => {
    const idx = freshIndex("search-project");
    const s1 = newSession("with-proj");
    s1.activeProject = "infra";
    idx.upsert(s1);
    const s2 = newSession("other");
    s2.activeProject = "frontend";
    idx.upsert(s2);

    const results = idx.search({ project: "infra" });
    expect(results).toHaveLength(1);
    expect(results[0]?.name).toBe("with-proj");
  });

  test("filters by after timestamp", () => {
    const now = Date.now();
    const idx = freshIndex("search-after");
    const old = { ...newSession("old"), updatedAt: now - 10_000 };
    const recent = { ...newSession("recent"), updatedAt: now };
    idx.upsert(old);
    idx.upsert(recent);

    const results = idx.search({ after: now - 5_000 });
    expect(results).toHaveLength(1);
    expect(results[0]?.name).toBe("recent");
  });

  test("filters by before timestamp", () => {
    const now = Date.now();
    const idx = freshIndex("search-before");
    const old = { ...newSession("old"), updatedAt: now - 10_000 };
    const recent = { ...newSession("recent"), updatedAt: now };
    idx.upsert(old);
    idx.upsert(recent);

    const results = idx.search({ before: now - 5_000 });
    expect(results).toHaveLength(1);
    expect(results[0]?.name).toBe("old");
  });

  test("filters by minMessages", () => {
    const idx = freshIndex("search-msgs");
    idx.upsert({ ...newSession("empty"), messages: [] });
    const withMsgs = newSession("has-messages");
    // Fake a non-empty transcript by setting messageCount indirectly via upsert
    idx.upsert({ ...withMsgs, messages: [{ role: "user", content: "hi" }] as never[] });

    const results = idx.search({ minMessages: 1 });
    expect(results).toHaveLength(1);
    expect(results[0]?.name).toBe("has-messages");
  });

  test("returns entries newest-first", async () => {
    const idx = freshIndex("search-order");
    const a = { ...newSession("a"), updatedAt: Date.now() - 1000 };
    await Bun.sleep(2);
    const b = { ...newSession("b"), updatedAt: Date.now() };
    idx.upsert(a);
    idx.upsert(b);
    const list = idx.list();
    expect(list[0]?.name).toBe("b");
    expect(list[1]?.name).toBe("a");
  });
});
