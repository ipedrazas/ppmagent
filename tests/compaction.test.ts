import { describe, expect, test } from "bun:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  COMPACTION_SENTINEL,
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

describe("maybeCompact", () => {
  test("replaces older messages with a summary and keeps the recent tail", async () => {
    const out = await maybeCompact({
      messages: transcript(10),
      policy: { threshold: 1, keepRecent: 3 },
      summarize: stub,
    });
    expect(out.compacted).toBe(true);
    expect(out.messages.length).toBe(4); // 1 summary + 3 kept
    const first = out.messages[0];
    expect(first && "content" in first ? String(first.content) : "").toContain(COMPACTION_SENTINEL);
    expect(first && "content" in first ? String(first.content) : "").toContain("SUMMARY");
    // tail preserved verbatim
    expect(out.messages[3]).toEqual(transcript(10)[9]);
  });

  test("over threshold but nothing to drop: no compaction, flush not called", async () => {
    let flushed = false;
    const input = transcript(2);
    const out = await maybeCompact({
      messages: input,
      policy: { threshold: 1, keepRecent: 5 },
      summarize: stub,
      flush: async () => {
        flushed = true;
      },
    });
    expect(out.compacted).toBe(false);
    expect(out.messages).toBe(input);
    expect(flushed).toBe(false);
  });

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

  test("over threshold: flushes the generated summary, then compacts", async () => {
    let flushedSummary: string | undefined;
    const out = await maybeCompact({
      messages: transcript(8),
      policy: { threshold: 1, keepRecent: 2 },
      summarize: stub,
      flush: async (summary) => {
        flushedSummary = summary;
      },
    });
    expect(flushedSummary).toBe("SUMMARY"); // memory keeps what the transcript keeps
    expect(out.compacted).toBe(true);
    expect(out.messages.length).toBe(3); // 1 summary + 2 kept
    expect(out.tokensAfter).toBeLessThan(out.tokensBefore);
  });

  test("a summarizer failure leaves the transcript untouched (error propagates)", async () => {
    let flushed = false;
    let error: unknown;
    try {
      await maybeCompact({
        messages: transcript(8),
        policy: { threshold: 1, keepRecent: 2 },
        summarize: async () => {
          throw new Error("model down");
        },
        flush: async () => {
          flushed = true;
        },
      });
    } catch (e) {
      error = e;
    }
    expect(String(error)).toContain("model down");
    expect(flushed).toBe(false); // nothing flushed, nothing dropped
  });
});

describe("placeholderSummarizer", () => {
  test("returns a non-empty note mentioning memory", async () => {
    const summary = await placeholderSummarizer(transcript(5));
    expect(summary).toContain("memory");
  });
});

describe("maybeCompact — extraTokens", () => {
  test("extraTokens are added to tokensBefore when not compacting", async () => {
    const input = transcript(4);
    const out = await maybeCompact({
      messages: input,
      policy: { threshold: 1_000_000_000, keepRecent: 2 },
      summarize: stub,
      extraTokens: 500,
    });
    expect(out.compacted).toBe(false);
    expect(out.tokensBefore).toBeGreaterThanOrEqual(500);
    expect(out.tokensAfter).toBe(out.tokensBefore);
  });

  test("extraTokens are added to both tokensBefore and tokensAfter when compacting", async () => {
    const out = await maybeCompact({
      messages: transcript(8),
      policy: { threshold: 1, keepRecent: 2 },
      summarize: stub,
      extraTokens: 300,
    });
    expect(out.compacted).toBe(true);
    // Both counts include the extra tokens.
    expect(out.tokensBefore).toBeGreaterThanOrEqual(300);
    expect(out.tokensAfter).toBeGreaterThanOrEqual(300);
    // The transcript shrank, so tokensAfter < tokensBefore even with extras.
    expect(out.tokensAfter).toBeLessThan(out.tokensBefore);
  });

  test("omitting extraTokens defaults to 0 (no regression)", async () => {
    const a = await maybeCompact({
      messages: transcript(8),
      policy: { threshold: 1, keepRecent: 2 },
      summarize: stub,
    });
    const b = await maybeCompact({
      messages: transcript(8),
      policy: { threshold: 1, keepRecent: 2 },
      summarize: stub,
      extraTokens: 0,
    });
    expect(a.tokensBefore).toBe(b.tokensBefore);
    expect(a.tokensAfter).toBe(b.tokensAfter);
  });
});
