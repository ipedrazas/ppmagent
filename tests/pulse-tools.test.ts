import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PulseClient, PulseError } from "../src/pulse/pulse.ts";
import { buildPulseTools } from "../src/pulse/tools.ts";
import { ArgInjectionError } from "../src/sanitize.ts";
import { CONFIRM_SUFFIX, ConfirmationStore } from "../src/tools/confirmation.ts";

describe("buildPulseTools", () => {
  const pulse = new PulseClient({ bin: "pulse" });

  test("exposes the expected pulse tool set", () => {
    const names = buildPulseTools(pulse)
      .map((t) => t.name)
      .sort();
    expect(names).toEqual([
      "pulse_down",
      "pulse_images",
      "pulse_logs",
      "pulse_nodes",
      "pulse_ps",
      "pulse_pull",
      "pulse_up",
    ]);
  });

  test("every tool has a description and label", () => {
    for (const tool of buildPulseTools(pulse)) {
      expect(tool.description.length).toBeGreaterThan(0);
      expect(tool.label.length).toBeGreaterThan(0);
    }
  });
});

/** A fake `pulse` binary that echoes its argv (tab-separated) and exits 0. */
const FAKE = `#!/usr/bin/env bash
printf 'ARGV'
for a in "$@"; do printf '\\t%s' "$a"; done
printf '\\n'
exit 0
`;

/** A fake `pulse` binary that always fails, like an unreachable node. */
const FAKE_FAIL = `#!/usr/bin/env bash
echo "node unreachable" >&2
exit 3
`;

describe("PulseClient argv handling", () => {
  let dir: string;
  let bin: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "pulse-test-"));
    bin = join(dir, "pulse");
    await writeFile(bin, FAKE);
    await chmod(bin, 0o755);
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("nodes takes no flags", async () => {
    const client = new PulseClient({ bin });
    expect(await client.listNodes()).toBe("ARGV\tnodes");
  });

  test("ps omits --node when none is given", async () => {
    const client = new PulseClient({ bin });
    expect(await client.listContainers()).toBe("ARGV\tps");
  });

  test("ps passes --node when given", async () => {
    const client = new PulseClient({ bin });
    expect(await client.listContainers("vm-1")).toBe("ARGV\tps\t--node\tvm-1");
  });

  test("images passes --node when given", async () => {
    const client = new PulseClient({ bin });
    expect(await client.listImages("vm-1")).toBe("ARGV\timages\t--node\tvm-1");
  });

  test("pull passes the image positionally and --node when given", async () => {
    const client = new PulseClient({ bin });
    expect(await client.pullImage("ghcr.io/org/app:latest", "vm-1")).toBe(
      "ARGV\tpull\tghcr.io/org/app:latest\t--node\tvm-1",
    );
  });

  test("pull rejects an image reference that looks like a flag", () => {
    const client = new PulseClient({ bin });
    expect(() => client.pullImage("-x", "vm-1")).toThrow(ArgInjectionError);
  });

  test("pull rejects a node name that looks like a flag", () => {
    const client = new PulseClient({ bin });
    expect(() => client.pullImage("app:latest", "-x")).toThrow(ArgInjectionError);
  });

  test("up passes --node and --compose when given", async () => {
    const client = new PulseClient({ bin });
    expect(await client.up({ node: "vm-1", compose: "/opt/proteos/docker-compose.yml" })).toBe(
      "ARGV\tup\t--node\tvm-1\t--compose\t/opt/proteos/docker-compose.yml",
    );
  });

  test("up omits flags when neither node nor compose is given", async () => {
    const client = new PulseClient({ bin });
    expect(await client.up()).toBe("ARGV\tup");
  });

  test("down passes --node and --compose when given", async () => {
    const client = new PulseClient({ bin });
    expect(await client.down({ node: "vm-1", compose: "/opt/proteos/docker-compose.yml" })).toBe(
      "ARGV\tdown\t--node\tvm-1\t--compose\t/opt/proteos/docker-compose.yml",
    );
  });

  test("logs passes --node and --compose when given", async () => {
    const client = new PulseClient({ bin });
    expect(await client.logs({ node: "vm-1", compose: "/opt/proteos/docker-compose.yml" })).toBe(
      "ARGV\tlogs\t--node\tvm-1\t--compose\t/opt/proteos/docker-compose.yml",
    );
  });

  test("pulse_pull tool sanitizes the image before it reaches argv", async () => {
    const client = new PulseClient({ bin });
    const tool = buildPulseTools(client).find((t) => t.name === "pulse_pull");
    if (!tool) throw new Error("pulse_pull not found");
    const out = await tool.execute("call-1", { image: "app:latest\nrm -rf /", node: "vm-1" });
    const text = (out.content[0] as { text: string }).text;
    expect(text).toBe("ARGV\tpull\tapp:latest rm -rf /\t--node\tvm-1");
  });
});

describe("PulseClient error handling", () => {
  let dir: string;
  let bin: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "pulse-fail-test-"));
    bin = join(dir, "pulse");
    await writeFile(bin, FAKE_FAIL);
    await chmod(bin, 0o755);
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("a non-zero exit throws PulseError carrying stderr and the exit code", async () => {
    const client = new PulseClient({ bin });
    let caught: unknown;
    try {
      await client.listNodes();
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(PulseError);
    expect((caught as PulseError).exitCode).toBe(3);
    expect((caught as PulseError).message).toBe("node unreachable");
  });

  test("binary not found rejects rather than throwing a PulseError", async () => {
    const client = new PulseClient({ bin: join(dir, "does-not-exist") });
    await expect(client.listNodes()).rejects.not.toBeInstanceOf(PulseError);
  });
});

describe("pulse_up / pulse_down confirmation gate", () => {
  let dir: string;
  let bin: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "pulse-confirm-test-"));
    bin = join(dir, "pulse");
    await writeFile(bin, FAKE);
    await chmod(bin, 0o755);
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("pulse_up defers to the confirmation store and does not deploy immediately", async () => {
    const client = new PulseClient({ bin });
    const store = new ConfirmationStore();
    const tool = buildPulseTools(client, { confirmationStore: store }).find(
      (t) => t.name === "pulse_up",
    );
    if (!tool) throw new Error("pulse_up not found");

    const out = await tool.execute("call-1", { node: "vm-1", compose: "compose.yml" });
    const text = (out.content[0] as { text: string }).text;
    expect(text).toContain("Deploy/restart compose stack");
    expect(text).toContain(CONFIRM_SUFFIX.trim());
    expect(out.terminate).toBe(true);

    const pending = store.get();
    expect(pending).not.toBeNull();
    const result = await pending?.execute();
    expect(result).toBe("ARGV\tup\t--node\tvm-1\t--compose\tcompose.yml");
  });

  test("pulse_down defers to the confirmation store", async () => {
    const client = new PulseClient({ bin });
    const store = new ConfirmationStore();
    const tool = buildPulseTools(client, { confirmationStore: store }).find(
      (t) => t.name === "pulse_down",
    );
    if (!tool) throw new Error("pulse_down not found");

    const out = await tool.execute("call-1", { node: "vm-1" });
    expect(out.terminate).toBe(true);

    const pending = store.get();
    const result = await pending?.execute();
    expect(result).toBe("ARGV\tdown\t--node\tvm-1");
  });

  test("pulse_pull does not require confirmation even when a store is present", async () => {
    const client = new PulseClient({ bin });
    const store = new ConfirmationStore();
    const tool = buildPulseTools(client, { confirmationStore: store }).find(
      (t) => t.name === "pulse_pull",
    );
    if (!tool) throw new Error("pulse_pull not found");

    const out = await tool.execute("call-1", { image: "app:latest", node: "vm-1" });
    const text = (out.content[0] as { text: string }).text;
    expect(text).toBe("ARGV\tpull\tapp:latest\t--node\tvm-1");
    expect(store.hasPending()).toBe(false);
  });
});
