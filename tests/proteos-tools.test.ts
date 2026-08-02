import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PollGate } from "../src/proteos/poll-gate.ts";
import { ProteosClient, ProteosError } from "../src/proteos/proteos.ts";
import { buildProteosTools } from "../src/proteos/tools.ts";
import { ArgInjectionError } from "../src/sanitize.ts";
import { CONFIRM_SUFFIX, ConfirmationStore } from "../src/tools/confirmation.ts";

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
      "proteos_machine_create",
      "proteos_machine_get",
      "proteos_machine_start",
      "proteos_machine_stop",
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

/**
 * A fake `proteos` binary that echoes the GITHUB_TOKEN environment variable so
 * we can verify ProteosClient forwards it via the subprocess environment.
 */
const FAKE_ENV_ECHO = `#!/usr/bin/env bash
echo "GITHUB_TOKEN=$GITHUB_TOKEN"
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

  test("proteos_task_run tool strips control characters from the prompt before it reaches argv", async () => {
    const client = new ProteosClient({ bin });
    const tool = buildProteosTools(client).find((t) => t.name === "proteos_task_run");
    if (!tool) throw new Error("proteos_task_run not found");
    const out = await tool.execute("call-1", {
      machine: "m-1",
      project: "p",
      prompt: "do\x01 it\x1f now",
    });
    const text = (out.content[0] as { text: string }).text;
    expect(text).toBe("ARGV\ttask\trun\t--machine\tm-1\t--project\tp\t--\tdo it now");
  });

  test("proteos_task_send tool strips control characters from the prompt before it reaches argv", async () => {
    const client = new ProteosClient({ bin });
    const tool = buildProteosTools(client).find((t) => t.name === "proteos_task_send");
    if (!tool) throw new Error("proteos_task_send not found");
    const out = await tool.execute("call-1", {
      machine: "m-1",
      task: "t-9",
      prompt: "now\x02 add\x1e tests",
    });
    const text = (out.content[0] as { text: string }).text;
    expect(text).toBe("ARGV\ttask\tsend\t--machine\tm-1\t--\tt-9\tnow add tests");
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

  test("machines create passes template, name, and resource overrides as flags", async () => {
    const client = new ProteosClient({ bin });
    const out = await client.createMachine({
      template: "go",
      name: "my-box",
      vcpus: 4,
      memMiB: 8192,
      diskMiB: 10240,
    });
    expect(out).toBe(
      "ARGV\tmachines\tcreate\t--template\tgo\t--name\tmy-box\t--vcpus\t4\t--mem-mib\t8192\t--disk-mib\t10240",
    );
  });

  test("machines create with only a template omits the optional flags", async () => {
    const client = new ProteosClient({ bin });
    const out = await client.createMachine({ template: "full-stack" });
    expect(out).toBe("ARGV\tmachines\tcreate\t--template\tfull-stack");
  });

  test("machines create rejects non-positive-integer resource overrides", async () => {
    const client = new ProteosClient({ bin });
    expect(() => client.createMachine({ template: "go", vcpus: -4 })).toThrow(ArgInjectionError);
    expect(() => client.createMachine({ template: "go", memMiB: 1.5 })).toThrow(ArgInjectionError);
  });

  test("machines start/stop pass the id positionally after the flags", async () => {
    const client = new ProteosClient({ bin });
    expect(await client.startMachine("m-1")).toBe("ARGV\tmachines\tstart\tm-1");
    expect(await client.stopMachine("m-1")).toBe("ARGV\tmachines\tstop\tm-1");
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

/** A fake `proteos` binary whose `task run` prints a task id, like the real CLI. */
const FAKE_TASK_RUN = `#!/usr/bin/env bash
if [ "$1" = "task" ] && [ "$2" = "run" ]; then echo "dispatched task t-42"; exit 0; fi
exit 0
`;

describe("proteos_task_run wait opt-in", () => {
  let dir: string;
  let bin: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "proteos-taskrun-test-"));
    bin = join(dir, "proteos");
    await writeFile(bin, FAKE_TASK_RUN);
    await chmod(bin, 0o755);
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function runTool(onTaskDispatched: (m: string, t: string, p: string, l: string) => void) {
    const proteos = new ProteosClient({ bin });
    const tool = buildProteosTools(proteos, { onTaskDispatched }).find(
      (t) => t.name === "proteos_task_run",
    );
    if (!tool) throw new Error("proteos_task_run not found");
    return tool;
  }

  test("does not register the task for background tracking by default", async () => {
    const dispatched: unknown[] = [];
    const tool = runTool((...args) => dispatched.push(args));
    await tool.execute("call-1", { machine: "m-1", project: "p", prompt: "do it" });
    expect(dispatched).toEqual([]);
  });

  test("wait:true registers the task for background tracking", async () => {
    const dispatched: unknown[] = [];
    const tool = runTool((...args) => dispatched.push(args));
    await tool.execute("call-1", { machine: "m-1", project: "p", prompt: "do it", wait: true });
    expect(dispatched).toEqual([["m-1", "t-42", "p", "do it"]]);
  });

  test("wait:false behaves the same as omitting it", async () => {
    const dispatched: unknown[] = [];
    const tool = runTool((...args) => dispatched.push(args));
    await tool.execute("call-1", { machine: "m-1", project: "p", prompt: "do it", wait: false });
    expect(dispatched).toEqual([]);
  });

  test("strips control characters from the prompt before dispatch, keeping them out of the tracked label", async () => {
    const dispatched: unknown[] = [];
    const tool = runTool((...args) => dispatched.push(args));
    await tool.execute("call-1", {
      machine: "m-1",
      project: "p",
      prompt: "do it\x01\x02 now\x1f",
      wait: true,
    });
    expect(dispatched).toEqual([["m-1", "t-42", "p", "do it now"]]);
  });
});

describe("proteos_machine_create confirmation gate", () => {
  let dir: string;
  let bin: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "proteos-confirm-test-"));
    bin = join(dir, "proteos");
    await writeFile(bin, FAKE);
    await chmod(bin, 0o755);
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function createTool(store?: ConfirmationStore) {
    const proteos = new ProteosClient({ bin });
    const tool = buildProteosTools(proteos, { confirmationStore: store }).find(
      (t) => t.name === "proteos_machine_create",
    );
    if (!tool) throw new Error("proteos_machine_create not found");
    return tool;
  }

  test("with a store: stashes the pending create and terminates without executing", async () => {
    const store = new ConfirmationStore();
    const tool = createTool(store);
    const result = await tool.execute("call-1", { template: "go", name: "my-box", vcpus: 4 });

    expect(result.terminate).toBe(true);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("Create machine from template 'go'");
    expect(text).toContain("Name: my-box");
    expect(text).toContain("4 vCPU");
    expect(text).toEndWith(CONFIRM_SUFFIX);

    expect(store.hasPending()).toBe(true);
    const out = await store.get()?.execute();
    expect(out).toBe("ARGV\tmachines\tcreate\t--template\tgo\t--name\tmy-box\t--vcpus\t4");
  });

  test("without a store: executes immediately", async () => {
    const tool = createTool();
    const result = await tool.execute("call-1", { template: "go" });
    expect(result.terminate).toBeUndefined();
    const text = (result.content[0] as { text: string }).text;
    expect(text).toBe("ARGV\tmachines\tcreate\t--template\tgo");
  });
});

describe("ProteosClient GITHUB_TOKEN forwarding", () => {
  let dir: string;
  let bin: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "proteos-env-test-"));
    bin = join(dir, "proteos");
    await writeFile(bin, FAKE_ENV_ECHO);
    await chmod(bin, 0o755);
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("injects GITHUB_TOKEN into the subprocess environment when configured", async () => {
    const client = new ProteosClient({ bin, githubToken: "ghp_testtoken" });
    const out = await client.listMachines();
    expect(out).toBe("GITHUB_TOKEN=ghp_testtoken");
  });

  test("does not override GITHUB_TOKEN when githubToken is omitted", async () => {
    const client = new ProteosClient({ bin });
    const out = await client.listMachines();
    expect(out).toBe("GITHUB_TOKEN=");
  });
});

describe("proteos status-read rate limiting", () => {
  let dir: string;
  let bin: string;
  let callLog: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "proteos-poll-test-"));
    bin = join(dir, "proteos");
    callLog = join(dir, "calls.log");
    // Counts every invocation so we can assert the CLI is not re-run when throttled.
    await writeFile(
      bin,
      `#!/usr/bin/env bash\necho "call" >> ${callLog}\necho "status: running"\n`,
    );
    await chmod(bin, 0o755);
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function callCount(): Promise<number> {
    const text = await readFile(callLog, "utf8").catch(() => "");
    return text.split("\n").filter(Boolean).length;
  }

  /** Tools sharing one gate over a clock the test controls. */
  function toolsWithClock() {
    let now = 5_000_000;
    const proteos = new ProteosClient({ bin });
    const tools = buildProteosTools(proteos, { pollGate: new PollGate(() => now) });
    const pick = (name: string) => {
      const tool = tools.find((t) => t.name === name);
      if (!tool) throw new Error(`${name} not found`);
      return tool;
    };
    return { pick, advance: (ms: number) => (now += ms) };
  }

  function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
    return result.content.map((c) => c.text ?? "").join("");
  }

  test("a second immediate task_get does not reach the CLI", async () => {
    const { pick } = toolsWithClock();
    const getTask = pick("proteos_task_get");
    const before = await callCount();

    const first = await getTask.execute("c1", { machine: "m-1", task: "t-1" });
    expect(textOf(first)).toContain("status: running");
    expect(await callCount()).toBe(before + 1);

    const second = await getTask.execute("c2", { machine: "m-1", task: "t-1" });
    expect(await callCount()).toBe(before + 1);
    expect(textOf(second)).toContain("Not checked");
    expect(textOf(second)).toContain("Wait at least 1s");
    // The last known status still comes back, so the model is not left blind.
    expect(textOf(second)).toContain("status: running");
  });

  test("a caller that keeps polling has its turn terminated", async () => {
    const { pick } = toolsWithClock();
    const getTask = pick("proteos_task_get");
    await getTask.execute("c1", { machine: "m-1", task: "t-2" });

    const blocked = await getTask.execute("c2", { machine: "m-1", task: "t-2" });
    expect(blocked.terminate).toBeFalsy();

    const again = await getTask.execute("c3", { machine: "m-1", task: "t-2" });
    expect(again.terminate).toBe(true);
    // A terminating tool's text is what the user receives, so it must read as a
    // reply to them, not as an instruction aimed at the model.
    expect(textOf(again)).toContain("I stopped checking task t-2");
    expect(textOf(again)).not.toContain("end your turn");
  });

  test("the check goes through once the backoff has elapsed", async () => {
    const { pick, advance } = toolsWithClock();
    const getTask = pick("proteos_task_get");
    await getTask.execute("c1", { machine: "m-1", task: "t-3" });
    const after = await callCount();

    advance(1_000);
    const allowed = await getTask.execute("c2", { machine: "m-1", task: "t-3" });
    expect(textOf(allowed)).toContain("status: running");
    expect(await callCount()).toBe(after + 1);

    // Second interval is 10s, so 1s is no longer enough.
    advance(1_000);
    const throttled = await getTask.execute("c3", { machine: "m-1", task: "t-3" });
    expect(textOf(throttled)).toContain("Wait at least");
  });

  test("different tasks are rate-limited independently", async () => {
    const { pick } = toolsWithClock();
    const getTask = pick("proteos_task_get");
    await getTask.execute("c1", { machine: "m-1", task: "t-4" });
    const other = await getTask.execute("c2", { machine: "m-1", task: "t-5" });
    expect(textOf(other)).toContain("status: running");
  });

  test("tasks_list is throttled too, so it is not a way around the backoff", async () => {
    const { pick } = toolsWithClock();
    const getTask = pick("proteos_task_get");
    const listTasks = pick("proteos_tasks_list");
    await getTask.execute("c1", { machine: "m-1", task: "t-6" });
    await listTasks.execute("c2", { machine: "m-1" });
    const second = await listTasks.execute("c3", { machine: "m-1" });
    expect(textOf(second)).toContain("Not checked");
  });

  test("dispatching a task clears the backoff so its status can be read once", async () => {
    const { pick } = toolsWithClock();
    const listTasks = pick("proteos_tasks_list");
    const taskRun = pick("proteos_task_run");
    await listTasks.execute("c1", { machine: "m-1" });
    expect(textOf(await listTasks.execute("c2", { machine: "m-1" }))).toContain("Not checked");

    await taskRun.execute("c3", { machine: "m-1", project: "p", prompt: "do it" });
    expect(textOf(await listTasks.execute("c4", { machine: "m-1" }))).toContain("status: running");
  });
});
