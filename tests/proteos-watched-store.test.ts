import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type WatchedTask, WatchedTasksStore } from "../src/proteos/watched-store.ts";

const TASK_A: WatchedTask = {
  machine: "m-1",
  taskId: "t-100",
  project: "myrepo",
  dispatchedAt: 1_000_000,
  label: "fix the bug",
};

const TASK_B: WatchedTask = {
  machine: "m-2",
  taskId: "t-200",
  project: "otherrepo",
  dispatchedAt: 2_000_000,
};

describe("WatchedTasksStore", () => {
  let dir: string;
  let storeFile: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "watched-store-test-"));
    storeFile = join(dir, ".session", "proteos-tasks.json");
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("list returns empty array when file does not exist", () => {
    const store = new WatchedTasksStore(storeFile);
    expect(store.list()).toEqual([]);
  });

  test("add persists a task and list returns it", () => {
    const store = new WatchedTasksStore(join(dir, "add.json"));
    store.add(TASK_A);
    expect(store.list()).toEqual([TASK_A]);
  });

  test("add is idempotent — duplicate taskId does not create a second entry", () => {
    const store = new WatchedTasksStore(join(dir, "idem.json"));
    store.add(TASK_A);
    store.add(TASK_A);
    expect(store.list()).toHaveLength(1);
  });

  test("add multiple distinct tasks", () => {
    const store = new WatchedTasksStore(join(dir, "multi.json"));
    store.add(TASK_A);
    store.add(TASK_B);
    const ids = store.list().map((t) => t.taskId);
    expect(ids).toContain(TASK_A.taskId);
    expect(ids).toContain(TASK_B.taskId);
  });

  test("remove deletes the task and leaves others intact", () => {
    const store = new WatchedTasksStore(join(dir, "remove.json"));
    store.add(TASK_A);
    store.add(TASK_B);
    store.remove(TASK_A.taskId);
    const remaining = store.list();
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.taskId).toBe(TASK_B.taskId);
  });

  test("remove on non-existent taskId is a no-op", () => {
    const store = new WatchedTasksStore(join(dir, "remove-noop.json"));
    store.add(TASK_A);
    store.remove("t-999");
    expect(store.list()).toHaveLength(1);
  });

  test("persists across separate store instances (file-backed)", () => {
    const store1 = new WatchedTasksStore(join(dir, "persist.json"));
    store1.add(TASK_A);
    const store2 = new WatchedTasksStore(join(dir, "persist.json"));
    expect(store2.list()).toEqual([TASK_A]);
  });

  test("list returns empty array on malformed JSON", async () => {
    const file = join(dir, "bad.json");
    await Bun.write(file, "not json{{{");
    const store = new WatchedTasksStore(file);
    expect(store.list()).toEqual([]);
  });
});
