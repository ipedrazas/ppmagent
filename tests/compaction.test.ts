import { describe, expect, test } from "bun:test";
import type { Model } from "@earendil-works/pi-ai";
import { DEFAULT_TOKEN_THRESHOLD, resolveThreshold } from "../src/compaction.ts";
import { DEFAULT_COMPACTION_THRESHOLD, reserveTokensFor } from "../src/runtime/runtime.ts";

const model = (contextWindow: number): Model<any> => ({ contextWindow }) as Model<any>;

describe("resolveThreshold", () => {
  test("uses the configured threshold when positive", () => {
    expect(resolveThreshold(50_000)).toBe(50_000);
  });

  test("falls back to the default for 0 or negative", () => {
    expect(resolveThreshold(0)).toBe(DEFAULT_TOKEN_THRESHOLD);
    expect(resolveThreshold(-1)).toBe(DEFAULT_TOKEN_THRESHOLD);
  });

  test("the runtime and policy defaults agree", () => {
    expect(DEFAULT_COMPACTION_THRESHOLD).toBe(DEFAULT_TOKEN_THRESHOLD);
  });
});

describe("reserveTokensFor — maps a token threshold onto durable's reserve", () => {
  test("compaction triggers at contextWindow - reserve == threshold", () => {
    expect(200_000 - reserveTokensFor(model(200_000), 150_000)).toBe(150_000);
  });

  test("0 uses the default threshold", () => {
    expect(200_000 - reserveTokensFor(model(200_000), 0)).toBe(DEFAULT_TOKEN_THRESHOLD);
  });

  test("a threshold above the window still leaves room for the answer", () => {
    const reserve = reserveTokensFor(model(100_000), 500_000);
    expect(reserve).toBeGreaterThan(0);
    expect(reserve).toBeLessThan(100_000);
  });

  test("a threshold near zero never collapses the reserve below a floor", () => {
    expect(reserveTokensFor(model(100_000), 99_999)).toBeGreaterThanOrEqual(2_048);
  });
});
