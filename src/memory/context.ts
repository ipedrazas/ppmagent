import type { Message, UserMessage } from "@earendil-works/pi-ai";
import { estimateContextTokens } from "@earendil-works/pi-ai/utils/estimate";
import { type Logger, nullLogger } from "../logger.ts";
import type { PpmClient } from "./ppm.ts";

/**
 * Marks the memory-injection message so it can be stripped and replaced on every
 * request (we never want two stale slices stacking up). The durable runtime
 * sends the slice for one request only and never stores it, so a stale one
 * should not normally reach this hook — stripping keeps the hook idempotent
 * regardless of its caller.
 */
const INJECTION_SENTINEL = "<!-- ppmagent:memory-context -->";

export interface TransformContextOptions {
  ppm: PpmClient;
  /** How many recent decisions to request from `ppm context`. */
  recent: number;
  /** Resolves the active project slug for the current turn (per Telegram chat). */
  getActiveProject: () => string | undefined;
  /** Logger for surfacing context-injection failures. Defaults to discarding. */
  logger?: Logger;
}

function isInjectedSlice(message: Message): boolean {
  return (
    message.role === "user" &&
    typeof message.content === "string" &&
    message.content.startsWith(INJECTION_SENTINEL)
  );
}

function injectedMessage(body: string): UserMessage {
  return {
    role: "user",
    content: `${INJECTION_SENTINEL}\n${body}`,
    timestamp: Date.now(),
  };
}

/** Return value of {@link makeTransformContext}. */
export interface MemoryContextHook {
  /** The request transform to pass to the durable runtime. */
  hook: (messages: readonly Message[], signal?: AbortSignal) => Promise<readonly Message[]>;
  /**
   * Estimated token count of the most recently injected memory slice, or 0 if
   * no slice was injected (no active project, or injection failed). Callers add
   * this to `contextTokens(messages)` to account for tokens the model sees but
   * that are not stored in the durable transcript.
   */
  sliceTokens(): number;
}

/**
 * Build the request transform for the durable runtime (its `beforeRequest`
 * hook). Before every model request it strips any prior injected slice, asks
 * `ppm context` for the shape-aware slice of the active project and prepends it
 * as a single sentinel-tagged user message. With no active project it leaves the
 * request untouched.
 */
export function makeTransformContext(opts: TransformContextOptions): MemoryContextHook {
  const log = (opts.logger ?? nullLogger).child().withContext({ component: "context" });
  let lastSliceTokens = 0;

  const hook = async (
    messages: readonly Message[],
    signal?: AbortSignal,
  ): Promise<readonly Message[]> => {
    const withoutPrior = messages.filter((m) => !isInjectedSlice(m));

    const project = opts.getActiveProject();
    if (!project) {
      lastSliceTokens = 0;
      return withoutPrior;
    }

    try {
      const env = await opts.ppm.context(project, opts.recent, signal);
      const injected = injectedMessage(env.message);
      lastSliceTokens = estimateContextTokens([injected]).tokens;
      return [injected, ...withoutPrior];
    } catch (error) {
      // Memory-read failure must not break the turn — degrade gracefully without
      // the context slice, but surface the error so it is not silently swallowed.
      log
        .withError(error)
        .withMetadata({ project })
        .warn("context injection failed; proceeding without slice");
      lastSliceTokens = 0;
      return withoutPrior;
    }
  };

  return { hook, sliceTokens: () => lastSliceTokens };
}
