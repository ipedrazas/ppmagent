import { dirname, join } from "node:path";
import { buildAgent } from "./agent.ts";
import { type Summarizer, makeModelSummarizer, placeholderSummarizer } from "./compaction.ts";
import { loadConfig } from "./config.ts";
import { PRNotificationStore } from "./github/pr-store.ts";
import { GitHubWebhookServer } from "./github/webhook-server.ts";
import { type Logger, createLogger } from "./logger.ts";
import { ProteosTaskWatcher } from "./proteos/watcher.ts";
import { redactDeep } from "./redact.ts";
import { SessionStore } from "./session/store.ts";
import { TelegramBot } from "./telegram/bot.ts";
import { TelegramClient } from "./telegram/client.ts";
import { ConfirmationStore } from "./tools/confirmation.ts";
import { TraceRecorder } from "./trace/recorder.ts";

/**
 * Entrypoint: load config → build the agent (memory injection reads the active
 * project from the bot) → start the Telegram adapter with a durable session.
 *
 * The bot and agent reference each other (the agent's `transformContext` reads
 * the bot's active project; the bot drives `agent.prompt`). We break the cycle
 * with a mutable holder the `getActiveProject` callback closes over.
 */
/**
 * The production summarizer: the model-backed one, falling back to the
 * model-free placeholder on failure. Compaction runs inside the turn (before
 * the reply is sent), so a summarization error must degrade the summary, never
 * drop the turn.
 */
function makeResilientSummarizer(model: Summarizer, logger: Logger): Summarizer {
  return async (messages, signal) => {
    try {
      return await model(messages, signal);
    } catch (error) {
      logger.withError(error).warn("model summarization failed; falling back to placeholder");
      return placeholderSummarizer(messages, signal);
    }
  };
}

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger({ level: config.logLevel, format: config.logFormat });
  logger
    .withMetadata({ provider: config.provider, model: config.model, logLevel: config.logLevel })
    .info("ppmagent starting");

  // Session traces live beside the sessions themselves; analyzed offline with
  // `bun run trace` (src/trace/extract.ts).
  const recorder = new TraceRecorder(join(dirname(config.sessionFile), "traces"), logger);

  // The watcher holder breaks the init cycle: buildAgent needs onTaskDispatched,
  // but ProteosTaskWatcher needs built.proteos. The holder is set before any turn
  // runs, so the callback is always populated by the time it fires.
  const watcherHolder: { watcher?: ProteosTaskWatcher } = {};
  const holder: { bot?: TelegramBot } = {};
  const confirmationStore = new ConfirmationStore();
  const built = buildAgent(config, () => holder.bot?.getActiveProject(), {
    logger,
    recorder,
    confirmationStore,
    onTaskDispatched: (machine, taskId, project, label) =>
      watcherHolder.watcher?.watch(machine, taskId, project, label),
  });

  const telegramClient = new TelegramClient(config.telegramBotToken, fetch, logger);

  let webhookServer: GitHubWebhookServer | null = null;
  if (config.githubWebhookPort !== null) {
    const prStore = new PRNotificationStore(join(dirname(config.sessionFile), "github-prs.json"));
    webhookServer = new GitHubWebhookServer({
      port: config.githubWebhookPort,
      secret: config.githubWebhookSecret,
      prHandlerDeps: {
        store: prStore,
        notify: async (msg) => {
          if (config.telegramAllowedChatId !== undefined) {
            await telegramClient.sendMessage(config.telegramAllowedChatId, msg);
          }
        },
        monitoredRepos: config.githubMonitoredRepos,
        logger,
      },
      logger,
    });
    webhookServer.start();
  }

  const watcher = new ProteosTaskWatcher({
    proteos: built.proteos,
    notify: async (msg) => {
      if (config.telegramAllowedChatId !== undefined) {
        await telegramClient.sendMessage(config.telegramAllowedChatId, msg);
      }
    },
    storeFile: join(dirname(config.sessionFile), "proteos-tasks.json"),
    intervalMs: config.proteosWatchIntervalMs,
    logger,
  });
  watcherHolder.watcher = watcher;

  const secrets = [config.telegramBotToken, config.apiKey, config.githubWebhookSecret].filter(
    Boolean,
  );
  const bot = new TelegramBot(config, built, {
    client: telegramClient,
    store: new SessionStore(config.sessionFile, (v) => redactDeep(v, secrets)),
    summarize: makeResilientSummarizer(makeModelSummarizer(built.model), logger),
    recorder,
    logger,
    confirmationStore,
  });
  holder.bot = bot;

  // Graceful shutdown. The container runs `bun` as PID 1, for which the kernel
  // installs no default signal disposition — so an unhandled SIGTERM is ignored
  // and Docker escalates to SIGKILL (exit 137). Handle the termination signals
  // explicitly: stop the bot and watcher (which abort their in-flight polls),
  // let both `start()` calls return, and exit 0.
  let shuttingDown = false;
  const shutdown = (signal: NodeJS.Signals): void => {
    if (shuttingDown) return; // ignore a second signal while we're already winding down
    shuttingDown = true;
    logger.withMetadata({ signal }).info("received termination signal; shutting down");
    bot.stop();
    watcher.stop();
    webhookServer?.stop();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  await Promise.all([bot.start(), watcher.start()]);
  logger.info("ppmagent stopped");
}

main().catch((error: unknown) => {
  // The logger isn't in scope here (config may have failed to load); use a
  // single structured-ish stderr line and exit non-zero.
  createLogger({ level: "error", format: "json" }).withError(error).fatal("ppmagent crashed");
  process.exit(1);
});
