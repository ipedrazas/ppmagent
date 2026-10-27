/**
 * Compaction policy. The mechanism lives in pi-durable: a conversation whose
 * context nears `contextWindow - reserveTokens` is summarized by a durable
 * compaction task (checkpointed and retried like any other task), and the
 * summary replaces the older entries while a recent tail stays verbatim. We own
 * only the threshold ({@link resolveThreshold}, mapped to a reserve in
 * `runtime/runtime.ts`) and the memory checkpoint written when a summary lands
 * (see `agent.ts`).
 *
 * The point (spike claim 4) is unchanged: durable facts already live in `ppm`
 * and are re-injected before every request, so a pre-compaction fact is still
 * recalled after the transcript is summarized away.
 */

/** Conservative default when none is configured. Tune per the spike contract. */
export const DEFAULT_TOKEN_THRESHOLD = 120_000;

export function resolveThreshold(threshold: number): number {
  return threshold > 0 ? threshold : DEFAULT_TOKEN_THRESHOLD;
}

/** Marks a compaction summary that was flushed to project memory. */
export const COMPACTION_SENTINEL = "<!-- ppmagent:compaction-summary -->";
