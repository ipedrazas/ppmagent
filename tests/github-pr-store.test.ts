import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PRNotificationStore, type SeenPR } from "../src/github/pr-store.ts";

const PR_A: SeenPR = {
  url: "https://github.com/acme/repo/pull/1",
  repo: "acme/repo",
  seenAt: 1_000_000,
};

const PR_B: SeenPR = {
  url: "https://github.com/acme/repo/pull/2",
  repo: "acme/repo",
  seenAt: 2_000_000,
};

describe("PRNotificationStore", () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "pr-store-test-"));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("hasSeen returns false when file does not exist", () => {
    const store = new PRNotificationStore(join(dir, "empty.json"));
    expect(store.hasSeen(PR_A.url)).toBe(false);
  });

  test("markSeen persists a PR and hasSeen returns true", () => {
    const store = new PRNotificationStore(join(dir, "basic.json"));
    store.markSeen(PR_A);
    expect(store.hasSeen(PR_A.url)).toBe(true);
  });

  test("hasSeen returns false for an unseen URL even after marking another", () => {
    const store = new PRNotificationStore(join(dir, "other.json"));
    store.markSeen(PR_A);
    expect(store.hasSeen(PR_B.url)).toBe(false);
  });

  test("markSeen is idempotent — duplicate url does not create a second entry", async () => {
    const file = join(dir, "idem.json");
    const store = new PRNotificationStore(file);
    store.markSeen(PR_A);
    store.markSeen(PR_A);
    const raw = JSON.parse(await Bun.file(file).text()) as { prs: SeenPR[] };
    expect(raw.prs).toHaveLength(1);
  });

  test("persists across separate store instances (file-backed)", () => {
    const file = join(dir, "persist.json");
    new PRNotificationStore(file).markSeen(PR_A);
    expect(new PRNotificationStore(file).hasSeen(PR_A.url)).toBe(true);
  });

  test("hasSeen returns false on malformed JSON", async () => {
    const file = join(dir, "bad.json");
    await Bun.write(file, "not-json{{{");
    expect(new PRNotificationStore(file).hasSeen(PR_A.url)).toBe(false);
  });

  test("creates parent directories if they do not exist", () => {
    const store = new PRNotificationStore(join(dir, "nested", "deep", "prs.json"));
    store.markSeen(PR_A);
    expect(store.hasSeen(PR_A.url)).toBe(true);
  });
});
