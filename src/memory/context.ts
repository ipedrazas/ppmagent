import type { Message, UserMessage } from "@earendil-works/pi-ai";
import { estimateContextTokens } from "@earendil-works/pi-ai/utils/estimate";
import { type Logger, nullLogger } from "../logger.ts";
import type { PpmClient } from "./ppm.ts";

/**
 * Marks the memory-injection message. The slice is request-scoped (the durable
 * runtime sends it for one model request and never stores it), so nothing has to
 * strip a stale one — the sentinel only makes it recognisable in provider logs.
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
 * hook). Before every model request it asks `ppm context` for the shape-aware
 * slice of the active project and prepends it as a single sentinel-tagged user
 * message. With no active project it leaves the request untouched.
 */
export function makeTransformContext(opts: TransformContextOptions): MemoryContextHook {
  const log = (opts.logger ?? nullLogger).child().withContext({ component: "context" });
  let lastSliceTokens = 0;

  const hook = async (
    messages: readonly Message[],
    signal?: AbortSignal,
  ): Promise<readonly Message[]> => {
    const project = opts.getActiveProject();
    if (!project) {
      lastSliceTokens = 0;
      return messages;
    }

    try {
      const env = await opts.ppm.context(project, opts.recent, signal);
      const injected = injectedMessage(env.message);
      lastSliceTokens = estimateContextTokens([injected]).tokens;
      return [injected, ...messages];
    } catch (error) {
      // Memory-read failure must not break the turn — degrade gracefully without
      // the context slice, but surface the error so it is not silently swallowed.
      log
        .withError(error)
        .withMetadata({ project })
        .warn("context injection failed; proceeding without slice");
      lastSliceTokens = 0;
      return messages;
    }
  };

  return { hook, sliceTokens: () => lastSliceTokens };
}
