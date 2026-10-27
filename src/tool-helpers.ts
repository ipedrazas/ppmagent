import type { Static, TextContent, TSchema } from "@earendil-works/pi-ai";

/** Wrap a string as a pi TextContent block. */
export function text(s: string): TextContent {
  return { type: "text", text: s };
}

/** What an app tool returns: model-visible `content`, UI/trace `details`, and loop control. */
export interface AppToolResult<D = unknown> {
  content: TextContent[];
  details: D;
  /** End the run without another model request (ask_user, confirmation gates). */
  terminate?: boolean;
}

/**
 * A ppmagent tool, independent of the agent runtime. The durable runtime wraps
 * each one into a pi-durable tool at the boundary (see `runtime/tools.ts`), so
 * tool bodies stay plain async functions that are trivial to unit-test.
 */
export interface AppTool<S extends TSchema = TSchema, D = unknown> {
  name: string;
  description: string;
  parameters: S;
  label: string;
  execute: (
    toolCallId: string,
    params: Static<S>,
    signal?: AbortSignal,
  ) => Promise<AppToolResult<D>>;
}

/** Build a successful tool result whose visible content is `message`. */
export function toolResult<T>(
  message: string,
  details: T,
  opts: { terminate?: boolean } = {},
): AppToolResult<T> {
  return { content: [text(message)], details, terminate: opts.terminate };
}

/**
 * Typed factory for an {@link AppTool}. Infers `execute`'s `params` from the
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
  ) => Promise<AppToolResult<D>>;
}): AppTool<S, D> {
  return def;
}
