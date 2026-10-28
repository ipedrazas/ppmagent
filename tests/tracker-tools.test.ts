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

/**
 * Fake `dbxcli` for project lookups: a projects dataset where `search` knows
 * "Casa" and `list` knows "PPMAgent", so tests can tell which path resolved a
 * name lookup (server-side search vs the client-side list-scan fallback).
 */
const FAKE_DBXCLI_PROJECTS = `#!/usr/bin/env bash
shift 2
cmd="$1"
argv="$*"
case "$cmd" in
  datasets)
    echo '{"datasets":[{"alias":"projects","data_kind":"projects"}]}'
    ;;
  action)
    echo '{"items":[]}'
    ;;
  search)
    echo '{"items":[{"id":"proj-search","name":"Casa","_argv":"'"$argv"'"}]}'
    ;;
  list)
    echo '{"items":[{"id":"proj-list","name":"PPMAgent","_argv":"'"$argv"'"}]}'
    ;;
  get)
    echo '{"id":"proj-get","name":"ByUuid","_argv":"'"$argv"'"}'
    ;;
esac
exit 0
`;

describe("tracker_get_project name resolution", () => {
  let dir: string;
  let bin: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "dbxcli-proj-test-"));
    bin = join(dir, "dbxcli");
    await writeFile(bin, FAKE_DBXCLI_PROJECTS);
    await chmod(bin, 0o755);
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function getProjectTool() {
    const client = new DataboxClient({ bin, config: "" });
    const tool = buildTrackerTools(client).find((t) => t.name === "tracker_get_project");
    if (!tool) throw new Error("tracker_get_project not found");
    return tool;
  }

  test("resolves a name via server-side `search` (case-insensitive)", async () => {
    const result = await getProjectTool().execute("call-1", { ref: "casa" });
    const row = result.details as { id: string; _argv: string };
    expect(row.id).toBe("proj-search");
    expect(row._argv).toContain("search");
  });

  test("falls back to the list scan when search has no exact-name match", async () => {
    const result = await getProjectTool().execute("call-1", { ref: "PPMAgent" });
    const row = result.details as { id: string; _argv: string };
    expect(row.id).toBe("proj-list");
  });

  test("fetches by UUID via `get` without any name scan", async () => {
    const uuid = "25afba6f-32b0-45c5-868b-67db252f4950";
    const result = await getProjectTool().execute("call-1", { ref: uuid });
    const row = result.details as { id: string; _argv: string };
    expect(row.id).toBe("proj-get");
    expect(row._argv).toContain(uuid);
  });

  test("throws a clear error when neither search nor list matches", async () => {
    const err = await getProjectTool()
      .execute("call-1", { ref: "NoSuchProject" })
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(String(err)).toMatch(/no project found/i);
  });
});

/**
 * Fake `dbxcli` that exposes an `update_issue` action and records the argv of
 * every `action invoke` into `$DBX_LOG`, so tests can assert exactly what would
 * reach the Linear mutation.
 */
const FAKE_DBXCLI_UPDATE = `#!/usr/bin/env bash
shift 2
cmd="$1"
case "$cmd" in
  datasets)
    echo '{"datasets":[{"alias":"issues","data_kind":"issues"}]}'
    ;;
  action)
    if [ "$2" = "invoke" ]; then
      echo "$@" >> "$DBX_LOG"
      echo '{"result":{"identifier":"TAV-229","issue_id":"i1","url":"https://x/issue/TAV-229/s"}}'
    else
      echo '{"items":[{"alias":"upd","action_type":"update_issue"}]}'
    fi
    ;;
esac
exit 0
`;

describe("tracker_update_task status (TAV-229)", () => {
  let dir: string;
  let bin: string;
  let log: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "dbxcli-upd-test-"));
    bin = join(dir, "dbxcli");
    log = join(dir, "invoke.log");
    await writeFile(bin, FAKE_DBXCLI_UPDATE);
    await chmod(bin, 0o755);
    process.env.DBX_LOG = log;
  });

  afterAll(async () => {
    delete process.env.DBX_LOG;
    await rm(dir, { recursive: true, force: true });
  });

  function updateTool() {
    const client = new DataboxClient({ bin, config: "" });
    const tool = buildTrackerTools(client).find((t) => t.name === "tracker_update_task");
    if (!tool) throw new Error("tracker_update_task not found");
    return tool;
  }

  async function lastInvokeParams(): Promise<Record<string, unknown>> {
    const lines = (await Bun.file(log).text()).trim().split("\n");
    const line = lines[lines.length - 1] ?? "";
    return JSON.parse(line.slice(line.indexOf("--params") + "--params ".length));
  }

  test("model-visible schema declares status as the Linear workflow state", () => {
    const schema = updateTool().parameters as {
      properties: Record<string, { type: string; description?: string }>;
    };
    expect(schema.properties.status?.type).toBe("string");
    expect(schema.properties.status?.description).toMatch(/workflow state/i);
    expect(schema.properties.status?.description).toMatch(/In Progress/);
    expect(updateTool().description).toContain("`status`");
  });

  test("a status argument reaches the update_issue mutation", async () => {
    await updateTool().execute("c1", { ref: "TAV-229", status: "In Progress" });
    expect(await lastInvokeParams()).toEqual({ issue_id: "TAV-229", status: "In Progress" });
  });

  test("status survives alongside priority and an empty assignee_id", async () => {
    await updateTool().execute("c2", {
      ref: "TAV-229",
      priority: 2,
      assignee_id: "",
      status: "Done",
    });
    expect(await lastInvokeParams()).toEqual({ issue_id: "TAV-229", priority: 2, status: "Done" });
  });

  test("priority still works without a status", async () => {
    await updateTool().execute("c3", { ref: "TAV-229", priority: 1 });
    expect(await lastInvokeParams()).toEqual({ issue_id: "TAV-229", priority: 1 });
  });
});
