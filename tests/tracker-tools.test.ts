import { describe, expect, test } from "bun:test";
import { DataboxClient } from "../src/tracker/databox.ts";
import { buildTrackerTools } from "../src/tracker/tools.ts";

const databox = new DataboxClient({ bin: "dbxcli", config: "" });

describe("buildTrackerTools", () => {
  test("exposes the expected neutral tool set", () => {
    const names = buildTrackerTools(databox)
      .map((t) => t.name)
      .sort();
    expect(names).toEqual([
      "tracker_create_project",
      "tracker_create_task",
      "tracker_get_project",
      "tracker_get_task",
      "tracker_get_team",
      "tracker_list_projects",
      "tracker_list_tasks",
      "tracker_list_teams",
      "tracker_search_tasks",
      "tracker_update_project",
      "tracker_update_task",
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
