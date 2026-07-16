import { describe, expect, test } from "bun:test";
import type { Usage } from "@earendil-works/pi-ai";
import { MetricsCollector } from "../src/metrics/collector.ts";

function usage(totalTokens: number, costTotal: number): Usage {
  return {
    input: totalTokens,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens,
    cost: { input: costTotal, output: 0, cacheRead: 0, cacheWrite: 0, total: costTotal },
  };
}

describe("MetricsCollector.snapshot — initial state", () => {
  test("returns zero counts when nothing recorded", () => {
    const c = new MetricsCollector();
    const s = c.snapshot();
    expect(s.turns.total).toBe(0);
    expect(s.turns.errored).toBe(0);
    expect(s.turns.durationMs.avg).toBe(0);
    expect(s.turns.durationMs.max).toBe(0);
    expect(s.turns.durationMs.total).toBe(0);
    expect(s.tokens.total).toBe(0);
    expect(s.tokens.costUsd).toBe(0);
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
    c.recordTurn({ durationMs: 100 });
    c.recordTurn({ durationMs: 300 });
    const s = c.snapshot();
    expect(s.turns.total).toBe(2);
    expect(s.turns.durationMs.total).toBe(400);
    expect(s.turns.durationMs.avg).toBe(200);
    expect(s.turns.durationMs.max).toBe(300);
  });

  test("tracks errored turns separately", () => {
    const c = new MetricsCollector();
    c.recordTurn({ durationMs: 50 });
    c.recordTurn({ durationMs: 50, error: true });
    const s = c.snapshot();
    expect(s.turns.total).toBe(2);
    expect(s.turns.errored).toBe(1);
  });
});

describe("MetricsCollector.recordUsage", () => {
  test("accumulates provider-reported tokens and cost", () => {
    const c = new MetricsCollector();
    c.recordUsage(usage(500, 0.003));
    c.recordUsage(usage(300, 0.0018));
    const s = c.snapshot();
    expect(s.tokens.total).toBe(800);
    expect(s.tokens.costUsd).toBeCloseTo(0.0048, 6);
  });

  test("cost is exactly what the provider/model reported — no re-derivation", () => {
    const c = new MetricsCollector();
    // A model-specific price the collector never sees directly — it just sums
    // what usage.cost.total already carries.
    c.recordUsage(usage(1_000_000, 12.5));
    expect(c.snapshot().tokens.costUsd).toBe(12.5);
  });
});

describe("MetricsCollector.recordToolCall", () => {
  test("tracks calls and errors per tool", () => {
    const c = new MetricsCollector();
    c.recordToolCall("memory_list", false);
    c.recordToolCall("memory_list", false);
    c.recordToolCall("memory_list", true);
    const s = c.snapshot();
    expect(s.tools.memory_list?.calls).toBe(3);
    expect(s.tools.memory_list?.errors).toBe(1);
  });

  test("computes error rate correctly", () => {
    const c = new MetricsCollector();
    c.recordToolCall("tracker_create_task", true);
    c.recordToolCall("tracker_create_task", false);
    expect(c.snapshot().tools.tracker_create_task?.errorRate).toBe(0.5);
  });

  test("tracks multiple tools independently", () => {
    const c = new MetricsCollector();
    c.recordToolCall("tool_a", false);
    c.recordToolCall("tool_b", true);
    const s = c.snapshot();
    expect(s.tools.tool_a?.calls).toBe(1);
    expect(s.tools.tool_b?.errors).toBe(1);
  });

  test("error rate is 0 when no errors", () => {
    const c = new MetricsCollector();
    c.recordToolCall("memory_read", false);
    expect(c.snapshot().tools.memory_read?.errorRate).toBe(0);
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

describe("MetricsCollector.sessionCostUsd", () => {
  test("returns 0 with no recorded usage", () => {
    const c = new MetricsCollector();
    expect(c.sessionCostUsd()).toBe(0);
  });

  test("accumulates cost across recorded usage", () => {
    const c = new MetricsCollector();
    c.recordUsage(usage(500_000, 3));
    expect(c.sessionCostUsd()).toBe(3);
    c.recordUsage(usage(500_000, 3));
    expect(c.sessionCostUsd()).toBe(6);
  });
});
