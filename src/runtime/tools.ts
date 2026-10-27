import type { JsonValue } from "@earendil-works/chord";
import { defineTool as defineDurableTool, type ToolRegistration } from "@earendil-works/pi-durable";
import type { AppTool } from "../tool-helpers.ts";

/** `details` of every ppmagent tool result as stored in the durable transcript. */
export interface StoredToolDetails {
  /** The tool ended the run (ask_user, confirmation gate): its text is the reply. */
  terminate: boolean;
  /** The tool's own details, coerced to JSON. */
  data: JsonValue;
}

/** Narrow a stored tool-result `details` value, tolerating foreign shapes. */
export function readToolDetails(details: unknown): StoredToolDetails | undefined {
  if (details && typeof details === "object" && "terminate" in details) {
    return details as StoredToolDetails;
  }
  return undefined;
}

/** Coerce arbitrary tool details to JSON — durable commits only JSON values. */
function toJson(value: unknown): JsonValue {
  if (value === undefined) return null;
  try {
    return JSON.parse(JSON.stringify(value)) as JsonValue;
  } catch {
    return null;
  }
}

/**
 * Wrap an {@link AppTool} as a pi-durable tool.
 *
 * - `replay` is the recovery contract: when the process dies *while a tool is
 *   executing*, a `safe` tool is simply run again on resume, while an `unsafe`
 *   one is NOT re-run (the model is told the call was interrupted and decides
 *   what to do). State-writing tools (tracker/memory writes, git, dispatch) are
 *   `unsafe` so a crash can never double-apply a side effect.
 * - A thrown error becomes an error tool result the model can react to, exactly
 *   as before — it must not fault the durable task.
 */
export function toDurableTool(tool: AppTool, mutating: boolean): ToolRegistration {
  return defineDurableTool({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    replay: mutating ? "unsafe" : "safe",
    execute: async (args, api, context) => {
      try {
        const result = await tool.execute(api.callId, args, context.abortSignal);
        const details: StoredToolDetails = {
          terminate: result.terminate === true,
          data: toJson(result.details),
        };
        return {
          output: result.content,
          details: details as unknown as JsonValue,
          control: result.terminate ? { terminate: true } : undefined,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const details: StoredToolDetails = { terminate: false, data: null };
        return {
          output: [{ type: "text", text: message }],
          isError: true,
          details: details as unknown as JsonValue,
        };
      }
    },
  });
}
