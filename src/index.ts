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
  logger
    .withMetadata({ provider: config.provider, model: config.model, logLevel: config.logLevel })
    .info("ppmagent starting");

  const holder: { bot?: TelegramBot } = {};
  const built = buildAgent(config, () => holder.bot?.getActiveProject(), { logger });

  const bot = new TelegramBot(config, built, {
    client: new TelegramClient(config.telegramBotToken, fetch, logger),
    store: new SessionStore(config.sessionFile),
    logger,
  });
  holder.bot = bot;

  // Graceful shutdown. The container runs `bun` as PID 1, for which the kernel
  // installs no default signal disposition — so an unhandled SIGTERM is ignored
  // and Docker escalates to SIGKILL (exit 137). Handle the termination signals
  // explicitly: stop the bot (which aborts the in-flight long-poll), let
  // `start()` return, and exit 0.
  let shuttingDown = false;
  const shutdown = (signal: NodeJS.Signals): void => {
    if (shuttingDown) return; // ignore a second signal while we're already winding down
    shuttingDown = true;
    logger.withMetadata({ signal }).info("received termination signal; shutting down");
    bot.stop();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  await bot.start();
  logger.info("ppmagent stopped");
}

main().catch((error: unknown) => {
  // The logger isn't in scope here (config may have failed to load); use a
  // single structured-ish stderr line and exit non-zero.
  createLogger({ level: "error", format: "json" }).withError(error).fatal("ppmagent crashed");
  process.exit(1);
});
