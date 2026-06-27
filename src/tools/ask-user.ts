import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import type { PpmClient } from "../memory/ppm.ts";
import { defineTool, toolResult } from "../tool-helpers.ts";

/**
 * The clarify-and-stop tool. When scope is unclear the agent calls `ask_user`,
 * which (a) records the question as an OPEN question in memory so it survives
 * compaction and reappears in the next injected slice, and (b) returns
 * `terminate: true` to end the turn. Over Telegram this is "send the question,
 * wait for the next inbound message". One question per request — enforced by
 * the system prompt.
 *
 * Caveat: pi only stops the loop if EVERY finalized tool result in the batch
 * sets `terminate: true`, so the prompt must forbid batching other tools with
 * `ask_user`.
 */
export function buildAskUserTool(ppm: PpmClient): AgentTool {
  return defineTool({
    name: "ask_user",
    description:
      "Ask the user ONE clarifying question when a request is under-specified (missing acceptance criteria, target metric, or owner). Records it as an open question and stops the turn to wait for the reply. Never batch with other tools.",
    label: "Ask user",
    parameters: Type.Object({
      question: Type.String(),
      project: Type.Optional(
        Type.String({ description: "Project to attach the open question to." }),
      ),
    }),
    execute: async (_id, params, signal) => {
      if (params.project) {
        await ppm.run(["question", "add", params.project, "--content", params.question], signal);
      }
      return toolResult(params.question, { question: params.question }, { terminate: true });
    },
  });
}
