import type { Config } from "../../src/config.ts";

/**
 * Baseline {@link Config} for tests. Override only the fields a test actually
 * exercises via `overrides`. Adding a new Config field means updating this one
 * default — not every test fixture — so a new field never breaks unrelated
 * suites (and never becomes a merge-conflict magnet across parallel branches).
 */
export function makeTestConfig(overrides: Partial<Config> = {}): Config {
  return {
    provider: "anthropic",
    apiKey: "test-key",
    model: "faux-1",
    baseUrl: "",
    ppmBin: "ppm",
    ppmMemoryRoot: "/tmp",
    contextRecent: 5,
    dbxcliBin: "dbxcli",
    dbxcliConfig: "",
    dbxcliQueryLimit: 100,
    proteosBin: "proteos",
    proteosUrl: "",
    proteosWatchIntervalMs: 30_000,
    reminderPollIntervalMs: 30_000,
    telegramBotToken: "test",
    telegramAllowedChatId: undefined,
    sessionFile: "/tmp/session.json",
    compactionTokenThreshold: 0,
    logLevel: "info",
    logFormat: "json",
    confirmationGate: true,
    githubWebhookPort: null,
    githubWebhookSecret: "",
    githubMonitoredRepos: [],
    metricsPort: null,
    traceViewerPort: null,
    sessionRetentionDays: 30,
    telegramWebhookPort: null,
    telegramWebhookUrl: "",
    telegramWebhookSecret: "",
    githubToken: "",
    execMaxOutputBytes: 1_048_576,
    turnMaxTools: 0,
    turnMaxCostUsd: 0,
    sessionMaxCostUsd: 0,
    showToolCalls: false,
    ...overrides,
  };
}
