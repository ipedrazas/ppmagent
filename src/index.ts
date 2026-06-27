import { buildAgent } from "./agent.ts";
import { loadConfig } from "./config.ts";
import { createLogger } from "./logger.ts";
import { SessionStore } from "./session/store.ts";
import { TelegramBot } from "./telegram/bot.ts";
import { TelegramClient } from "./telegram/client.ts";

/**
 * Entrypoint: load config → build the agent (memory injection reads the active
 * project from the bot) → start the Telegram adapter with a durable session.
 *
 * The bot and agent reference each other (the agent's `transformContext` reads
 * the bot's active project; the bot drives `agent.prompt`). We break the cycle
 * with a mutable holder the `getActiveProject` callback closes over.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger({ level: config.logLevel, format: config.logFormat });
  logger.withMetadata({ model: config.model, logLevel: config.logLevel }).info("ppmagent starting");

  const holder: { bot?: TelegramBot } = {};
  const built = buildAgent(config, () => holder.bot?.getActiveProject(), { logger });

  const bot = new TelegramBot(config, built, {
    client: new TelegramClient(config.telegramBotToken, fetch, logger),
    store: new SessionStore(config.sessionFile),
    logger,
  });
  holder.bot = bot;

  await bot.start();
}

main().catch((error: unknown) => {
  // The logger isn't in scope here (config may have failed to load); use a
  // single structured-ish stderr line and exit non-zero.
  createLogger({ level: "error", format: "json" }).withError(error).fatal("ppmagent crashed");
  process.exit(1);
});
