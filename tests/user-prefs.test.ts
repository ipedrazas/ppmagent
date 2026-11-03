import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveShowToolCalls, UserPrefs } from "../src/session/user-prefs.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ppma-prefs-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("UserPrefs", () => {
  test("persists per user id and survives a restart", () => {
    const path = join(dir, "user-prefs.json");
    const a = new UserPrefs(path);
    a.setShowToolCalls(1, true);
    a.setShowToolCalls(2, false);

    const b = new UserPrefs(path); // "restart"
    expect(b.getShowToolCalls(1)).toBe(true);
    expect(b.getShowToolCalls(2)).toBe(false);
    expect(b.getShowToolCalls(3)).toBeUndefined();
  });

  test("clearing a choice persists too", () => {
    const path = join(dir, "user-prefs.json");
    const a = new UserPrefs(path);
    a.setShowToolCalls(1, true);
    a.setShowToolCalls(1, undefined);
    expect(new UserPrefs(path).getShowToolCalls(1)).toBeUndefined();
  });

  test("a corrupt file yields empty prefs rather than throwing", async () => {
    const path = join(dir, "user-prefs.json");
    await Bun.write(path, "{nope");
    expect(new UserPrefs(path).getShowToolCalls(1)).toBeUndefined();
  });
});

describe("resolveShowToolCalls precedence", () => {
  test("stored off beats env true", () => {
    const prefs = new UserPrefs();
    prefs.setShowToolCalls(1, false);
    expect(resolveShowToolCalls({ showToolCalls: true }, prefs, 1)).toEqual({
      value: false,
      source: "user",
    });
  });

  test("stored on beats env false", () => {
    const prefs = new UserPrefs();
    prefs.setShowToolCalls(1, true);
    expect(resolveShowToolCalls({ showToolCalls: false }, prefs, 1).value).toBe(true);
  });

  test("no stored preference follows the env default", () => {
    const prefs = new UserPrefs();
    expect(resolveShowToolCalls({ showToolCalls: true }, prefs, 1)).toEqual({
      value: true,
      source: "default",
    });
    expect(resolveShowToolCalls({ showToolCalls: false }, prefs, 1).value).toBe(false);
    expect(resolveShowToolCalls({ showToolCalls: true }, undefined, 1).value).toBe(true);
  });

  test("two users hold different values simultaneously", () => {
    const prefs = new UserPrefs();
    prefs.setShowToolCalls(1, true);
    prefs.setShowToolCalls(2, false);
    const cfg = { showToolCalls: false };
    expect(resolveShowToolCalls(cfg, prefs, 1).value).toBe(true);
    expect(resolveShowToolCalls(cfg, prefs, 2).value).toBe(false);
  });
});
