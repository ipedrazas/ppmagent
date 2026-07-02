import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProteosClient } from "../src/proteos/proteos.ts";
import { WatchedTasksStore } from "../src/proteos/watched-store.ts";
import { ProteosTaskWatcher, extractTaskId, parseTaskStatus } from "../src/proteos/watcher.ts";

describe("extractTaskId", () => {
  test("extracts a numeric task id", () => {
    expect(extractTaskId("task t-123 dispatched")).toBe("t-123");
  });

  test("extracts an alphanumeric task id", () => {
    expect(extractTaskId("dispatched t-abc12 on machine")).toBe("t-abc12");
  });

  test("returns the first match when multiple ids are present", () => {
    expect(extractTaskId("t-1 queued (was t-2)")).toBe("t-1");
  });

  test("returns undefined when no task id is found", () => {
    expect(extractTaskId("error: machine not found")).toBeUndefined();
  });

  test("does not match a machine id (m-123)", () => {
    expect(extractTaskId("machine m-123")).toBeUndefined();
  });

  test("handles plain id on its own line", () => {
    expect(extractTaskId("t-456")).toBe("t-456");
  });
});

describe("parseTaskStatus", () => {
  test("detects 'status: completed'", () => {
    expect(parseTaskStatus("status: completed")).toBe("completed");
  });

  test("detects 'status: running'", () => {
    expect(parseTaskStatus("status: running")).toBe("running");
  });

  test("detects 'status: failed' (exit 5 output)", () => {
    expect(parseTaskStatus("status: failed\nerror: timeout")).toBe("failed");
  });

  test("detects 'status: canceled'", () => {
    expect(parseTaskStatus("status: canceled")).toBe("canceled");
  });

  test("detects 'status: cancelled' (British spelling)", () => {
    expect(parseTaskStatus("status: cancelled")).toBe("canceled");
  });

  test("detects 'status: pending'", () => {
    expect(parseTaskStatus("status: pending")).toBe("running");
  });

  test("is case-insensitive", () => {
    expect(parseTaskStatus("STATUS: Completed")).toBe("completed");
  });

  test("falls back to keyword scan when no status field", () => {
    expect(parseTaskStatus("task completed successfully")).toBe("completed");
  });

  test("returns unknown when no signal is present", () => {
    expect(parseTaskStatus("task t-1 on machine m-2")).toBe("unknown");
  });

  test("treats unknown as non-terminal (conservative)", () => {
    expect(parseTaskStatus("some unexpected output")).toBe("unknown");
  });
});

/**
 * Fake `proteos` binary used to exercise watcher polling. It responds to
 * `task get` based on the task id suffix:
 *   t-done    → "status: completed\nsession: s-abc"  (exit 0)
 *   t-failed  → "status: failed\nerror: timeout"     (exit 5)
 *   t-running → "status: running"                    (exit 0)
 *   anything else → exits 1 (simulates a CLI error)
 */
const FAKE_PROTEOS = `#!/usr/bin/env bash
if [ "$1" = "task" ] && [ "$2" = "get" ]; then
  for TASK_ID in "$@"; do :; done
  if [ "$TASK_ID" = "t-done" ]; then
    printf 'status: completed\\nsession: s-abc\\n'
    exit 0
  fi
  if [ "$TASK_ID" = "t-failed" ]; then
    printf 'status: failed\\nerror: timeout\\n'
    exit 5
  fi
  if [ "$TASK_ID" = "t-running" ]; then
    printf 'status: running\\n'
    exit 0
  fi
fi
exit 1
`;

describe("ProteosTaskWatcher", () => {
  let dir: string;
  let bin: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "watcher-test-"));
    bin = join(dir, "proteos");
    await writeFile(bin, FAKE_PROTEOS);
    await chmod(bin, 0o755);
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("notifies and removes a completed task", async () => {
    const storeFile = join(dir, "done.json");
    const proteos = new ProteosClient({ bin });
    const notifications: string[] = [];
    const watcher = new ProteosTaskWatcher({
      proteos,
      notify: async (msg) => {
        notifications.push(msg);
      },
      storeFile,
      intervalMs: 60_000, // long — we drive polls manually
    });

    watcher.watch("m-1", "t-done", "myrepo", "fix the bug");
    const store = new WatchedTasksStore(storeFile);
    expect(store.list()).toHaveLength(1);

    // Drive a single poll deterministically — no timer race against the loop.
    await watcher.pollOnce();

    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toContain("t-done");
    expect(notifications[0]).toContain("completed");
    expect(notifications[0]).toContain("myrepo");
    // Task must be removed from the store after notification.
    expect(store.list()).toHaveLength(0);
  });

  test("notifies and removes a failed task (exit 5 output)", async () => {
    const storeFile = join(dir, "failed.json");
    const proteos = new ProteosClient({ bin });
    const notifications: string[] = [];
    const watcher = new ProteosTaskWatcher({
      proteos,
      notify: async (msg) => {
        notifications.push(msg);
      },
      storeFile,
      intervalMs: 60_000,
    });

    watcher.watch("m-1", "t-failed", "myrepo", "run tests");
    await watcher.pollOnce();

    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toContain("t-failed");
    expect(notifications[0]).toContain("failed");
    const store = new WatchedTasksStore(storeFile);
    expect(store.list()).toHaveLength(0);
  });

  test("does not notify for a running task and leaves it in the store", async () => {
    const storeFile = join(dir, "running.json");
    const proteos = new ProteosClient({ bin });
    const notifications: string[] = [];
    const watcher = new ProteosTaskWatcher({
      proteos,
      notify: async (msg) => {
        notifications.push(msg);
      },
      storeFile,
      intervalMs: 60_000,
    });

    watcher.watch("m-1", "t-running", "myrepo", "write feature");
    await watcher.pollOnce();

    expect(notifications).toHaveLength(0);
    const store = new WatchedTasksStore(storeFile);
    expect(store.list()).toHaveLength(1);
  });

  test("watch() is idempotent — duplicate call does not double-register", () => {
    const storeFile = join(dir, "idem.json");
    const proteos = new ProteosClient({ bin });
    const watcher = new ProteosTaskWatcher({
      proteos,
      notify: async () => {},
      storeFile,
      intervalMs: 60_000,
    });

    watcher.watch("m-1", "t-running", "myrepo", "first");
    watcher.watch("m-1", "t-running", "myrepo", "duplicate");
    const store = new WatchedTasksStore(storeFile);
    expect(store.list()).toHaveLength(1);
  });

  test("stop() resolves start() promptly even during a long sleep interval", async () => {
    const storeFile = join(dir, "stop.json");
    const proteos = new ProteosClient({ bin });
    const watcher = new ProteosTaskWatcher({
      proteos,
      notify: async () => {},
      storeFile,
      intervalMs: 60_000,
    });

    const startedAt = Date.now();
    const done = watcher.start();
    // Let the immediate poll finish, then stop during the long sleep.
    await new Promise((r) => setTimeout(r, 50));
    watcher.stop();
    await done;
    // Should resolve well within 1 second, not 60.
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });

  test("notification error does not crash the watcher and task is removed", async () => {
    const storeFile = join(dir, "notify-err.json");
    const proteos = new ProteosClient({ bin });
    let callCount = 0;
    const watcher = new ProteosTaskWatcher({
      proteos,
      notify: async () => {
        callCount++;
        throw new Error("Telegram down");
      },
      storeFile,
      intervalMs: 60_000,
    });

    watcher.watch("m-1", "t-done", "myrepo", "prompt");
    await watcher.pollOnce();

    // Notification was attempted
    expect(callCount).toBe(1);
    // Task was still removed from the store (we don't retry on notify failure)
    const store = new WatchedTasksStore(storeFile);
    expect(store.list()).toHaveLength(0);
  });
});
