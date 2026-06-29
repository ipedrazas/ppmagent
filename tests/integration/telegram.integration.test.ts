import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { FauxProviderHandle } from "@earendil-works/pi-ai";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import { buildAgent } from "../../src/agent.ts";
import { DEFAULT_KEEP_RECENT } from "../../src/compaction.ts";
import type { Config } from "../../src/config.ts";
import { PpmClient } from "../../src/memory/ppm.ts";
import { SessionStore } from "../../src/session/store.ts";
import { TelegramBot } from "../../src/telegram/bot.ts";
import type { TelegramClient } from "../../src/telegram/client.ts";

// Step 5: Telegram run loop + durable session, driven by the faux model and a
// fake Telegram client (records sent messages). Needs real `ppm`.
const ppmBin = Bun.which("ppm");
const PROJECT = "onboarding";
const CHAT = 42;

function testConfig(root: string): Config {
  return {
    provider: "anthropic",
    apiKey: "test-key",
    model: "faux-1",
    ppmBin: ppmBin ?? "ppm",
    ppmMemoryRoot: root,
    contextRecent: 5,
    dbxcliBin: "dbxcli",
    dbxcliConfig: "",
    telegramBotToken: "test",
    telegramAllowedChatId: undefined,
    sessionFile: join(root, "session.json"),
    compactionTokenThreshold: 0,
    logLevel: "info",
    logFormat: "json",
  };
}

/** A fake Telegram client that records what the bot sends. */
function fakeClient(): { client: TelegramClient; sent: Array<{ chatId: number; text: string }> } {
  const sent: Array<{ chatId: number; text: string }> = [];
  const client = {
    getUpdates: async () => [],
    sendMessage: async (chatId: number, text: string) => {
      sent.push({ chatId, text });
    },
  } as unknown as TelegramClient;
  return { client, sent };
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
    const holder: { bot?: TelegramBot } = {};
    const built = buildAgent(config, () => holder.bot?.getActiveProject(), {
      model: faux.getModel(),
      streamFn: fauxStream,
    });
    const { client, sent } = fakeClient();
    const bot = new TelegramBot(config, built, { client, store });
    holder.bot = bot;
    return { bot, sent };
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
