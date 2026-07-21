import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { FauxProviderHandle } from "@earendil-works/pi-ai";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import { buildAgent } from "../../src/agent.ts";
import { DEFAULT_KEEP_RECENT } from "../../src/compaction.ts";
import type { Config } from "../../src/config.ts";
import { PpmClient } from "../../src/memory/ppm.ts";
import { SessionStore } from "../../src/session/store.ts";
import { TelegramBot } from "../../src/telegram/bot.ts";
import { ChatSession } from "../../src/telegram/chat-session.ts";
import type { TelegramClient } from "../../src/telegram/client.ts";
import { makeTestConfig } from "../support/config.ts";

// Step 5: Telegram run loop + durable session, driven by the faux model and a
// fake Telegram client (records sent messages). Needs real `ppm`.
const ppmBin = Bun.which("ppm");
const PROJECT = "onboarding";
const CHAT = 42;

function testConfig(root: string): Config {
  return makeTestConfig({
    ppmBin: ppmBin ?? "ppm",
    ppmMemoryRoot: root,
    sessionFile: join(root, "session.json"),
  });
}

/** A fake Telegram client that records what the bot sends. */
function fakeClient(): {
  client: TelegramClient;
  sent: Array<{ chatId: number; text: string }>;
  chatActions: Array<{ chatId: number; action: string }>;
} {
  const sent: Array<{ chatId: number; text: string }> = [];
  const chatActions: Array<{ chatId: number; action: string }> = [];
  const client = {
    getUpdates: async () => [],
    sendMessage: async (chatId: number, text: string) => {
      sent.push({ chatId, text });
    },
    sendChatAction: async (chatId: number, action: string) => {
      chatActions.push({ chatId, action });
    },
  } as unknown as TelegramClient;
  return { client, sent, chatActions };
}

describe.skipIf(!ppmBin)("Telegram bot + durable session", () => {
  let root: string;
  let ppm: PpmClient;
  let faux: FauxProviderHandle;
  let models: ReturnType<typeof createModels>;
  const fauxStream: StreamFn = (model, context, options) =>
    models.streamSimple(model, context, options);

  beforeEach(async () => {
    root = mkdtempSync(join(import.meta.dir, ".tgroot-"));
    ppm = new PpmClient({ bin: ppmBin ?? "ppm", root });
    await ppm.run(["init"]);
    await ppm.projectCreate(PROJECT, "Onboarding drop-off");
    faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }] });
    models = createModels();
    models.setProvider(faux.provider);
  });

  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  function makeBot(store: SessionStore) {
    const config = testConfig(root);
    const session = new ChatSession(config, { store });
    const built = buildAgent(config, () => session.activeProject, {
      model: faux.getModel(),
      streamFn: fauxStream,
    });
    session.attach(built);
    const { client, sent, chatActions } = fakeClient();
    const bot = new TelegramBot(config, built, session, { client, store });
    return { bot, sent, chatActions };
  }

  test("/project sets the active project for memory injection", async () => {
    const store = new SessionStore(join(root, "session.json"));
    const { bot, sent } = makeBot(store);
    const replies = await bot.handleMessage(CHAT, "/project onboarding");
    expect(replies[0]).toContain("onboarding");
    expect(bot.getActiveProject()).toBe(PROJECT);
    expect(sent.at(-1)?.text).toContain("onboarding");
  });

  test("/context reports token usage against the threshold", async () => {
    const store = new SessionStore(join(root, "session.json"));
    const { bot, sent } = makeBot(store);
    const replies = await bot.handleMessage(CHAT, "/context");
    expect(replies[0]).toMatch(/Context: ~[\d,]+ tokens across \d+ messages/);
    expect(replies[0]).toContain("compaction at");
    expect(sent.at(-1)?.text).toContain("Context:");
  });

  test("/compact on a short transcript reports nothing to compact", async () => {
    faux.setResponses([fauxAssistantMessage("Noted.")]);
    const store = new SessionStore(join(root, "session.json"));
    const { bot } = makeBot(store);
    await bot.handleMessage(CHAT, "/project onboarding");
    await bot.handleMessage(CHAT, "a single short turn");
    const replies = await bot.handleMessage(CHAT, "/compact");
    expect(replies[0]).toContain("Nothing to compact yet");
  });

  test("/compact summarizes a long transcript and shrinks it", async () => {
    const store = new SessionStore(join(root, "session.json"));
    const { bot } = makeBot(store);
    await bot.handleMessage(CHAT, "/project onboarding");
    // Build a transcript longer than the keep-recent tail so compaction bites.
    for (let i = 0; i < 6; i++) {
      faux.setResponses([fauxAssistantMessage(`Acknowledged turn ${i} with some detail.`)]);
      await bot.handleMessage(CHAT, `message number ${i} with enough text to matter`);
    }
    const before = store.load()?.messages.length ?? 0;
    expect(before).toBeGreaterThan(DEFAULT_KEEP_RECENT);

    const replies = await bot.handleMessage(CHAT, "/compact");
    expect(replies[0]).toContain("Compacted:");
    const after = store.load()?.messages.length ?? 0;
    expect(after).toBeLessThan(before);
  });

  test("/new clears the transcript but keeps the active project and memory", async () => {
    faux.setResponses([fauxAssistantMessage("Noted.")]);
    const store = new SessionStore(join(root, "session.json"));
    const { bot } = makeBot(store);
    await bot.handleMessage(CHAT, "/project onboarding");
    await bot.handleMessage(CHAT, "some earlier context");
    expect(store.load()?.messages.length ?? 0).toBeGreaterThan(0);

    const replies = await bot.handleMessage(CHAT, "/new");
    expect(replies[0]).toContain("new session");
    // Transcript wiped, project retained → memory injection still targets it.
    expect(store.load()?.messages.length).toBe(0);
    expect(bot.getActiveProject()).toBe(PROJECT);
    // The earlier session is still on disk, resumable.
    expect(store.list().length).toBe(2);
  });

  test("/name labels the current session and /session reports it", async () => {
    const store = new SessionStore(join(root, "session.json"));
    const { bot } = makeBot(store);
    await bot.handleMessage(CHAT, "/project onboarding");
    await bot.handleMessage(CHAT, "/name metrics-review");
    const replies = await bot.handleMessage(CHAT, "/session");
    expect(replies[0]).toContain("metrics-review");
    expect(replies[0]).toContain("Project: onboarding");
    expect(store.find("metrics-review")?.name).toBe("metrics-review");
  });

  test("/tools reports each CLI's version (or that it is unavailable)", async () => {
    const store = new SessionStore(join(root, "session.json"));
    const { bot, sent } = makeBot(store);
    const replies = await bot.handleMessage(CHAT, "/tools");
    expect(replies[0]).toContain("ppmagent tools:");
    // ppm is required for this suite, so its real version line is present and
    // not the "not installed" fallback.
    expect(replies[0]).toMatch(/ppm.*memory/);
    expect(replies[0]).not.toContain("ppm (memory) — not installed");
    expect(sent.at(-1)?.text).toContain("ppmagent tools:");
  });

  test("/resume lists sessions and switches back to a named one", async () => {
    faux.setResponses([fauxAssistantMessage("Noted.")]);
    const store = new SessionStore(join(root, "session.json"));
    const { bot } = makeBot(store);
    await bot.handleMessage(CHAT, "/name first");
    await bot.handleMessage(CHAT, "remember this");
    const firstId = store.find("first")?.sessionId;
    await bot.handleMessage(CHAT, "/new second");

    const list = await bot.handleMessage(CHAT, "/resume");
    expect(list[0]).toContain("first");
    expect(list[0]).toContain("second");

    const switched = await bot.handleMessage(CHAT, "/resume first");
    expect(switched[0]).toContain("Resumed");
    // The store's current pointer now resolves back to the first session.
    expect(store.load()?.sessionId).toBe(firstId);
    expect(bot.getActiveProject()).toBe(store.find("first")?.activeProject);
  });

  test("a vague message produces a clarifying question and records it", async () => {
    faux.setResponses([
      fauxAssistantMessage([
        fauxToolCall("ask_user", {
          question: "What metric defines onboarding success?",
          project: PROJECT,
        }),
      ]),
    ]);
    const store = new SessionStore(join(root, "session.json"));
    const { bot, sent } = makeBot(store);
    await bot.handleMessage(CHAT, "/project onboarding");
    const replies = await bot.handleMessage(CHAT, "we should improve onboarding");

    expect(replies).toContain("What metric defines onboarding success?");
    expect(sent.some((m) => m.text.includes("What metric defines onboarding success?"))).toBe(true);

    const ctx = await ppm.context(PROJECT, 5);
    expect(ctx.data.openQuestions.map((q) => q.body)).toContain(
      "What metric defines onboarding success?",
    );
  });

  test("a clarifying question keeps the leading context text before the question (TAV-136)", async () => {
    faux.setResponses([
      fauxAssistantMessage([
        fauxText(
          "This is a new tab like the existing Analyse, Diff, Extract, Tools tabs. Let me clarify the scope a bit.",
        ),
        fauxToolCall("ask_user", {
          question: "For the Visualizer tab — what should the tree represent?",
          project: PROJECT,
        }),
      ]),
    ]);
    const store = new SessionStore(join(root, "session.json"));
    const { bot } = makeBot(store);
    await bot.handleMessage(CHAT, "/project onboarding");
    const replies = await bot.handleMessage(CHAT, "add a visualizer tab");

    // Chronological order: the model's context/reasoning text first, then the
    // clarifying question it asks off the back of that reasoning.
    expect(replies).toEqual([
      "This is a new tab like the existing Analyse, Diff, Extract, Tools tabs. Let me clarify the scope a bit.",
      "For the Visualizer tab — what should the tree represent?",
    ]);
  });

  test("multiple clarifying questions across turns each keep context before the question (TAV-136)", async () => {
    const store = new SessionStore(join(root, "session.json"));
    const { bot } = makeBot(store);
    await bot.handleMessage(CHAT, "/project onboarding");

    faux.setResponses([
      fauxAssistantMessage([
        fauxText("Let me clarify the scope a bit."),
        fauxToolCall("ask_user", {
          question: "What should the tree represent?",
          project: PROJECT,
        }),
      ]),
    ]);
    const first = await bot.handleMessage(CHAT, "add a visualizer tab");
    expect(first).toEqual(["Let me clarify the scope a bit.", "What should the tree represent?"]);

    faux.setResponses([
      fauxAssistantMessage([
        fauxText("One more thing before I start."),
        fauxToolCall("ask_user", {
          question: "Should it support drag-and-drop reordering?",
          project: PROJECT,
        }),
      ]),
    ]);
    const second = await bot.handleMessage(CHAT, "it should show the dependency graph");
    expect(second).toEqual([
      "One more thing before I start.",
      "Should it support drag-and-drop reordering?",
    ]);
  });

  test("/help lists all slash commands", async () => {
    const store = new SessionStore(join(root, "session.json"));
    const { bot, sent } = makeBot(store);
    const replies = await bot.handleMessage(CHAT, "/help");
    expect(replies[0]).toContain("/project");
    expect(replies[0]).toContain("/cancel");
    expect(replies[0]).toContain("/help");
    expect(sent.at(-1)?.text).toContain("Available commands:");
  });

  test("/cancel with no active turn reports nothing to cancel", async () => {
    const store = new SessionStore(join(root, "session.json"));
    const { bot, sent } = makeBot(store);
    const replies = await bot.handleMessage(CHAT, "/cancel");
    expect(replies[0]).toContain("No active turn to cancel");
    expect(sent.at(-1)?.text).toContain("No active turn to cancel");
  });

  test("agent turns send a typing indicator while processing", async () => {
    faux.setResponses([fauxAssistantMessage("Done.")]);
    const store = new SessionStore(join(root, "session.json"));
    const { bot, chatActions } = makeBot(store);
    await bot.handleMessage(CHAT, "do something");
    expect(chatActions.some((a) => a.action === "typing")).toBe(true);
  });

  test("a fresh bot restores the active project + transcript from disk", async () => {
    faux.setResponses([fauxAssistantMessage("Noted.")]);
    const store = new SessionStore(join(root, "session.json"));
    const first = makeBot(store);
    await first.bot.handleMessage(CHAT, "/project onboarding");
    await first.bot.handleMessage(CHAT, "remember this thread");

    // New bot instance, same store file → continuity across a "restart".
    const store2 = new SessionStore(join(root, "session.json"));
    const second = makeBot(store2);
    expect(second.bot.getActiveProject()).toBe(PROJECT);

    faux.setResponses([fauxAssistantMessage("Still here.")]);
    const replies = await second.bot.handleMessage(CHAT, "are you there?");
    expect(replies).toContain("Still here.");
    // The restored transcript carried the earlier turns forward.
    const persisted = store2.load();
    expect(persisted?.messages.length ?? 0).toBeGreaterThan(2);
  });
});
