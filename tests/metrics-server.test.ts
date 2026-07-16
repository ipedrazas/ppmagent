import { describe, expect, test } from "bun:test";
import { MetricsCollector } from "../src/metrics/collector.ts";
import { handleMetricsRequest } from "../src/metrics/server.ts";

function makeRequest(path: string, method = "GET"): Request {
  return new Request(`http://localhost${path}`, { method });
}

describe("handleMetricsRequest", () => {
  test("GET /metrics returns 200 with JSON snapshot", async () => {
    const collector = new MetricsCollector();
    collector.recordTurn({ durationMs: 42 });
    const res = handleMetricsRequest(makeRequest("/metrics"), collector);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(typeof body.turns).toBe("object");
    expect(typeof body.tokens).toBe("object");
    expect(typeof body.tools).toBe("object");
    expect(typeof body.compactions).toBe("object");
    expect(typeof body.uptimeMs).toBe("number");
  });

  test("GET /metrics reflects recorded data", async () => {
    const collector = new MetricsCollector();
    collector.recordTurn({ durationMs: 100 });
    collector.recordUsage({
      input: 500,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 500,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    });
    const res = handleMetricsRequest(makeRequest("/metrics"), collector);
    const body = (await res.json()) as {
      turns: { total: number };
      tokens: { total: number };
    };
    expect(body.turns.total).toBe(1);
    expect(body.tokens.total).toBe(500);
  });

  test("returns 404 for unknown paths", () => {
    const collector = new MetricsCollector();
    const res = handleMetricsRequest(makeRequest("/health"), collector);
    expect(res.status).toBe(404);
  });

  test("returns 405 for non-GET methods", () => {
    const collector = new MetricsCollector();
    const res = handleMetricsRequest(makeRequest("/metrics", "POST"), collector);
    expect(res.status).toBe(405);
  });

  test("returns 405 for DELETE", () => {
    const collector = new MetricsCollector();
    const res = handleMetricsRequest(makeRequest("/metrics", "DELETE"), collector);
    expect(res.status).toBe(405);
  });
});
