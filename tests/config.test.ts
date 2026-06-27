import { describe, expect, test } from "bun:test";
import { type Env, loadConfig } from "../src/config.ts";

const base: Env = {
  ANTHROPIC_API_KEY: "sk-test",
  PPMA_TELEGRAM_BOT_TOKEN: "tg-test",
};

describe("loadConfig", () => {
  test("applies defaults when only required vars are set", () => {
    const config = loadConfig(base);
    expect(config.model).toBe("claude-sonnet-4-6");
    expect(config.ppmBin).toBe("ppm");
    expect(config.ppmMemoryRoot).toBe("./memory");
    expect(config.contextRecent).toBe(3);
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

  test("parses integer overrides", () => {
    const config = loadConfig({ ...base, PPMA_CONTEXT_RECENT: "7" });
    expect(config.contextRecent).toBe(7);
  });

  test("rejects non-integer numeric vars", () => {
    expect(() => loadConfig({ ...base, PPMA_CONTEXT_RECENT: "abc" })).toThrow(/integer/);
  });
});
