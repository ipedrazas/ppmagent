/**
 * In-process metrics accumulator for key operational signals:
 * turn duration, token usage, tool error rates, and compaction events.
 *
 * All `record*` methods are synchronous and fire-and-forget: they update
 * in-memory state and emit a structured log line, but never throw. The
 * snapshot() method returns a plain object suitable for JSON serialisation.
 */
import { type Logger, nullLogger } from "../logger.ts";

/** Blended (input+output) estimated cost per 1M tokens, by provider → model. */
const COST_PER_1M: Record<string, Record<string, number>> = {
  anthropic: {
    "claude-sonnet-4-6": 6,
    "claude-opus-4-8": 30,
    "claude-haiku-4-5-20251001": 1.6,
    "claude-sonnet-4-7": 9,
  },
  deepseek: {
    "deepseek-v4-pro": 2,
    "deepseek-chat": 0.5,
  },
};

function lookupCostPer1M(provider: string, model: string): number {
  return COST_PER_1M[provider]?.[model] ?? 0;
}

export interface TurnRecord {
  durationMs: number;
  tokensBefore: number;
  tokensAfter: number;
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
    estimatedTotal: number;
    estimatedCostUsd: number;
  };
  tools: Record<string, { calls: number; errors: number; errorRate: number }>;
  compactions: { count: number; tokensReclaimed: number };
}

export class MetricsCollector {
  private readonly log: Logger;
  private readonly costPer1M: number;
  private readonly startedAt = performance.now();

  private turnTotal = 0;
  private turnErrored = 0;
  private totalDurationMs = 0;
  private maxDurationMs = 0;
  private estimatedTokensTotal = 0;

  private readonly toolStats: Record<string, { calls: number; errors: number }> = {};
  private compactionCount = 0;
  private tokensReclaimed = 0;

  constructor(opts: { logger?: Logger; provider?: string; model?: string } = {}) {
    this.log = (opts.logger ?? nullLogger).child().withContext({ component: "metrics" });
    this.costPer1M = lookupCostPer1M(opts.provider ?? "", opts.model ?? "");
  }

  recordTurn(rec: TurnRecord): void {
    this.turnTotal++;
    if (rec.error) this.turnErrored++;
    this.totalDurationMs += rec.durationMs;
    if (rec.durationMs > this.maxDurationMs) this.maxDurationMs = rec.durationMs;

    const tokensAdded = Math.max(0, rec.tokensAfter - rec.tokensBefore);
    this.estimatedTokensTotal += tokensAdded;
    const estimatedCostUsd = (tokensAdded / 1_000_000) * this.costPer1M;

    this.log
      .withMetadata({
        metric: "turn",
        durationMs: rec.durationMs,
        tokensBefore: rec.tokensBefore,
        tokensAfter: rec.tokensAfter,
        tokensAdded,
        estimatedCostUsd,
        error: rec.error ?? false,
      })
      .info("metric: turn");
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

  /** Current accumulated estimated session cost in USD. */
  sessionCostUsd(): number {
    return Math.round((this.estimatedTokensTotal / 1_000_000) * this.costPer1M * 10_000) / 10_000;
  }

  /**
   * Estimate the cost for a hypothetical turn's token delta without recording
   * it. Used by spend-limit enforcement before/during a turn.
   */
  estimateTurnCostUsd(tokensBefore: number, tokensAfter: number): number {
    const tokensAdded = Math.max(0, tokensAfter - tokensBefore);
    return (tokensAdded / 1_000_000) * this.costPer1M;
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
        estimatedTotal: this.estimatedTokensTotal,
        estimatedCostUsd:
          Math.round((this.estimatedTokensTotal / 1_000_000) * this.costPer1M * 10_000) / 10_000,
      },
      tools,
      compactions: { count: this.compactionCount, tokensReclaimed: this.tokensReclaimed },
    };
  }
}
