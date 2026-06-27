import { describe, expect, test } from "bun:test";
import { PpmClient } from "../src/memory/ppm.ts";
import { buildMemoryTools } from "../src/memory/tools.ts";

const ppm = new PpmClient({ bin: "ppm", root: "./memory" });

describe("buildMemoryTools", () => {
  test("exposes the expected closed tool set", () => {
    const names = buildMemoryTools(ppm)
      .map((t) => t.name)
      .sort();
    expect(names).toEqual([
      "memory_create_project",
      "memory_list",
      "memory_read",
      "memory_search",
      "memory_write",
    ]);
  });

  test("every tool has a description, label, and parameters schema", () => {
    for (const tool of buildMemoryTools(ppm)) {
      expect(tool.description.length).toBeGreaterThan(0);
      expect(tool.label.length).toBeGreaterThan(0);
      expect(tool.parameters).toBeDefined();
    }
  });
});
