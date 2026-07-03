import { describe, expect, test } from "bun:test";
import { MetricsCollector } from "../src/metrics/collector.ts";

describe("MetricsCollector.snapshot — initial state", () => {
  test("returns zero counts when nothing recorded", () => {
    const c = new MetricsCollector();
    const s = c.snapshot();
    expect(s.turns.total).toBe(0);
    expect(s.turns.errored).toBe(0);
    expect(s.turns.durationMs.avg).toBe(0);
    expect(s.turns.durationMs.max).toBe(0);
    expect(s.turns.durationMs.total).toBe(0);
    expect(s.tokens.estimatedTotal).toBe(0);
    expect(s.tokens.estimatedCostUsd).toBe(0);
    expect(s.tools).toEqual({});
    expect(s.compactions.count).toBe(0);
    expect(s.compactions.tokensReclaimed).toBe(0);
  });

  test("uptimeMs is non-negative", () => {
    const c = new MetricsCollector();
    expect(c.snapshot().uptimeMs).toBeGreaterThanOrEqual(0);
  });
});

describe("MetricsCollector.recordTurn", () => {
  test("accumulates turn count and duration", () => {
    const c = new MetricsCollector();
    c.recordTurn({ durationMs: 100, tokensBefore: 1000, tokensAfter: 1100 });
    c.recordTurn({ durationMs: 300, tokensBefore: 1100, tokensAfter: 1250 });
    const s = c.snapshot();
    expect(s.turns.total).toBe(2);
    expect(s.turns.durationMs.total).toBe(400);
    expect(s.turns.durationMs.avg).toBe(200);
    expect(s.turns.durationMs.max).toBe(300);
  });

  test("tracks errored turns separately", () => {
    const c = new MetricsCollector();
    c.recordTurn({ durationMs: 50, tokensBefore: 0, tokensAfter: 0 });
    c.recordTurn({ durationMs: 50, tokensBefore: 0, tokensAfter: 0, error: true });
    const s = c.snapshot();
    expect(s.turns.total).toBe(2);
    expect(s.turns.errored).toBe(1);
  });

  test("accumulates estimated tokens from context delta", () => {
    const c = new MetricsCollector();
    c.recordTurn({ durationMs: 10, tokensBefore: 500, tokensAfter: 700 });
    c.recordTurn({ durationMs: 10, tokensBefore: 700, tokensAfter: 1000 });
    expect(c.snapshot().tokens.estimatedTotal).toBe(500);
  });

  test("negative token delta is clamped to zero", () => {
    const c = new MetricsCollector();
    // tokensAfter < tokensBefore can happen when compaction runs mid-turn
    c.recordTurn({ durationMs: 10, tokensBefore: 1000, tokensAfter: 500 });
    expect(c.snapshot().tokens.estimatedTotal).toBe(0);
  });

  test("computes cost for known anthropic model", () => {
    const c = new MetricsCollector({ provider: "anthropic", model: "claude-sonnet-4-6" });
    // 1M tokens at $6/M = $6
    c.recordTurn({ durationMs: 10, tokensBefore: 0, tokensAfter: 1_000_000 });
    expect(c.snapshot().tokens.estimatedCostUsd).toBe(6);
  });

  test("cost is zero for unknown provider/model", () => {
    const c = new MetricsCollector({ provider: "unknown", model: "unknown-model" });
    c.recordTurn({ durationMs: 10, tokensBefore: 0, tokensAfter: 1_000_000 });
    expect(c.snapshot().tokens.estimatedCostUsd).toBe(0);
  });
});

describe("MetricsCollector.recordToolCall", () => {
  test("tracks calls and errors per tool", () => {
    const c = new MetricsCollector();
    c.recordToolCall("memory_list", false);
    c.recordToolCall("memory_list", false);
    c.recordToolCall("memory_list", true);
    const s = c.snapshot();
    expect(s.tools["memory_list"]?.calls).toBe(3);
    expect(s.tools["memory_list"]?.errors).toBe(1);
  });

  test("computes error rate correctly", () => {
    const c = new MetricsCollector();
    c.recordToolCall("tracker_create_task", true);
    c.recordToolCall("tracker_create_task", false);
    expect(c.snapshot().tools["tracker_create_task"]?.errorRate).toBe(0.5);
  });

  test("tracks multiple tools independently", () => {
    const c = new MetricsCollector();
    c.recordToolCall("tool_a", false);
    c.recordToolCall("tool_b", true);
    const s = c.snapshot();
    expect(s.tools["tool_a"]?.calls).toBe(1);
    expect(s.tools["tool_b"]?.errors).toBe(1);
  });

  test("error rate is 0 when no errors", () => {
    const c = new MetricsCollector();
    c.recordToolCall("memory_read", false);
    expect(c.snapshot().tools["memory_read"]?.errorRate).toBe(0);
  });
});

describe("MetricsCollector.recordCompaction", () => {
  test("counts compactions and accumulates tokens reclaimed", () => {
    const c = new MetricsCollector();
    c.recordCompaction(120_000, 8_000);
    c.recordCompaction(130_000, 9_000);
    const s = c.snapshot();
    expect(s.compactions.count).toBe(2);
    expect(s.compactions.tokensReclaimed).toBe(112_000 + 121_000);
  });

  test("tokens reclaimed is clamped to zero when tokensAfter >= tokensBefore", () => {
    const c = new MetricsCollector();
    c.recordCompaction(5_000, 6_000);
    expect(c.snapshot().compactions.tokensReclaimed).toBe(0);
  });
});
