import { describe, expect, test } from "bun:test";
import { type Env, loadConfig } from "../src/config.ts";

const base: Env = {
  ANTHROPIC_API_KEY: "sk-test",
  PPMA_TELEGRAM_BOT_TOKEN: "tg-test",
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
    expect(config.compactionTokenThreshold).toBe(0);
    expect(config.telegramAllowedChatId).toBeUndefined();
    expect(config.logLevel).toBe("info");
    expect(config.logFormat).toBe("json");
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

  test("selects an alternate provider with its own key and default model", () => {
    const config = loadConfig({
      PPMA_PROVIDER: "deepseek",
      DEEPSEEK_API_KEY: "ds-test",
      PPMA_TELEGRAM_BOT_TOKEN: "tg-test",
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
});
