import { afterEach, describe, expect, test } from "bun:test";
import { LogLayer, TestLoggingLibrary, TestTransport } from "loglayer";
import { createLogger, nullLogger } from "../src/logger.ts";

describe("createLogger", () => {
  const originalConsole = { ...console };
  afterEach(() => Object.assign(console, originalConsole));

  test("emits one JSON line per call with msg/level/time fields", () => {
    const calls: string[] = [];
    console.info = (line: string) => calls.push(line);

    const log = createLogger({ level: "info", format: "json" });
    log.withMetadata({ chatId: 42 }).info("handled");

    expect(calls).toHaveLength(1);
    const [first] = calls;
    const parsed = JSON.parse(first ?? "{}");
    expect(parsed.msg).toBe("handled");
    expect(parsed.level).toBe("info");
    expect(parsed.chatId).toBe(42);
    expect(typeof parsed.time).toBe("string");
  });

  test("respects the minimum level", () => {
    const info: unknown[] = [];
    const warn: unknown[] = [];
    console.info = (...a: unknown[]) => info.push(a);
    console.warn = (...a: unknown[]) => warn.push(a);

    const log = createLogger({ level: "warn", format: "json" });
    log.info("dropped");
    log.warn("kept");

    expect(info).toHaveLength(0);
    expect(warn).toHaveLength(1);
  });
});

describe("logger contract", () => {
  test("child loggers inherit parent context and merge their own", () => {
    // Mirrors how the app derives per-component children from the root logger.
    const sink = new TestLoggingLibrary();
    const root = new LogLayer({ transport: new TestTransport({ logger: sink }) });
    root.withContext({ component: "root" });

    const child = root.child().withContext({ component: "ppm" });
    child.withMetadata({ args: ["read"] }).info("ran");

    const line = sink.getLastLine();
    const payload = line.data[0] as Record<string, unknown>;
    expect(payload.component).toBe("ppm");
    expect(payload.args).toEqual(["read"]);
  });
});

describe("nullLogger", () => {
  test("discards without throwing and supports the fluent chain", () => {
    expect(() =>
      nullLogger.child().withContext({ a: 1 }).withMetadata({ b: 2 }).info("noop"),
    ).not.toThrow();
  });
});
