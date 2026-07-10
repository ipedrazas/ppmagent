import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReminderStore } from "../src/reminder/store.ts";

describe("ReminderStore", () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "reminder-store-test-"));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("list() is empty when no file exists yet", () => {
    const store = new ReminderStore(join(dir, "missing.json"));
    expect(store.list()).toHaveLength(0);
  });

  test("add() persists a reminder and assigns an id", () => {
    const store = new ReminderStore(join(dir, "add.json"));
    const reminder = store.add({ message: "buy milk", dueAt: 12345 });
    expect(reminder.id).toBeTruthy();
    expect(reminder.message).toBe("buy milk");
    expect(reminder.dueAt).toBe(12345);
    expect(store.list()).toHaveLength(1);
  });

  test("list() sorts pending reminders by due time, soonest first", () => {
    const store = new ReminderStore(join(dir, "sort.json"));
    store.add({ message: "later", dueAt: 3000 });
    store.add({ message: "soonest", dueAt: 1000 });
    store.add({ message: "middle", dueAt: 2000 });
    const list = store.list();
    expect(list.map((r) => r.message)).toEqual(["soonest", "middle", "later"]);
  });

  test("remove() deletes a reminder by id and returns true", () => {
    const store = new ReminderStore(join(dir, "remove.json"));
    const reminder = store.add({ message: "cancel me", dueAt: 1000 });
    expect(store.remove(reminder.id)).toBe(true);
    expect(store.list()).toHaveLength(0);
  });

  test("remove() returns false for an unknown id", () => {
    const store = new ReminderStore(join(dir, "remove-missing.json"));
    expect(store.remove("does-not-exist")).toBe(false);
  });

  test("takeDue() pops only reminders due at or before `now`", () => {
    const store = new ReminderStore(join(dir, "take-due.json"));
    store.add({ message: "due", dueAt: 1000 });
    store.add({ message: "not due yet", dueAt: 5000 });

    const due = store.takeDue(1000);
    expect(due.map((r) => r.message)).toEqual(["due"]);

    // The due reminder is removed from the store; the future one remains.
    const remaining = store.list();
    expect(remaining.map((r) => r.message)).toEqual(["not due yet"]);
  });

  test("takeDue() does not re-fire a reminder on a later poll", () => {
    const store = new ReminderStore(join(dir, "no-refire.json"));
    store.add({ message: "once only", dueAt: 1000 });

    expect(store.takeDue(1000)).toHaveLength(1);
    expect(store.takeDue(2000)).toHaveLength(0);
  });

  test("survives a process restart by reading the persisted file", () => {
    const file = join(dir, "restart.json");
    const first = new ReminderStore(file);
    first.add({ message: "restart me", dueAt: 1000 });

    const second = new ReminderStore(file);
    expect(second.list().map((r) => r.message)).toEqual(["restart me"]);
  });

  test("read() tolerates a corrupt file by treating it as empty", async () => {
    const file = join(dir, "corrupt.json");
    await writeFile(file, "{not valid json");
    const store = new ReminderStore(file);
    expect(store.list()).toHaveLength(0);
  });
});
