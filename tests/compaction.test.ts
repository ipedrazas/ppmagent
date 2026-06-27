import { describe, expect, test } from "bun:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  COMPACTION_SENTINEL,
  compactTranscript,
  maybeCompact,
  placeholderSummarizer,
  resolveThreshold,
  shouldCompactNow,
} from "../src/compaction.ts";

const msg = (text: string, i: number): AgentMessage => ({
  role: "user",
  content: text,
  timestamp: i,
});
const transcript = (n: number): AgentMessage[] =>
  Array.from({ length: n }, (_, i) => msg(`message number ${i} with some words`, i));

const stub = async () => "SUMMARY";

describe("resolveThreshold", () => {
  test("0 falls back to the default", () => {
    expect(resolveThreshold(0)).toBeGreaterThan(0);
  });
  test("a positive value is used as-is", () => {
    expect(resolveThreshold(5000)).toBe(5000);
  });
});

describe("shouldCompactNow", () => {
  test("true when over a tiny threshold", () => {
    expect(shouldCompactNow(transcript(3), { threshold: 1, keepRecent: 2 })).toBe(true);
  });
  test("false when under a huge threshold", () => {
    expect(shouldCompactNow(transcript(3), { threshold: 1_000_000_000, keepRecent: 2 })).toBe(
      false,
    );
  });
});

describe("compactTranscript", () => {
  test("replaces older messages with a summary and keeps the recent tail", async () => {
    const out = await compactTranscript(transcript(10), stub, 3);
    expect(out.length).toBe(4); // 1 summary + 3 kept
    const first = out[0];
    expect(first && "content" in first ? String(first.content) : "").toContain(COMPACTION_SENTINEL);
    expect(first && "content" in first ? String(first.content) : "").toContain("SUMMARY");
    // tail preserved verbatim
    expect(out[3]).toEqual(transcript(10)[9]);
  });

  test("no-op when there is nothing to compact", async () => {
    const input = transcript(2);
    expect(await compactTranscript(input, stub, 5)).toBe(input);
  });
});

describe("maybeCompact", () => {
  test("below threshold: no compaction, flush not called", async () => {
    let flushed = false;
    const input = transcript(4);
    const out = await maybeCompact({
      messages: input,
      policy: { threshold: 1_000_000_000, keepRecent: 2 },
      summarize: stub,
      flush: async () => {
        flushed = true;
      },
    });
    expect(out.compacted).toBe(false);
    expect(out.messages).toBe(input);
    expect(flushed).toBe(false);
  });

  test("over threshold: flushes then compacts", async () => {
    let flushed = false;
    const out = await maybeCompact({
      messages: transcript(8),
      policy: { threshold: 1, keepRecent: 2 },
      summarize: stub,
      flush: async () => {
        flushed = true;
      },
    });
    expect(flushed).toBe(true);
    expect(out.compacted).toBe(true);
    expect(out.messages.length).toBe(3); // 1 summary + 2 kept
    expect(out.tokensAfter).toBeLessThan(out.tokensBefore);
  });
});

describe("placeholderSummarizer", () => {
  test("returns a non-empty note mentioning memory", async () => {
    const summary = await placeholderSummarizer(transcript(5));
    expect(summary).toContain("memory");
  });
});
