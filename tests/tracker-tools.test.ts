import { describe, expect, test } from "bun:test";
import { DataboxClient } from "../src/tracker/databox.ts";
import { buildTrackerTools } from "../src/tracker/tools.ts";

const databox = new DataboxClient({
  bin: "dbxcli",
  config: "",
  dataset: "issues",
  createAction: "create_issue_linear",
});

describe("buildTrackerTools", () => {
  test("exposes the expected neutral tool set", () => {
    const names = buildTrackerTools(databox)
      .map((t) => t.name)
      .sort();
    expect(names).toEqual([
      "tracker_create_task",
      "tracker_get_task",
      "tracker_list_tasks",
      "tracker_search_tasks",
    ]);
  });

  test("tools keep tracker vocabulary neutral (no linear/jira in names)", () => {
    for (const tool of buildTrackerTools(databox)) {
      expect(tool.name).not.toMatch(/linear|jira/i);
      expect(tool.description.length).toBeGreaterThan(0);
      expect(tool.label.length).toBeGreaterThan(0);
    }
  });
});
