/**
 * Child process for the durable-recovery tests: starts a turn on a file-backed
 * durable store and then DIES mid-tool-call (SIGKILL — no cleanup, no graceful
 * close), leaving whatever it had committed on disk for the parent to resume.
 *
 *   bun tests/support/crash-worker.ts <dbFile> <dir> <tool>
 *
 * `tool` is `probe` (read-only: safe to replay) or `charge` (a side effect that
 * must never run twice). The tool records each execution in `<dir>/<tool>.log`
 * and kills the process the first time it runs.
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  Type,
} from "@earendil-works/pi-ai";
import { DurableRuntime } from "../../src/runtime/runtime.ts";
import { type AppTool, defineTool, toolResult } from "../../src/tool-helpers.ts";

export function crashTool(name: string, dir: string, crashFirstRun: boolean): AppTool {
  const log = join(dir, `${name}.log`);
  return defineTool({
    name,
    description: `${name} (test tool that records its executions)`,
    label: name,
    parameters: Type.Object({}),
    execute: async () => {
      const runs = existsSync(log)
        ? readFileSync(log, "utf8").split("\n").filter(Boolean).length
        : 0;
      appendFileSync(log, `run ${runs + 1}\n`);
      if (crashFirstRun && runs === 0) process.kill(process.pid, "SIGKILL");
      return toolResult(`${name} ok (run ${runs + 1})`, {});
    },
  });
}

export function fauxModels() {
  const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }] });
  const models = createModels();
  models.setProvider(faux.provider);
  return { faux, models };
}

if (import.meta.main) {
  const [dbFile, dir, toolName] = process.argv.slice(2) as [string, string, string];
  const { faux, models } = fauxModels();
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall(toolName, {})], { stopReason: "toolUse" }),
    fauxAssistantMessage("unreachable: the process dies in the tool"),
  ]);
  const runtime = await DurableRuntime.open({
    dbFile,
    models,
    model: faux.getModel(),
    systemPrompt: "test",
    tools: [crashTool(toolName, dir, true)],
    mutatingTools: new Set(toolName === "charge" ? ["charge"] : []),
    retry: { maxRetries: 0 },
  });
  const conversation = await runtime.createConversation();
  writeFileSync(join(dir, "conversation"), String(conversation));
  // Never resolves: the tool kills this process first.
  await runtime.runTurn(conversation, "please run the tool", { requestId: "tg:5:77" });
  process.exit(3); // reaching this means the crash did not happen — the test will notice
}
