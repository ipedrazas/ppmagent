import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { newSession, SessionStore, shortId } from "../src/session/store.ts";

const dir = mkdtempSync(join(import.meta.dir, ".sessroot-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** A fresh store rooted in its own temp subdir so tests don't cross-pollute. */
function freshStore(label: string): SessionStore {
  return new SessionStore(join(dir, label, "session.json"));
}

describe("SessionStore", () => {
  test("returns null before anything is saved", () => {
    expect(freshStore("empty").load()).toBeNull();
  });

  test("round-trips the current session through disk", () => {
    const store = freshStore("roundtrip");
    const state = { ...newSession("kickoff"), activeProject: "onboarding" };
    store.save(state);
    const loaded = store.load();
    expect(loaded?.sessionId).toBe(state.sessionId);
    expect(loaded?.name).toBe("kickoff");
    expect(loaded?.activeProject).toBe("onboarding");
  });

  test("keeps multiple sessions and lists them newest-first", async () => {
    const store = freshStore("multi");
    const a = newSession("alpha");
    const b = newSession("beta");
    store.save(a); // a saved first → older updatedAt
    await Bun.sleep(2); // guarantee a distinct updatedAt so ordering is deterministic
    store.save(b); // b is now current
    const list = store.list();
    expect(list.map((s) => s.name)).toEqual(["beta", "alpha"]);
    // The most recent save is the current session.
    expect(store.load()?.sessionId).toBe(b.sessionId);
  });

  test("resolves a session by short handle and by name", () => {
    const store = freshStore("find");
    const s = newSession("metrics-review");
    store.save(s);
    store.save(newSession("other")); // move current away from s
    expect(store.find(shortId(s.sessionId))?.sessionId).toBe(s.sessionId);
    expect(store.find("metrics-review")?.sessionId).toBe(s.sessionId);
    expect(store.find("nope")).toBeNull();
  });

  test("migrates a legacy single-file session on first load", () => {
    mkdirSync(join(dir, "legacy"), { recursive: true });
    // Pre-multi-session shape: no createdAt/updatedAt, no sessions/ dir.
    const legacy = { sessionId: "legacy-1", activeProject: "onboarding", messages: [] };
    writeFileSync(join(dir, "legacy", "session.json"), JSON.stringify(legacy));
    const store = freshStore("legacy");
    const loaded = store.load();
    expect(loaded?.sessionId).toBe("legacy-1");
    expect(loaded?.activeProject).toBe("onboarding");
    // It is now a first-class session in the store.
    expect(store.list().map((s) => s.sessionId)).toContain("legacy-1");
  });

  test("treats malformed JSON as no session", () => {
    const store = freshStore("bad");
    store.save(newSession()); // create the sessions/ dir + pointer
    writeFileSync(join(dir, "bad", "current"), "does-not-exist");
    expect(store.load()).toBeNull();
  });
});

describe("SessionStore — offset persistence", () => {
  test("loadOffset returns 0 when no offset file exists", () => {
    expect(freshStore("offset-empty").loadOffset()).toBe(0);
  });

  test("saveOffset persists and loadOffset restores", () => {
    const store = freshStore("offset-roundtrip");
    store.saveOffset(42);
    expect(store.loadOffset()).toBe(42);
  });

  test("saveOffset overwrites the previous value", () => {
    const store = freshStore("offset-overwrite");
    store.saveOffset(10);
    store.saveOffset(99);
    expect(store.loadOffset()).toBe(99);
  });
});

describe("SessionStore — atomic writes", () => {
  test("save leaves no .tmp files behind", () => {
    const label = "atomic-save";
    const store = freshStore(label);
    store.save(newSession("check-atomic"));
    const storeDir = join(dir, label);
    const allFiles = readdirSync(storeDir, { recursive: true }) as string[];
    const tmpFiles = allFiles.filter((f) => String(f).endsWith(".tmp"));
    expect(tmpFiles).toEqual([]);
  });

  test("saveOffset leaves no .tmp files behind", () => {
    const label = "atomic-offset";
    const store = freshStore(label);
    store.saveOffset(7);
    const allFiles = readdirSync(join(dir, label)) as string[];
    const tmpFiles = allFiles.filter((f) => String(f).endsWith(".tmp"));
    expect(tmpFiles).toEqual([]);
  });

  test("saved session file is valid JSON after save", () => {
    const store = freshStore("atomic-json");
    const s = newSession("valid-json");
    store.save(s);
    const loaded = store.load();
    expect(loaded?.sessionId).toBe(s.sessionId);
    expect(loaded?.name).toBe("valid-json");
  });

  test("current pointer file is present and readable after save", () => {
    const label = "atomic-pointer";
    const store = freshStore(label);
    const s = newSession("ptr-test");
    store.save(s);
    const pointerPath = join(dir, label, "current");
    expect(existsSync(pointerPath)).toBe(true);
    expect(store.load()?.sessionId).toBe(s.sessionId);
  });
});

describe("SessionStore — sanitize hook", () => {
  test("applies the sanitize function before writing to disk without mutating in-memory state", () => {
    const store = new SessionStore(join(dir, "sanitize", "session.json"), (v) => {
      if (typeof v === "object" && v !== null && "name" in v) {
        return { ...(v as Record<string, unknown>), name: "[REDACTED]" };
      }
      return v;
    });
    const s = newSession("real-name");
    store.save(s);
    expect(s.name).toBe("real-name"); // in-memory state unchanged
    expect(store.load()?.name).toBe("[REDACTED]"); // on-disk value is sanitized
  });
});

describe("newSession", () => {
  test("produces a fresh id, empty transcript, and timestamps", () => {
    const a = newSession();
    expect(a.sessionId.length).toBeGreaterThan(0);
    expect(a.messages).toEqual([]);
    expect(a.activeProject).toBeUndefined();
    expect(a.createdAt).toBeGreaterThan(0);
    expect(a.updatedAt).toBeGreaterThan(0);
  });

  test("accepts an optional name", () => {
    expect(newSession("planning").name).toBe("planning");
  });
});
