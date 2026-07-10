import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

/**
 * A fake `dbxcli` binary returning canned JSON per subcommand, echoing the
 * argv it received into an `_argv` field so tests can tell whether
 * `tracker_search_tasks` invoked `get`/`list` (cheap) or `search` (full-text,
 * TAV-91) without needing a real DataboxPPM connection.
 */
const FAKE_DBXCLI = `#!/usr/bin/env bash
shift 2
cmd="$1"
argv="$*"
case "$cmd" in
  datasets)
    echo '{"datasets":[{"alias":"issues","data_kind":"issues"}]}'
    ;;
  action)
    echo '{"items":[]}'
    ;;
  list)
    echo '{"items":[{"id":"row-list","identifier":"LIST-1","url":"https://x/issue/LIST-1/s","_argv":"'"$argv"'"}]}'
    ;;
  get)
    ref="$3"
    echo '{"id":"row-get","identifier":"'"$ref"'","url":"https://x/issue/'"$ref"'/s","_argv":"'"$argv"'"}'
    ;;
  search)
    echo '{"items":[{"id":"row-search","identifier":"SEARCH-1","url":"https://x/issue/SEARCH-1/s","_argv":"'"$argv"'"}]}'
    ;;
esac
exit 0
`;

describe("tracker_search_tasks routing (TAV-91)", () => {
  let dir: string;
  let bin: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "dbxcli-test-"));
    bin = join(dir, "dbxcli");
    await writeFile(bin, FAKE_DBXCLI);
    await chmod(bin, 0o755);
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function searchTool() {
    const client = new DataboxClient({ bin, config: "" });
    const tool = buildTrackerTools(client).find((t) => t.name === "tracker_search_tasks");
    if (!tool) throw new Error("tracker_search_tasks not found");
    return tool;
  }

  test("routes a known task reference to `get`, not `search`", async () => {
    const result = await searchTool().execute("call-1", { query: "TAV-41" });
    const [row] = result.details as Array<{ id: string; _argv: string }>;
    expect(row?.id).toBe("row-get");
    expect(row?._argv).toContain("get");
    expect(row?._argv).not.toContain("search");
  });

  test("routes `status:<value>` to `list --filter status=<value>`, not `search`", async () => {
    const result = await searchTool().execute("call-1", { query: "status:Backlog" });
    const [row] = result.details as Array<{ id: string; _argv: string }>;
    expect(row?.id).toBe("row-list");
    expect(row?._argv).toContain("--filter");
    expect(row?._argv).toContain("status=Backlog");
  });

  test("routes a bare known workflow status word to `list`, not `search`", async () => {
    const result = await searchTool().execute("call-1", { query: "Backlog" });
    const [row] = result.details as Array<{ id: string; _argv: string }>;
    expect(row?.id).toBe("row-list");
    expect(row?._argv).toContain("status=Backlog");
  });

  test("falls back to `search` for a genuine free-text query", async () => {
    const result = await searchTool().execute("call-1", { query: "fix login bug" });
    const [row] = result.details as Array<{ id: string; _argv: string }>;
    expect(row?.id).toBe("row-search");
    expect(row?._argv).toContain("fix login bug");
  });
});
