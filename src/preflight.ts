import { execCommand } from "./exec.ts";
import { type Logger, nullLogger } from "./logger.ts";

export interface CliHealth {
  /** Whether the CLI binary was found and responded successfully. */
  available: boolean;
  /** Version string extracted from output, if any. */
  version?: string;
  /** Human-readable error message when unavailable. */
  error?: string;
}

export interface PreflightResults {
  ppm: CliHealth;
  dbxcli: CliHealth;
  proteos: CliHealth;
}

/**
 * Probe a single CLI binary by running it with the given args. Returns a
 * CliHealth describing whether the binary was found. Exit code is not treated
 * as a failure — some CLIs (e.g. `proteos --help`) exit non-zero for help
 * commands. Only a spawn error (ENOENT) marks the CLI as unavailable.
 */
async function probeCli(bin: string, args: string[], logger: Logger): Promise<CliHealth> {
  try {
    const { stdout, stderr } = await execCommand(bin, args, { logger });
    const output = (stdout + stderr).trim();
    const match = output.match(/\b(\d+\.\d+[.\d]*)\b/);
    return { available: true, version: match?.[1] };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return { available: false, error: msg };
  }
}

/**
 * Run preflight health checks for each dependent CLI (ppm, dbxcli, proteos)
 * in parallel. Logs a summary on completion and a warning for each unavailable
 * binary. Never throws — missing CLIs are non-fatal at boot (some may be
 * optional for the current deployment).
 */
export async function runPreflightChecks(
  bins: { ppm: string; dbxcli: string; proteos: string },
  logger: Logger = nullLogger,
): Promise<PreflightResults> {
  const [ppm, dbxcli, proteos] = await Promise.all([
    probeCli(bins.ppm, ["--version"], logger),
    probeCli(bins.dbxcli, ["--version"], logger),
    probeCli(bins.proteos, ["--help"], logger),
  ]);

  const results: PreflightResults = { ppm, dbxcli, proteos };

  logger
    .withMetadata({
      ppm: ppm.available ? (ppm.version ?? "ok") : "unavailable",
      dbxcli: dbxcli.available ? (dbxcli.version ?? "ok") : "unavailable",
      proteos: proteos.available ? (proteos.version ?? "ok") : "unavailable",
    })
    .info("preflight checks complete");

  for (const [name, health] of Object.entries(results) as [keyof PreflightResults, CliHealth][]) {
    if (!health.available) {
      logger
        .withMetadata({ cli: name, error: health.error })
        .warn(`CLI unavailable at startup: ${name}`);
    }
  }

  return results;
}
