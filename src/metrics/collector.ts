/**
 * In-process metrics accumulator for key operational signals:
 * turn duration, token usage, tool error rates, and compaction events.
 *
 * All `record*` methods are synchronous and fire-and-forget: they update
 * in-memory state and emit a structured log line, but never throw. The
 * snapshot() method returns a plain object suitable for JSON serialisation.
 */
import type { Usage } from "@earendil-works/pi-ai";
import { type Logger, nullLogger } from "../logger.ts";

export interface TurnRecord {
  durationMs: number;
  error?: boolean;
}

export interface MetricsSnapshot {
  uptimeMs: number;
  turns: {
    total: number;
    errored: number;
    durationMs: { avg: number; max: number; total: number };
  };
  tokens: {
    total: number;
    costUsd: number;
  };
  tools: Record<string, { calls: number; errors: number; errorRate: number }>;
  compactions: { count: number; tokensReclaimed: number };
}

export class MetricsCollector {
  private readonly log: Logger;
  private readonly startedAt = performance.now();

  private turnTotal = 0;
  private turnErrored = 0;
  private totalDurationMs = 0;
  private maxDurationMs = 0;
  private tokensTotal = 0;
  private costUsdTotal = 0;

  private readonly toolStats: Record<string, { calls: number; errors: number }> = {};
  private compactionCount = 0;
  private tokensReclaimed = 0;

  constructor(opts: { logger?: Logger } = {}) {
    this.log = (opts.logger ?? nullLogger).child().withContext({ component: "metrics" });
  }

  recordTurn(rec: TurnRecord): void {
    this.turnTotal++;
    if (rec.error) this.turnErrored++;
    this.totalDurationMs += rec.durationMs;
    if (rec.durationMs > this.maxDurationMs) this.maxDurationMs = rec.durationMs;

    this.log
      .withMetadata({ metric: "turn", durationMs: rec.durationMs, error: rec.error ?? false })
      .info("metric: turn");
  }

  /**
   * Accumulate one assistant response's provider-reported token usage and
   * cost (`AssistantMessage.usage`, already priced via the `Model`'s
   * per-token cost table) — the ground truth for spend, not an estimate.
   */
  recordUsage(usage: Usage): void {
    this.tokensTotal += usage.totalTokens;
    this.costUsdTotal += usage.cost.total;
    this.log
      .withMetadata({
        metric: "usage",
        totalTokens: usage.totalTokens,
        costUsd: usage.cost.total,
      })
      .info("metric: usage");
  }

  recordToolCall(toolName: string, isError: boolean): void {
    let s = this.toolStats[toolName];
    if (s === undefined) {
      s = { calls: 0, errors: 0 };
      this.toolStats[toolName] = s;
    }
    s.calls++;
    if (isError) {
      s.errors++;
      this.log
        .withMetadata({
          metric: "tool_error",
          tool: toolName,
          errors: s.errors,
          calls: s.calls,
          errorRate: s.calls > 0 ? s.errors / s.calls : 0,
        })
        .warn("metric: tool error");
    }
  }

  /** Current accumulated session cost in USD, from provider-reported usage. */
  sessionCostUsd(): number {
    return Math.round(this.costUsdTotal * 10_000) / 10_000;
  }

  recordCompaction(tokensBefore: number, tokensAfter: number): void {
    this.compactionCount++;
    const reclaimed = Math.max(0, tokensBefore - tokensAfter);
    this.tokensReclaimed += reclaimed;
    this.log
      .withMetadata({
        metric: "compaction",
        tokensBefore,
        tokensAfter,
        tokensReclaimed: reclaimed,
      })
      .info("metric: compaction");
  }

  snapshot(): MetricsSnapshot {
    const tools: MetricsSnapshot["tools"] = {};
    for (const [name, s] of Object.entries(this.toolStats)) {
      tools[name] = {
        calls: s.calls,
        errors: s.errors,
        errorRate: s.calls > 0 ? Math.round((s.errors / s.calls) * 1000) / 1000 : 0,
      };
    }
    return {
      uptimeMs: Math.round(performance.now() - this.startedAt),
      turns: {
        total: this.turnTotal,
        errored: this.turnErrored,
        durationMs: {
          avg: this.turnTotal > 0 ? Math.round(this.totalDurationMs / this.turnTotal) : 0,
          max: this.maxDurationMs,
          total: this.totalDurationMs,
        },
      },
      tokens: {
        total: this.tokensTotal,
        costUsd: this.sessionCostUsd(),
      },
      tools,
      compactions: { count: this.compactionCount, tokensReclaimed: this.tokensReclaimed },
    };
  }
}
