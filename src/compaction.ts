import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  DEFAULT_COMPACTION_SETTINGS,
  estimateContextTokens,
  generateSummary,
} from "@earendil-works/pi-agent-core";
import type { Model, UserMessage } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";

/**
 * Compaction policy + mechanism. The handover names `shouldCompactBeforeNextTurn`,
 * which pi does NOT export — we own the decision. After each turn the run loop
 * calls {@link maybeCompact}; when the transcript crosses the token threshold it
 * (1) summarizes the older transcript, (2) flushes that summary to memory as a
 * durable checkpoint, then (3) replaces the older messages with the summary,
 * keeping a recent tail.
 *
 * The point (spike claim 4): durable facts already live in `ppm` and are
 * re-injected by `transformContext`, so a pre-compaction fact is still recalled
 * after the transcript is summarized away.
 */

export interface CompactionPolicy {
  /** Token threshold; 0 means use {@link DEFAULT_TOKEN_THRESHOLD}. */
  threshold: number;
  /** How many most-recent messages to keep verbatim after compaction. */
  keepRecent: number;
}

/** Conservative default when none is configured. Tune per the spike contract. */
export const DEFAULT_TOKEN_THRESHOLD = 120_000;
export const DEFAULT_KEEP_RECENT = 6;

/** Marks the synthetic summary message so it is identifiable in the transcript. */
export const COMPACTION_SENTINEL = "<!-- ppmagent:compaction-summary -->";

export function resolveThreshold(threshold: number): number {
  return threshold > 0 ? threshold : DEFAULT_TOKEN_THRESHOLD;
}

/** Estimated total context tokens for the current transcript. */
export function contextTokens(messages: AgentMessage[]): number {
  return estimateContextTokens(messages).tokens;
}

/** True when the transcript's estimated token count has crossed the threshold. */
export function shouldCompactNow(messages: AgentMessage[], policy: CompactionPolicy): boolean {
  return contextTokens(messages) >= resolveThreshold(policy.threshold);
}

/** Produces a prose summary of the older transcript that is dropped on compaction. */
export type Summarizer = (messages: AgentMessage[], signal?: AbortSignal) => Promise<string>;

/**
 * A model-free summarizer. Adequate for the PoC because durable knowledge lives
 * in `ppm`, not the transcript summary — the summary only needs to keep the
 * thread readable.
 */
export const placeholderSummarizer: Summarizer = async (messages) =>
  `${messages.length} earlier messages were compacted away. Durable facts (decisions, open questions, tasks) are preserved in project memory and re-injected each turn.`;

/**
 * A summarizer backed by pi's `generateSummary` using the given model. The
 * default `Models` collection is {@link builtinModels} (NOT the empty
 * `createModels()` — that has no providers registered and every call would
 * fail with "Unknown provider"); its providers resolve auth ambiently from the
 * provider's env var (e.g. ANTHROPIC_API_KEY), which config already requires
 * for the selected provider. Not exercised by tests: it needs a live model.
 */
export function makeModelSummarizer(model: Model<any>, models = builtinModels()): Summarizer {
  return async (messages, signal) => {
    const result = await generateSummary(
      messages,
      models,
      model,
      DEFAULT_COMPACTION_SETTINGS.reserveTokens,
      signal,
    );
    if (!result.ok) throw new Error("compaction summary generation failed");
    return result.value;
  };
}

function summaryMessage(summary: string): UserMessage {
  return {
    role: "user",
    content: `${COMPACTION_SENTINEL}\nConversation summary so far:\n${summary}`,
    timestamp: Date.now(),
  };
}

export interface MaybeCompactArgs {
  messages: AgentMessage[];
  policy: CompactionPolicy;
  summarize: Summarizer;
  /**
   * Persist the generated summary to memory as a durable checkpoint before the
   * older transcript is dropped. Receives the same summary text that replaces
   * the dropped messages, so what memory keeps is what the transcript keeps.
   */
  flush?: (summary: string, signal?: AbortSignal) => Promise<void>;
  signal?: AbortSignal;
  /**
   * Additional tokens not represented in `messages` — e.g. the ephemeral
   * memory-injection slice that `transformContext` prepends for every API call
   * but does not store in the transcript. Added to both `tokensBefore` and
   * `tokensAfter` so the compaction outcome reflects what the model actually
   * consumes.
   */
  extraTokens?: number;
}

export interface CompactionOutcome {
  compacted: boolean;
  messages: AgentMessage[];
  tokensBefore: number;
  tokensAfter: number;
}

/**
 * Compact when over threshold: summarize the older transcript, flush that
 * summary to memory, then replace the older messages with it (keeping the
 * `keepRecent` tail verbatim). Both the summary and the flush complete before
 * anything is dropped — a failure in either leaves the transcript untouched.
 * The caller assigns `outcome.messages` back to the agent.
 */
export async function maybeCompact({
  messages,
  policy,
  summarize,
  flush,
  signal,
  extraTokens = 0,
}: MaybeCompactArgs): Promise<CompactionOutcome> {
  const tokensBefore = contextTokens(messages) + extraTokens;
  if (
    tokensBefore < resolveThreshold(policy.threshold) ||
    messages.length <= policy.keepRecent // over threshold but nothing to drop
  ) {
    return { compacted: false, messages, tokensBefore, tokensAfter: tokensBefore };
  }
  const cut = messages.length - policy.keepRecent;
  const older = messages.slice(0, cut);
  const tail = messages.slice(cut);
  const summary = await summarize(older, signal);
  if (flush) await flush(summary, signal);
  const compacted = [summaryMessage(summary), ...tail];
  return {
    compacted: true,
    messages: compacted,
    tokensBefore,
    tokensAfter: contextTokens(compacted) + extraTokens,
  };
}
