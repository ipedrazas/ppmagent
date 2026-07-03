import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SessionRetentionRunner } from "../src/session/retention.ts";
import { SessionIndex } from "../src/session/session-index.ts";
import { SessionStore, newSession } from "../src/session/store.ts";

const dir = mkdtempSync(join(import.meta.dir, ".retention-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function freshStore(label: string): SessionStore {
  return new SessionStore(join(dir, label, "session.json"));
}

function freshIndex(label: string): SessionIndex {
  return new SessionIndex(join(dir, label, "index.json"));
}

/**
 * Write a session file with a custom `updatedAt` directly, bypassing
 * `SessionStore.save()` which always stamps `updatedAt = Date.now()`.
 * Used to simulate sessions that are old enough to be expired by retention.
 */
function writeOldSession(label: string, sessionId: string, name: string, updatedAt: number): void {
  const sessionsDir = join(dir, label, "sessions");
  mkdirSync(sessionsDir, { recursive: true });
  const state = { sessionId, name, messages: [], createdAt: updatedAt, updatedAt };
  writeFileSync(join(sessionsDir, `${sessionId}.json`), JSON.stringify(state));
}

describe("SessionRetentionRunner — runOnce", () => {
  test("deletes sessions older than the retention window", () => {
    const label = "delete-old";
    const store = freshStore(label);
    // Write an old session directly (store.save would refresh updatedAt to now)
    const oldId = "00000000-0000-0000-0000-0000000000a1";
    writeOldSession(label, oldId, "old", Date.now() - 31 * 24 * 60 * 60 * 1000);
    const fresh = newSession("fresh");
    store.save(fresh);

    const runner = new SessionRetentionRunner({
      store,
      retentionDays: 30,
      currentSessionId: () => fresh.sessionId,
    });
    const deleted = runner.runOnce();

    expect(deleted).toBe(1);
    expect(store.find(oldId)).toBeNull();
    expect(store.find("fresh")).not.toBeNull();
  });

  test("never deletes the current session even if it is expired", () => {
    const store = freshStore("skip-current");
    const current = { ...newSession("current"), updatedAt: Date.now() - 60 * 24 * 60 * 60 * 1000 };
    store.save(current);

    const runner = new SessionRetentionRunner({
      store,
      retentionDays: 30,
      currentSessionId: () => current.sessionId,
    });
    const deleted = runner.runOnce();

    expect(deleted).toBe(0);
    expect(store.find("current")).not.toBeNull();
  });

  test("leaves recent sessions untouched", () => {
    const store = freshStore("keep-recent");
    const a = newSession("a");
    const b = newSession("b");
    store.save(a);
    store.save(b);

    const runner = new SessionRetentionRunner({
      store,
      retentionDays: 30,
      currentSessionId: () => b.sessionId,
    });
    const deleted = runner.runOnce();

    expect(deleted).toBe(0);
    expect(store.list()).toHaveLength(2);
  });

  test("returns 0 and does nothing when retentionDays is 0 (disabled)", () => {
    const store = freshStore("disabled");
    const s = { ...newSession("stale"), updatedAt: 0 };
    store.save(s);
    const other = newSession("other");
    store.save(other);

    const runner = new SessionRetentionRunner({
      store,
      retentionDays: 0,
      currentSessionId: () => other.sessionId,
    });
    const deleted = runner.runOnce();

    expect(deleted).toBe(0);
    expect(store.list()).toHaveLength(2);
  });

  test("removes deleted sessions from the index when an index is provided", () => {
    const label = "index-sync";
    const store = freshStore(label);
    const index = freshIndex(label);
    // Write an old session directly so it has an expired updatedAt
    const oldId = "00000000-0000-0000-0000-0000000000b1";
    writeOldSession(label, oldId, "to-delete", Date.now() - 40 * 24 * 60 * 60 * 1000);
    const current = newSession("current");
    store.save(current);
    index.rebuild(store);
    expect(index.size).toBe(2);

    const runner = new SessionRetentionRunner({
      store,
      retentionDays: 30,
      currentSessionId: () => current.sessionId,
      index,
    });
    runner.runOnce();

    expect(index.size).toBe(1);
    expect(index.search({ name: "to-delete" })).toHaveLength(0);
  });

  test("start() returns immediately when retention is disabled", async () => {
    const store = freshStore("disabled-start");
    const runner = new SessionRetentionRunner({
      store,
      retentionDays: 0,
      currentSessionId: () => "",
    });
    // Should resolve immediately, not loop forever
    await runner.start();
  });

  test("stop() terminates the background loop", async () => {
    const store = freshStore("stop-loop");
    const runner = new SessionRetentionRunner({
      store,
      retentionDays: 1,
      currentSessionId: () => "",
      intervalMs: 10_000, // long interval so the loop sleeps
    });
    const started = runner.start(); // starts sleeping
    runner.stop(); // should abort the sleep
    await started; // should resolve promptly
  });
});
