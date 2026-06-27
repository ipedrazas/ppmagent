import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { UserMessage } from "@earendil-works/pi-ai";
import type { PpmClient } from "./ppm.ts";

/**
 * Marks the single memory-injection message so it can be stripped and replaced
 * each turn (we never want two stale slices stacking up).
 */
const INJECTION_SENTINEL = "<!-- ppmagent:memory-context -->";

export interface TransformContextOptions {
  ppm: PpmClient;
  /** How many recent decisions to request from `ppm context`. */
  recent: number;
  /** Resolves the active project slug for the current turn (per Telegram chat). */
  getActiveProject: () => string | undefined;
}

function isInjectedSlice(message: AgentMessage): boolean {
  return (
    "role" in message &&
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

/**
 * Build the pi `transformContext` hook. Each turn it strips any prior injected
 * slice, asks `ppm context` for the shape-aware slice of the active project,
 * and prepends it as a single sentinel-tagged user message. With no active
 * project it leaves the transcript untouched.
 */
export function makeTransformContext(opts: TransformContextOptions) {
  return async (messages: AgentMessage[], signal?: AbortSignal): Promise<AgentMessage[]> => {
    const withoutPrior = messages.filter((m) => !isInjectedSlice(m));

    const project = opts.getActiveProject();
    if (!project) return withoutPrior;

    try {
      const env = await opts.ppm.context(project, opts.recent, signal);
      return [injectedMessage(env.message), ...withoutPrior];
    } catch {
      // A memory-read failure must not break the turn; proceed without the slice.
      return withoutPrior;
    }
  };
}
