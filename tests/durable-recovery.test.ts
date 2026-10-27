/**
 * The point of the pi-durable migration: a turn survives the process dying.
 *
 * Each test spawns `tests/support/crash-worker.ts`, which starts a turn on a
 * file-backed durable store and SIGKILLs itself in the middle of a tool call.
 * The parent then reopens the SAME store file — a restart — and checks that the
 * turn finishes from its last checkpoint instead of being lost or repeated.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { DurableRuntime } from "../src/runtime/runtime.ts";
import { ChatSession } from "../src/telegram/chat-session.ts";
import type { TelegramClient } from "../src/telegram/client.ts";
import { TurnRunner } from "../src/telegram/turn-runner.ts";
import { makeTestConfig } from "./support/config.ts";
import { crashTool, fauxModels } from "./support/crash-worker.ts";
import { makeFauxAgent } from "./support/faux-agent.ts";

let dir: string;
let dbFile: string;
const runtimes: DurableRuntime[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ppmagent-recovery-"));
  dbFile = join(dir, "durable.sqlite");
});
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((r) => r.close()));
  rmSync(dir, { recursive: true, force: true });
});

/** Run the worker to its death; returns once the process is gone. */
async function crashWorker(tool: "probe" | "charge"): Promise<void> {
  const proc = Bun.spawn(
    ["bun", join(import.meta.dir, "support/crash-worker.ts"), dbFile, dir, tool],
    {
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const code = await proc.exited;
  // SIGKILL → 137 (128+9) / signalCode set. Anything else means the crash never happened.
  expect(proc.signalCode === "SIGKILL" || code === 137).toBe(true);
}

const executions = (tool: string): number => {
  const log = join(dir, `${tool}.log`);
  return existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean).length : 0;
};

/** Reopen the store after the crash, WITHOUT resuming, so the aftermath can be inspected first. */
async function reopen(
  tool: "probe" | "charge",
  responses: Parameters<ReturnType<typeof fauxModels>["faux"]["setResponses"]>[0],
) {
  const { faux, models } = fauxModels();
  faux.setResponses(responses);
  const runtime = await DurableRuntime.open({
    dbFile,
    models,
    model: faux.getModel(),
    systemPrompt: "test",
    tools: [crashTool(tool, dir, false)],
    mutatingTools: new Set(tool === "charge" ? ["charge"] : []),
    retry: { maxRetries: 0 },
    resume: false,
  });
  runtimes.push(runtime);
  return { runtime, faux };
}

describe("durable recovery after a crash", () => {
  test("the interrupted turn is still on disk, unanswered, when the process comes back", async () => {
    await crashWorker("probe");
    const { runtime } = await reopen("probe", []);

    const pending = await runtime.pendingTurns();
    expect(pending).toHaveLength(1);
    expect(pending[0]?.requestId).toBe("tg:5:77");
  });

  test("a read-only tool interrupted by the crash is replayed and the turn completes", async () => {
    await crashWorker("probe");
    expect(executions("probe")).toBe(1); // the run that died
    const { runtime, faux } = await reopen("probe", [
      fauxAssistantMessage("All done after the restart."),
    ]);

    const [pending] = await runtime.pendingTurns();
    if (!pending) throw new Error("expected an interrupted turn");
    runtime.resume();
    const outcome = await runtime.awaitTurn(pending);

    expect(outcome.status).toBe("done");
    expect(outcome.assistantText).toBe("All done after the restart.");
    expect(executions("probe")).toBe(2); // replayed exactly once
    // The model was not asked to redo the first step: only the final answer was generated.
    expect(faux.state.callCount).toBe(1);
    expect(await runtime.pendingTurns()).toHaveLength(0);
  });

  test("a side-effecting tool interrupted by the crash is NOT run a second time", async () => {
    await crashWorker("charge");
    expect(executions("charge")).toBe(1);
    let toolResultSeen = "";
    const { runtime } = await reopen("charge", [
      (context) => {
        const last = [...context.messages].reverse().find((m) => m.role === "toolResult");
        toolResultSeen = JSON.stringify(last?.content ?? "");
        return fauxAssistantMessage("I could not confirm the charge; please check.");
      },
    ]);

    const [pending] = await runtime.pendingTurns();
    if (!pending) throw new Error("expected an interrupted turn");
    runtime.resume();
    const outcome = await runtime.awaitTurn(pending);

    expect(executions("charge")).toBe(1); // never repeated
    expect(outcome.status).toBe("done");
    // The model is told the call did not complete, so it can verify instead of assuming.
    expect(toolResultSeen.toLowerCase()).toMatch(
      /interrupt|did not complete|unavailable|not (finish|complete)/,
    );
  });

  test("resubmitting the same request id after recovery joins the settled turn instead of re-running it", async () => {
    await crashWorker("probe");
    const { runtime, faux } = await reopen("probe", [fauxAssistantMessage("once")]);
    const [pending] = await runtime.pendingTurns();
    if (!pending) throw new Error("expected an interrupted turn");
    runtime.resume();
    await runtime.awaitTurn(pending);
    const callsAfterRecovery = faux.state.callCount;

    // A redelivered Telegram update carries the same request id.
    const again = await runtime.runTurn(pending.conversationId, "please run the tool", {
      requestId: "tg:5:77",
    });

    expect(again.assistantText).toBe("once");
    expect(faux.state.callCount).toBe(callsAfterRecovery);
    expect(executions("probe")).toBe(2);
  });

  test("the Telegram bot delivers the recovered reply to the chat the turn came from", async () => {
    await crashWorker("probe");

    // The new process: a full agent on the same durable file.
    const config = makeTestConfig({
      durableDbFile: dbFile,
      sessionFile: join(dir, "session.json"),
    });
    const agent = await makeFauxAgent(config, {
      storage: undefined, // use config.durableDbFile (the crashed store)
      tools: [crashTool("probe", dir, false)],
      resume: false,
    });
    runtimes.push(agent.built.runtime);
    agent.faux.setResponses([fauxAssistantMessage("Recovered answer.")]);

    const sent: Array<{ chatId: number; text: string }> = [];
    const session = new ChatSession(config, {
      store: { load: () => null, save: () => {}, list: () => [] } as never,
    });
    session.attach(agent.built);
    const runner = new TurnRunner({
      session,
      built: agent.built,
      config,
      client: {
        sendChatAction: async () => {},
        sendMessage: async () => {},
      } as unknown as TelegramClient,
      send: async (chatId, messages) => {
        for (const text of messages) sent.push({ chatId, text });
      },
      abortSignal: new AbortController().signal,
    });

    agent.built.runtime.resume();
    const recovered = await runner.recoverPending();

    expect(recovered).toBe(1);
    expect(sent.map((m) => m.chatId)).toEqual([5, 5]);
    expect(sent[0]?.text).toContain("interrupted by a restart");
    expect(sent[1]?.text).toBe("Recovered answer.");
    expect(executions("probe")).toBe(2);
  });
});
