import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { DataboxClient, taskRef } from "../../src/tracker/databox.ts";

// Live DataboxPPM read paths + SIMULATED writes (no real Linear mutation). Runs
// only when `dbxcli` and a readable config are present, so it executes locally
// and skips in CI (which has neither the binary nor the datasource secret).
function expandHome(p: string): string {
  return p.startsWith("~") ? p.replace(/^~/, homedir()) : p;
}

const dbxcliBin = Bun.which("dbxcli");
const configPath = process.env.PPMA_DBXCLI_CONFIG ? expandHome(process.env.PPMA_DBXCLI_CONFIG) : "";
const enabled = !!dbxcliBin && !!configPath && existsSync(configPath);

function client(): DataboxClient {
  return new DataboxClient({
    bin: dbxcliBin ?? "dbxcli",
    config: configPath,
  });
}

describe.skipIf(!enabled)("DataboxPPM tracker (live)", () => {
  test("listTasks returns rows with a derivable ref + url", async () => {
    const tasks = await client().listTasks(5);
    expect(Array.isArray(tasks)).toBe(true);
    if (tasks.length > 0) {
      const first = tasks[0] as Record<string, unknown>;
      expect(taskRef(first).length).toBeGreaterThan(0);
      expect(String(first.url)).toContain("http");
    }
  });

  test("getTask resolves a known ref via `dbxcli get`", async () => {
    const tasks = await client().listTasks(5);
    if (tasks.length === 0) return; // empty workspace — nothing to resolve
    const ref = taskRef(tasks[0] as Record<string, unknown>);
    const task = await client().getTask(ref);
    expect(taskRef(task)).toBe(ref);
    expect(String(task.url)).toContain("http");
  });

  test("getTask throws DataboxError for an unknown ref", async () => {
    let caught: unknown;
    try {
      await client().getTask("NOPE-999999");
    } catch (err) {
      caught = err;
    }
    expect((caught as Error)?.name).toBe("DataboxError");
  });

  test("createTask (simulated) returns a ref + url without touching Linear", async () => {
    // Real creates send no team_id (Databox pins it); the simulator does not
    // apply pins, so we pass a dummy team here purely to pass its validation.
    const result = await client().createTask(
      {
        title: "ppmagent simulated task",
        description: "Safe simulated invoke from tests.",
        team: "00000000-0000-0000-0000-000000000000",
      },
      { simulated: true },
    );
    expect(result.identifier.length).toBeGreaterThan(0);
    expect(result.url).toContain("http");
    expect(result.issue_id.length).toBeGreaterThan(0);
  });

  test("listTeams returns rows with key + id", async () => {
    const teams = await client().listTeams(5);
    expect(Array.isArray(teams)).toBe(true);
    if (teams.length > 0) {
      const first = teams[0] as Record<string, unknown>;
      expect(String(first.key).length).toBeGreaterThan(0);
      expect(String(first.id).length).toBeGreaterThan(0);
    }
  });

  test("listProjects returns rows with id + url", async () => {
    const projects = await client().listProjects(5);
    expect(Array.isArray(projects)).toBe(true);
    if (projects.length > 0) {
      const first = projects[0] as Record<string, unknown>;
      expect(String(first.id).length).toBeGreaterThan(0);
      expect(String(first.url)).toContain("http");
    }
  });

  test("resolveTeamId maps a team key to its UUID", async () => {
    const teams = await client().listTeams(5);
    if (teams.length === 0) return; // no teams — nothing to resolve
    const first = teams[0] as Record<string, unknown>;
    const key = String(first.key);
    const id = await client().resolveTeamId(key);
    expect(id).toBe(String(first.id));
  });

  test("createProject (simulated) returns an id + url without touching Linear", async () => {
    const teams = await client().listTeams(5);
    if (teams.length === 0) return; // need a team to own the project
    const result = await client().createProject(
      {
        name: "ppmagent simulated project",
        team: String((teams[0] as Record<string, unknown>).key),
        description: "Safe simulated invoke from tests.",
      },
      { simulated: true },
    );
    expect(result.project_id.length).toBeGreaterThan(0);
    expect(result.url).toContain("http");
  });
});
