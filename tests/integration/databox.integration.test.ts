import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { DataboxClient } from "../../src/tracker/databox.ts";

// Live DataboxPPM read paths + a SIMULATED create (no real Linear issue). Runs
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
    dataset: process.env.PPMA_DBXCLI_DATASET ?? "issues",
    createAction: process.env.PPMA_DBXCLI_CREATE_ACTION ?? "create_issue_linear",
  });
}

describe.skipIf(!enabled)("DataboxPPM tracker (live)", () => {
  test("listTasks returns neutral tasks with ref + url", async () => {
    const tasks = await client().listTasks(5);
    expect(Array.isArray(tasks)).toBe(true);
    if (tasks.length > 0) {
      const first = tasks[0];
      expect(first?.ref.length).toBeGreaterThan(0);
      expect(first?.url).toContain("http");
    }
  });

  test("getTask resolves a known ref via search", async () => {
    const tasks = await client().listTasks(5);
    if (tasks.length === 0) return; // empty workspace — nothing to resolve
    const ref = tasks[0]?.ref ?? "";
    const task = await client().getTask(ref);
    expect(task.ref).toBe(ref);
    expect(task.title.length).toBeGreaterThan(0);
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
    const task = await client().createTask(
      {
        title: "ppmagent simulated task",
        description: "Safe simulated invoke from tests.",
        team: "00000000-0000-0000-0000-000000000000",
      },
      { simulated: true },
    );
    expect(task.ref.length).toBeGreaterThan(0);
    expect(task.url).toContain("http");
    expect(task.id?.length).toBeGreaterThan(0);
  });
});
