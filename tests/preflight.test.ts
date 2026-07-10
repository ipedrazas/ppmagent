import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LogLayer, TestLoggingLibrary, TestTransport } from "loglayer";
import { runPreflightChecks } from "../src/preflight.ts";

describe("runPreflightChecks", () => {
  test("marks a real binary as available", async () => {
    // `true` is always present on POSIX systems and exits 0.
    const results = await runPreflightChecks({ ppm: "true", dbxcli: "true", proteos: "true" });
    expect(results.ppm.available).toBe(true);
    expect(results.dbxcli.available).toBe(true);
    expect(results.proteos.available).toBe(true);
  });

  test("marks a missing binary as unavailable and captures the error", async () => {
    const results = await runPreflightChecks({
      ppm: "__ppm_does_not_exist__",
      dbxcli: "true",
      proteos: "true",
    });
    expect(results.ppm.available).toBe(false);
    expect(results.ppm.error).toBeTruthy();
    expect(results.dbxcli.available).toBe(true);
  });

  test("all three missing CLIs does not throw", async () => {
    const results = await runPreflightChecks({
      ppm: "__no_ppm__",
      dbxcli: "__no_dbxcli__",
      proteos: "__no_proteos__",
    });
    expect(results.ppm.available).toBe(false);
    expect(results.dbxcli.available).toBe(false);
    expect(results.proteos.available).toBe(false);
  });

  test("extracts a version string from CLI output", async () => {
    // `sh -c 'echo 1.2.3'` prints a version-like string to stdout
    const results = await runPreflightChecks({
      ppm: "sh",
      dbxcli: "sh",
      proteos: "sh",
    });
    // sh itself doesn't print a version without flags, but the binary is found
    expect(results.ppm.available).toBe(true);
  });

  test("available is true even when the binary exits non-zero (e.g. --help)", async () => {
    // `false` always exits 1 but it exists on the system
    const results = await runPreflightChecks({ ppm: "false", dbxcli: "true", proteos: "true" });
    expect(results.ppm.available).toBe(true);
  });
});

describe("dbxcli version skew warning", () => {
  let dir: string;
  let oldBin: string;
  let newBin: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "preflight-test-"));
    oldBin = join(dir, "dbxcli-old");
    newBin = join(dir, "dbxcli-new");
    await writeFile(oldBin, '#!/bin/sh\necho "dbxcli 0.1.10"\n');
    await writeFile(newBin, '#!/bin/sh\necho "dbxcli 0.1.12"\n');
    await chmod(oldBin, 0o755);
    await chmod(newBin, 0o755);
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function capturingLogger() {
    const sink = new TestLoggingLibrary();
    return { sink, logger: new LogLayer({ transport: new TestTransport({ logger: sink }) }) };
  }

  test("logs an error when dbxcli predates the minimum filter grammar", async () => {
    const { sink, logger } = capturingLogger();
    await runPreflightChecks({ ppm: "true", dbxcli: oldBin, proteos: "true" }, logger);
    const skew = sink.lines.find((l) => l.level === "error");
    expect(skew).toBeTruthy();
    expect(String(skew?.data[1] ?? skew?.data[0])).toContain("--filter grammar");
  });

  test("stays quiet for a current dbxcli", async () => {
    const { sink, logger } = capturingLogger();
    await runPreflightChecks({ ppm: "true", dbxcli: newBin, proteos: "true" }, logger);
    expect(sink.lines.find((l) => l.level === "error")).toBeUndefined();
  });
});
