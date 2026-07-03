import { describe, expect, test } from "bun:test";
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
