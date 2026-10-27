import {
  type AssistantMessage,
  createModels,
  type FauxProviderHandle,
  fauxAssistantMessage,
  fauxProvider,
  type TextContent,
  type ToolCall,
  Type,
} from "@earendil-works/pi-ai";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { type BuildAgentOverrides, type BuiltAgent, buildAgent } from "../../src/agent.ts";
import type { Config } from "../../src/config.ts";
import { defineTool, toolResult } from "../../src/tool-helpers.ts";

export interface FauxAgent {
  built: BuiltAgent;
  faux: FauxProviderHandle;
  /** Close the durable store (the in-memory one is discarded). */
  close: () => Promise<void>;
}

/**
 * A real `buildAgent` on a real pi-durable runtime, with pi's faux provider as
 * the model and an in-memory store. Deterministic and key-free, but exercises
 * the genuine submit → generate → tool → settle path rather than a mock of it.
 * Provider retries are off so a scripted failure surfaces immediately.
 */
export async function makeFauxAgent(
  config: Config,
  overrides: Partial<BuildAgentOverrides> & {
    project?: () => string | undefined;
    /** $/million-token prices of the faux model; usage cost is derived from these, not scripted. */
    cost?: { input: number; output: number };
    /** Reuse an existing faux provider (e.g. across a simulated restart). */
    faux?: FauxProviderHandle;
  } = {},
): Promise<FauxAgent> {
  const { cost, project, faux: given, ...buildOverrides } = overrides;
  const faux =
    given ??
    fauxProvider({
      provider: "faux",
      models: [
        {
          id: "faux-1",
          ...(cost
            ? { cost: { input: cost.input, output: cost.output, cacheRead: 0, cacheWrite: 0 } }
            : {}),
        },
      ],
    });
  const models = createModels();
  models.setProvider(faux.provider);
  const built = await buildAgent(config, project ?? (() => undefined), {
    model: faux.getModel(),
    models,
    storage: new MemoryStorage(),
    retry: { maxRetries: 0 },
    ...buildOverrides,
  });
  return { built, faux, close: () => built.runtime.close() };
}

/**
 * An assistant message that calls tools. pi-durable runs the tool round only
 * when the provider reports `stopReason: "toolUse"` (real providers do; the faux
 * provider defaults to "stop"), so scripted tool calls must say so.
 */
export function fauxToolTurn(...blocks: (TextContent | ToolCall)[]): AssistantMessage {
  return fauxAssistantMessage(blocks, { stopReason: "toolUse" });
}

/** Text of the newest user message in a faux-provider request context. */
export function lastUserText(context: {
  messages: readonly { role: string; content: unknown }[];
}): string {
  for (let i = context.messages.length - 1; i >= 0; i--) {
    const m = context.messages[i];
    if (m?.role !== "user") continue;
    if (typeof m.content === "string") return m.content;
    return (m.content as { type: string; text?: string }[])
      .filter((c) => c.type === "text")
      .map((c) => c.text ?? "")
      .join("");
  }
  return "";
}

/** A scripted tool for tests that need a tool the real set does not have. */
export function scriptedTool(
  name: string,
  run: (params: Record<string, unknown>) => { text: string; terminate?: boolean; fail?: boolean },
) {
  return defineTool({
    name,
    description: `scripted ${name}`,
    label: name,
    parameters: Type.Object({}, { additionalProperties: true }),
    execute: async (_id, params) => {
      const out = run(params as Record<string, unknown>);
      if (out.fail) throw new Error(out.text);
      return toolResult(out.text, {}, { terminate: out.terminate });
    },
  });
}
