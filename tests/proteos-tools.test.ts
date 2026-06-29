import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProteosClient, ProteosError } from "../src/proteos/proteos.ts";
import { buildProteosTools } from "../src/proteos/tools.ts";

describe("buildProteosTools", () => {
  const proteos = new ProteosClient({ bin: "proteos" });

  test("exposes the expected proteos tool set", () => {
    const names = buildProteosTools(proteos)
      .map((t) => t.name)
      .sort();
    expect(names).toEqual([
      "proteos_git_branch",
      "proteos_git_commit",
      "proteos_git_diff",
      "proteos_git_pr",
      "proteos_git_push",
      "proteos_git_status",
      "proteos_machine_get",
      "proteos_machines_list",
      "proteos_project_clone",
      "proteos_project_ensure",
      "proteos_projects_list",
      "proteos_repos_list",
      "proteos_task_cancel",
      "proteos_task_get",
      "proteos_task_run",
      "proteos_task_send",
      "proteos_tasks_list",
      "proteos_templates_list",
    ]);
  });

  test("every tool has a description and label, and does not stream (no watch)", () => {
    const tools = buildProteosTools(proteos);
    for (const tool of tools) {
      expect(tool.description.length).toBeGreaterThan(0);
      expect(tool.label.length).toBeGreaterThan(0);
    }
    expect(tools.map((t) => t.name)).not.toContain("proteos_task_watch");
  });
});

/**
 * A fake `proteos` binary that echoes its argv (tab-separated) and exits 5 for
 * `task get` and `git status` so we can exercise the exit-code handling. The CLI
 * uses 5 for "task ended failed/canceled" — informational for reads of a task,
 * but a real error elsewhere.
 */
const FAKE = `#!/usr/bin/env bash
printf 'ARGV'
for a in "$@"; do printf '\\t%s' "$a"; done
printf '\\n'
if [ "$1" = "task" ] && [ "$2" = "get" ]; then exit 5; fi
if [ "$1" = "git" ] && [ "$2" = "status" ]; then exit 5; fi
exit 0
`;

describe("ProteosClient argv + exit handling", () => {
  let dir: string;
  let bin: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "proteos-test-"));
    bin = join(dir, "proteos");
    await writeFile(bin, FAKE);
    await chmod(bin, 0o755);
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("omits --url when none is configured", async () => {
    const client = new ProteosClient({ bin });
    expect(await client.listMachines()).toBe("ARGV\tmachines\tls");
  });

  test("injects --url right after the leaf subcommand", async () => {
    const client = new ProteosClient({ bin, url: "http://cp" });
    expect(await client.listMachines()).toBe("ARGV\tmachines\tls\t--url\thttp://cp");
  });

  test("task run passes --machine/--project and guards the prompt with --", async () => {
    const client = new ProteosClient({ bin });
    const out = await client.taskRun({ machine: "m-1", project: "p", prompt: "-x risky prompt" });
    expect(out).toBe("ARGV\ttask\trun\t--machine\tm-1\t--project\tp\t--\t-x risky prompt");
  });

  test("task run includes --provider when given", async () => {
    const client = new ProteosClient({ bin });
    const out = await client.taskRun({
      machine: "m-1",
      project: "p",
      prompt: "go",
      provider: "pi",
    });
    expect(out).toBe("ARGV\ttask\trun\t--machine\tm-1\t--project\tp\t--provider\tpi\t--\tgo");
  });

  test("task send puts the task id before the prompt, both after --", async () => {
    const client = new ProteosClient({ bin });
    const out = await client.taskSend("m-1", "t-9", "now add tests");
    expect(out).toBe("ARGV\ttask\tsend\t--machine\tm-1\t--\tt-9\tnow add tests");
  });

  test("git commit puts paths after -- so a dashed path is not a flag", async () => {
    const client = new ProteosClient({ bin });
    const out = await client.gitCommit({
      machine: "m-1",
      project: "p",
      message: "fix",
      paths: ["src/a.ts", "src/b.ts"],
    });
    expect(out).toBe(
      "ARGV\tgit\tcommit\t--machine\tm-1\t--project\tp\t-m\tfix\t--\tsrc/a.ts\tsrc/b.ts",
    );
  });

  test("task get tolerates exit 5 (failed/canceled task) and returns its output", async () => {
    const client = new ProteosClient({ bin });
    const out = await client.taskGet("m-1", "t-9");
    expect(out).toBe("ARGV\ttask\tget\t--machine\tm-1\tt-9");
  });

  test("a non-task-read command throws ProteosError on exit 5", async () => {
    const client = new ProteosClient({ bin });
    let caught: unknown;
    try {
      await client.gitStatus("m-1", "p");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ProteosError);
    expect((caught as ProteosError).exitCode).toBe(5);
  });
});
