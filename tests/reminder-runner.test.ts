import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReminderRunner } from "../src/reminder/runner.ts";
import { ReminderStore } from "../src/reminder/store.ts";

describe("ReminderRunner", () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "reminder-runner-test-"));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("fires a due reminder and removes it from the store", async () => {
    const storeFile = join(dir, "due.json");
    const store = new ReminderStore(storeFile);
    store.add({ message: "wake up", dueAt: Date.now() - 1_000 });

    const notifications: string[] = [];
    const runner = new ReminderRunner({
      store,
      notify: async (msg) => {
        notifications.push(msg);
      },
      intervalMs: 60_000, // long — we drive polls manually
    });

    await runner.pollOnce();

    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toContain("wake up");
    expect(notifications[0]).toContain("⏰");
    expect(store.list()).toHaveLength(0);
  });

  test("does not fire a reminder that is not yet due", async () => {
    const storeFile = join(dir, "not-due.json");
    const store = new ReminderStore(storeFile);
    store.add({ message: "future thing", dueAt: Date.now() + 3_600_000 });

    const notifications: string[] = [];
    const runner = new ReminderRunner({
      store,
      notify: async (msg) => {
        notifications.push(msg);
      },
      intervalMs: 60_000,
    });

    await runner.pollOnce();

    expect(notifications).toHaveLength(0);
    expect(store.list()).toHaveLength(1);
  });

  test("start() fires reminders overdue from before a restart, on entry", async () => {
    const storeFile = join(dir, "overdue-on-start.json");
    const store = new ReminderStore(storeFile);
    store.add({ message: "missed while down", dueAt: Date.now() - 60_000 });

    const notifications: string[] = [];
    const runner = new ReminderRunner({
      store,
      notify: async (msg) => {
        notifications.push(msg);
      },
      intervalMs: 60_000, // long — the overdue reminder must fire on the immediate poll, not the sleep
    });

    const done = runner.start();
    // Give the immediate poll a moment to run before stopping.
    await new Promise((r) => setTimeout(r, 20));
    runner.stop();
    await done;

    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toContain("missed while down");
  });

  test("stop() resolves start() promptly even during a long sleep interval", async () => {
    const storeFile = join(dir, "stop.json");
    const store = new ReminderStore(storeFile);

    const runner = new ReminderRunner({
      store,
      notify: async () => {},
      intervalMs: 60_000,
    });

    const startedAt = Date.now();
    const done = runner.start();
    await new Promise((r) => setTimeout(r, 50));
    runner.stop();
    await done;

    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });

  test("notification error does not crash the runner and the reminder is not retried", async () => {
    const storeFile = join(dir, "notify-err.json");
    const store = new ReminderStore(storeFile);
    store.add({ message: "will fail to send", dueAt: Date.now() - 1_000 });

    let callCount = 0;
    const runner = new ReminderRunner({
      store,
      notify: async () => {
        callCount++;
        throw new Error("Telegram down");
      },
      intervalMs: 60_000,
    });

    await runner.pollOnce();

    expect(callCount).toBe(1);
    // Reminder is popped from the store regardless of notify failure (matches
    // the ProteosTaskWatcher precedent — we don't retry a failed send).
    expect(store.list()).toHaveLength(0);
  });

  test("a store failure during poll does not crash the runner (retries next round)", async () => {
    const storeFile = join(dir, "store-err.json");
    class ThrowingStore extends ReminderStore {
      override takeDue(): never {
        throw new Error("ENOSPC: disk full");
      }
    }
    const store = new ThrowingStore(storeFile);

    const notifications: string[] = [];
    const runner = new ReminderRunner({
      store,
      notify: async (msg) => {
        notifications.push(msg);
      },
      intervalMs: 60_000,
    });

    // Must not throw — a transient store error must not propagate out of
    // poll() and reject start()'s promise (which, awaited alongside the
    // Telegram bot in main()'s Promise.all, would crash the whole process).
    await expect(runner.pollOnce()).resolves.toBeUndefined();
    expect(notifications).toHaveLength(0);
  });

  test("multiple due reminders all fire in one poll round", async () => {
    const storeFile = join(dir, "multi.json");
    const store = new ReminderStore(storeFile);
    store.add({ message: "first", dueAt: Date.now() - 2_000 });
    store.add({ message: "second", dueAt: Date.now() - 1_000 });

    const notifications: string[] = [];
    const runner = new ReminderRunner({
      store,
      notify: async (msg) => {
        notifications.push(msg);
      },
      intervalMs: 60_000,
    });

    await runner.pollOnce();

    expect(notifications).toHaveLength(2);
    expect(store.list()).toHaveLength(0);
  });

  test("defaults to a 30 second poll interval", () => {
    const store = new ReminderStore(join(dir, "default-interval.json"));
    const runner = new ReminderRunner({ store, notify: async () => {} });
    // @ts-expect-error accessing a private field to assert the wiring default
    expect(runner.intervalMs).toBe(30_000);
  });
});
