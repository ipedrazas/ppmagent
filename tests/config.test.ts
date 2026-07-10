import { describe, expect, test } from "bun:test";
import { type Env, loadConfig } from "../src/config.ts";

const base: Env = {
  ANTHROPIC_API_KEY: "sk-test",
  PPMA_TELEGRAM_BOT_TOKEN: "tg-test",
  PPMA_TELEGRAM_ALLOWED_CHAT_ID: "12345",
};

describe("loadConfig", () => {
  test("applies defaults when only required vars are set", () => {
    const config = loadConfig(base);
    expect(config.provider).toBe("anthropic");
    expect(config.apiKey).toBe("sk-test");
    expect(config.model).toBe("claude-sonnet-4-6");
    expect(config.ppmBin).toBe("ppm");
    expect(config.ppmMemoryRoot).toBe("./memory");
    expect(config.contextRecent).toBe(3);
    expect(config.dbxcliBin).toBe("dbxcli");
    expect(config.dbxcliConfig).toBe("");
    expect(config.proteosBin).toBe("proteos");
    expect(config.proteosUrl).toBe("");
    expect(config.proteosWatchIntervalMs).toBe(30_000);
    expect(config.compactionTokenThreshold).toBe(0);
    expect(config.telegramAllowedChatId).toBe(12345);
    expect(config.logLevel).toBe("info");
    expect(config.logFormat).toBe("json");
    expect(config.confirmationGate).toBe(true);
  });

  test("parses custom proteos watch interval", () => {
    const config = loadConfig({ ...base, PPMA_PROTEOS_WATCH_INTERVAL_MS: "60000" });
    expect(config.proteosWatchIntervalMs).toBe(60_000);
  });

  test("parses logging overrides", () => {
    const config = loadConfig({ ...base, PPMA_LOG_LEVEL: "debug", PPMA_LOG_FORMAT: "pretty" });
    expect(config.logLevel).toBe("debug");
    expect(config.logFormat).toBe("pretty");
  });

  test("rejects an out-of-set log level", () => {
    expect(() => loadConfig({ ...base, PPMA_LOG_LEVEL: "verbose" })).toThrow(
      /PPMA_LOG_LEVEL must be one of/,
    );
  });

  test("rejects an out-of-set log format", () => {
    expect(() => loadConfig({ ...base, PPMA_LOG_FORMAT: "xml" })).toThrow(
      /PPMA_LOG_FORMAT must be one of/,
    );
  });

  test("throws when a required var is missing", () => {
    expect(() => loadConfig({ ANTHROPIC_API_KEY: "x" })).toThrow(/PPMA_TELEGRAM_BOT_TOKEN/);
  });

  test("fails closed when the allowed chat id is missing", () => {
    const { PPMA_TELEGRAM_ALLOWED_CHAT_ID: _omitted, ...noChatId } = base;
    expect(() => loadConfig(noChatId)).toThrow(/PPMA_TELEGRAM_ALLOWED_CHAT_ID/);
  });

  test("rejects a malformed allowed chat id instead of silently ignoring all chats", () => {
    expect(() => loadConfig({ ...base, PPMA_TELEGRAM_ALLOWED_CHAT_ID: "not-a-number" })).toThrow(
      /must be an integer chat id/,
    );
  });

  test("parses a negative (group) chat id", () => {
    const config = loadConfig({ ...base, PPMA_TELEGRAM_ALLOWED_CHAT_ID: "-1001234567890" });
    expect(config.telegramAllowedChatId).toBe(-1001234567890);
  });

  test("PPMA_ALLOW_ANY_CHAT=true explicitly opts into an open bot", () => {
    const { PPMA_TELEGRAM_ALLOWED_CHAT_ID: _omitted, ...noChatId } = base;
    const config = loadConfig({ ...noChatId, PPMA_ALLOW_ANY_CHAT: "true" });
    expect(config.telegramAllowedChatId).toBeUndefined();
  });

  test("an explicit allowed chat id wins over PPMA_ALLOW_ANY_CHAT", () => {
    const config = loadConfig({ ...base, PPMA_ALLOW_ANY_CHAT: "true" });
    expect(config.telegramAllowedChatId).toBe(12345);
  });

  test("selects an alternate provider with its own key and default model", () => {
    const config = loadConfig({
      PPMA_PROVIDER: "deepseek",
      DEEPSEEK_API_KEY: "ds-test",
      PPMA_TELEGRAM_BOT_TOKEN: "tg-test",
      PPMA_TELEGRAM_ALLOWED_CHAT_ID: "12345",
    });
    expect(config.provider).toBe("deepseek");
    expect(config.apiKey).toBe("ds-test");
    expect(config.model).toBe("deepseek-v4-pro");
  });

  test("normalises the glm alias to the zai provider", () => {
    const config = loadConfig({
      PPMA_PROVIDER: "glm",
      ZAI_API_KEY: "zai-test",
      PPMA_TELEGRAM_BOT_TOKEN: "tg-test",
      PPMA_TELEGRAM_ALLOWED_CHAT_ID: "12345",
    });
    expect(config.provider).toBe("zai");
    expect(config.apiKey).toBe("zai-test");
    expect(config.model).toBe("glm-4.7");
  });

  test("requires the selected provider's API key", () => {
    expect(() =>
      loadConfig({ PPMA_PROVIDER: "openrouter", PPMA_TELEGRAM_BOT_TOKEN: "tg-test" }),
    ).toThrow(/OPENROUTER_API_KEY/);
  });

  test("rejects an unknown provider", () => {
    expect(() => loadConfig({ ...base, PPMA_PROVIDER: "llama" })).toThrow(
      /PPMA_PROVIDER must be one of/,
    );
  });

  test("honours an explicit model override for an alternate provider", () => {
    const config = loadConfig({
      PPMA_PROVIDER: "openrouter",
      OPENROUTER_API_KEY: "or-test",
      PPMA_MODEL: "anthropic/claude-opus-4.5",
      PPMA_TELEGRAM_BOT_TOKEN: "tg-test",
      PPMA_TELEGRAM_ALLOWED_CHAT_ID: "12345",
    });
    expect(config.model).toBe("anthropic/claude-opus-4.5");
  });

  test("parses integer overrides", () => {
    const config = loadConfig({ ...base, PPMA_CONTEXT_RECENT: "7" });
    expect(config.contextRecent).toBe(7);
  });

  test("rejects non-integer numeric vars", () => {
    expect(() => loadConfig({ ...base, PPMA_CONTEXT_RECENT: "abc" })).toThrow(/integer/);
  });

  test("confirmation gate is enabled by default", () => {
    const config = loadConfig(base);
    expect(config.confirmationGate).toBe(true);
  });

  test("PPMA_CONFIRMATION_GATE=false disables the gate", () => {
    const config = loadConfig({ ...base, PPMA_CONFIRMATION_GATE: "false" });
    expect(config.confirmationGate).toBe(false);
  });

  test("PPMA_CONFIRMATION_GATE=true keeps the gate enabled", () => {
    const config = loadConfig({ ...base, PPMA_CONFIRMATION_GATE: "true" });
    expect(config.confirmationGate).toBe(true);
  });

  test("resource limits default to safe values (1 MB exec cap, 0 = unlimited for others)", () => {
    const config = loadConfig(base);
    expect(config.execMaxOutputBytes).toBe(1_048_576);
    expect(config.turnMaxTools).toBe(0);
    expect(config.turnMaxCostUsd).toBe(0);
    expect(config.sessionMaxCostUsd).toBe(0);
  });

  test("PPMA_EXEC_MAX_OUTPUT_BYTES overrides exec output cap", () => {
    const config = loadConfig({ ...base, PPMA_EXEC_MAX_OUTPUT_BYTES: "524288" });
    expect(config.execMaxOutputBytes).toBe(524_288);
  });

  test("PPMA_TURN_MAX_TOOLS overrides per-turn tool budget", () => {
    const config = loadConfig({ ...base, PPMA_TURN_MAX_TOOLS: "20" });
    expect(config.turnMaxTools).toBe(20);
  });

  test("PPMA_TURN_MAX_COST_USD accepts a decimal value", () => {
    const config = loadConfig({ ...base, PPMA_TURN_MAX_COST_USD: "0.05" });
    expect(config.turnMaxCostUsd).toBe(0.05);
  });

  test("PPMA_SESSION_MAX_COST_USD accepts a decimal value", () => {
    const config = loadConfig({ ...base, PPMA_SESSION_MAX_COST_USD: "1.50" });
    expect(config.sessionMaxCostUsd).toBe(1.5);
  });

  test("PPMA_TURN_MAX_COST_USD rejects a non-number value", () => {
    expect(() => loadConfig({ ...base, PPMA_TURN_MAX_COST_USD: "nope" })).toThrow(
      /must be a number/,
    );
  });

  test("githubToken defaults to empty string when GITHUB_TOKEN is not set", () => {
    const config = loadConfig(base);
    expect(config.githubToken).toBe("");
  });

  test("reads GITHUB_TOKEN from the environment", () => {
    const config = loadConfig({ ...base, GITHUB_TOKEN: "ghp_testtoken123" });
    expect(config.githubToken).toBe("ghp_testtoken123");
  });

  test("showToolCalls defaults to false", () => {
    const config = loadConfig(base);
    expect(config.showToolCalls).toBe(false);
  });

  test("PPMA_SHOW_TOOL_CALLS=true enables tool-call status messages", () => {
    const config = loadConfig({ ...base, PPMA_SHOW_TOOL_CALLS: "true" });
    expect(config.showToolCalls).toBe(true);
  });

  test("PPMA_SHOW_TOOL_CALLS accepts only the literal 'true'", () => {
    const config = loadConfig({ ...base, PPMA_SHOW_TOOL_CALLS: "yes" });
    expect(config.showToolCalls).toBe(false);
  });

  test("selects ollama with an optional API key, default model, and default base URL", () => {
    const config = loadConfig({
      PPMA_PROVIDER: "ollama",
      PPMA_TELEGRAM_BOT_TOKEN: "tg-test",
      PPMA_TELEGRAM_ALLOWED_CHAT_ID: "12345",
    });
    expect(config.provider).toBe("ollama");
    expect(config.apiKey).toBe("");
    expect(config.model).toBe("llama3");
    expect(config.baseUrl).toBe("http://localhost:11434/v1");
  });

  test("honours an explicit OLLAMA_API_KEY and PPMA_BASE_URL override", () => {
    const config = loadConfig({
      PPMA_PROVIDER: "ollama",
      OLLAMA_API_KEY: "ollama-test",
      PPMA_BASE_URL: "http://ollama.local:11434/v1",
      PPMA_TELEGRAM_BOT_TOKEN: "tg-test",
      PPMA_TELEGRAM_ALLOWED_CHAT_ID: "12345",
    });
    expect(config.apiKey).toBe("ollama-test");
    expect(config.baseUrl).toBe("http://ollama.local:11434/v1");
  });

  test("other providers default to an empty base URL", () => {
    const config = loadConfig(base);
    expect(config.baseUrl).toBe("");
  });
});
