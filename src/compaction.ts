import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  DEFAULT_COMPACTION_SETTINGS,
  estimateContextTokens,
  generateSummary,
} from "@earendil-works/pi-agent-core";
import { type Model, type UserMessage, createModels } from "@earendil-works/pi-ai";

/**
 * Compaction policy + mechanism. The handover names `shouldCompactBeforeNextTurn`,
 * which pi does NOT export — we own the decision. After each turn the run loop
 * calls {@link maybeCompact}; when the transcript crosses the token threshold it
 * (1) flushes durable facts to memory, then (2) replaces the older transcript
 * with a summary, keeping a recent tail.
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
 * A summarizer backed by pi's `generateSummary` using the given model. Used in
 * production (the run loop); not exercised by tests since it needs a live model.
 */
export function makeModelSummarizer(model: Model<any>, models = createModels()): Summarizer {
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

/**
 * Replace all but the last `keepRecent` messages with a single summary message.
 * Returns the original array unchanged when there is nothing to compact.
 */
export async function compactTranscript(
  messages: AgentMessage[],
  summarize: Summarizer,
  keepRecent: number,
  signal?: AbortSignal,
): Promise<AgentMessage[]> {
  if (messages.length <= keepRecent) return messages;
  const cut = messages.length - keepRecent;
  const older = messages.slice(0, cut);
  const tail = messages.slice(cut);
  const summary = await summarize(older, signal);
  return [summaryMessage(summary), ...tail];
}

export interface MaybeCompactArgs {
  messages: AgentMessage[];
  policy: CompactionPolicy;
  summarize: Summarizer;
  /** Persist durable facts to memory before the transcript is summarized. */
  flush?: (signal?: AbortSignal) => Promise<void>;
  signal?: AbortSignal;
}

export interface CompactionOutcome {
  compacted: boolean;
  messages: AgentMessage[];
  tokensBefore: number;
  tokensAfter: number;
}

/**
 * Compact when over threshold: flush durable facts first, then summarize the
 * older transcript. The caller assigns `outcome.messages` back to the agent.
 */
export async function maybeCompact({
  messages,
  policy,
  summarize,
  flush,
  signal,
}: MaybeCompactArgs): Promise<CompactionOutcome> {
  const tokensBefore = contextTokens(messages);
  if (tokensBefore < resolveThreshold(policy.threshold)) {
    return { compacted: false, messages, tokensBefore, tokensAfter: tokensBefore };
  }
  if (flush) await flush(signal);
  const compacted = await compactTranscript(messages, summarize, policy.keepRecent, signal);
  return {
    compacted: true,
    messages: compacted,
    tokensBefore,
    tokensAfter: contextTokens(compacted),
  };
}
