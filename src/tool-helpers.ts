import type {
  AgentTool,
  AgentToolResult,
  AgentToolUpdateCallback,
} from "@earendil-works/pi-agent-core";
import type { Static, TSchema, TextContent } from "@earendil-works/pi-ai";

/** Wrap a string as a pi TextContent block. */
export function text(s: string): TextContent {
  return { type: "text", text: s };
}

/** Build a successful tool result whose visible content is `message`. */
export function toolResult<T>(
  message: string,
  details: T,
  opts: { terminate?: boolean } = {},
): AgentToolResult<T> {
  return { content: [text(message)], details, terminate: opts.terminate };
}

/**
 * Typed factory for an {@link AgentTool}. Infers `execute`'s `params` from the
 * `parameters` schema so call sites stay type-safe without manual generics.
 */
export function defineTool<S extends TSchema, D = unknown>(def: {
  name: string;
  description: string;
  parameters: S;
  label: string;
  execute: (
    toolCallId: string,
    params: Static<S>,
    signal?: AbortSignal,
    onUpdate?: AgentToolUpdateCallback<D>,
  ) => Promise<AgentToolResult<D>>;
}): AgentTool<S, D> {
  return def;
}
