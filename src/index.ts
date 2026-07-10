import { dirname, join } from "node:path";
import { buildAgent } from "./agent.ts";
import { makeModelSummarizer, placeholderSummarizer, type Summarizer } from "./compaction.ts";
import { loadConfig } from "./config.ts";
import { PRNotificationStore } from "./github/pr-store.ts";
import { GitHubWebhookServer } from "./github/webhook-server.ts";
import { createLogger, type Logger } from "./logger.ts";
import { MetricsCollector } from "./metrics/collector.ts";
import { MetricsServer } from "./metrics/server.ts";
import { runPreflightChecks } from "./preflight.ts";
import { ProteosTaskWatcher } from "./proteos/watcher.ts";
import { redactDeep } from "./redact.ts";
import { ReminderRunner } from "./reminder/runner.ts";
import { ReminderStore } from "./reminder/store.ts";
import { SessionRetentionRunner } from "./session/retention.ts";
import { SessionIndex } from "./session/session-index.ts";
import { SessionStore } from "./session/store.ts";
import { TelegramBot } from "./telegram/bot.ts";
import { ChatSession } from "./telegram/chat-session.ts";
import { TelegramClient } from "./telegram/client.ts";
import { TelegramWebhookTransport } from "./telegram/webhook-transport.ts";
import { ConfirmationStore } from "./tools/confirmation.ts";
import { TraceRecorder } from "./trace/recorder.ts";

/**
 * Entrypoint: load config → create the ChatSession → build the agent (memory
 * injection reads the active project from the session) → start the Telegram
 * adapter with a durable session.
 *
 * The session owns `activeProject`, so the agent's `transformContext` reads it
 * via `() => session.activeProject` — the session is constructed before the
 * agent, and the agent's transcript is bound back with `session.attach()`. This
 * replaces the old mutable bot holder (the dependency now points one way).
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
    .withMetadata({
      provider: config.provider,
      model: config.model,
      logLevel: config.logLevel,
      confirmationGate: config.confirmationGate,
    })
    .info("ppmagent starting");

  await runPreflightChecks(
    { ppm: config.ppmBin, dbxcli: config.dbxcliBin, proteos: config.proteosBin },
    logger,
  );

  // Session traces live beside the sessions themselves; analyzed offline with
  // `bun run trace` (src/trace/extract.ts).
  const recorder = new TraceRecorder(join(dirname(config.sessionFile), "traces"), logger);
  const metrics = new MetricsCollector({
    logger,
    provider: config.provider,
    model: config.model,
  });

  // The watcher holder breaks the init cycle: buildAgent needs onTaskDispatched,
  // but ProteosTaskWatcher needs built.proteos. The holder is set before any turn
  // runs, so the callback is always populated by the time it fires.
  const watcherHolder: { watcher?: ProteosTaskWatcher } = {};
  const confirmationStore = config.confirmationGate ? new ConfirmationStore() : undefined;

  // The session owns the active project, so the memory-injection seam reads it
  // directly — no mutable bot holder. Built before the agent; its transcript is
  // bound with attach() once the agent exists.
  const secrets = [
    config.telegramBotToken,
    config.apiKey,
    config.githubWebhookSecret,
    config.githubToken,
  ].filter(Boolean);
  const store = new SessionStore(config.sessionFile, (v) => redactDeep(v, secrets));

  // Build the session index from the store so search works on existing sessions.
  const sessionRoot = dirname(config.sessionFile);
  const sessionIndex = new SessionIndex(join(sessionRoot, "sessions", "index.json"), logger);
  sessionIndex.rebuild(store);

  const session = new ChatSession(config, {
    store,
    recorder,
    metrics,
    logger,
    index: sessionIndex,
  });
  // reminderStore must be created before buildAgent so the reminder tools can reference it.
  // The store file lives beside the other session-adjacent state files.
  const reminderStore = new ReminderStore(join(dirname(config.sessionFile), "reminders.json"));

  const built = buildAgent(config, () => session.activeProject, {
    logger,
    recorder,
    metrics,
    confirmationStore,
    reminderStore,
    onTaskDispatched: (machine, taskId, project, label) =>
      watcherHolder.watcher?.watch(machine, taskId, project, label),
  });
  // The model-backed summarizer needs the built model, so it is injected now.
  session.attach(built, makeResilientSummarizer(makeModelSummarizer(built.model), logger));

  const telegramClient = new TelegramClient(config.telegramBotToken, fetch, logger);

  let metricsServer: MetricsServer | null = null;
  if (config.metricsPort !== null) {
    metricsServer = new MetricsServer({ port: config.metricsPort, collector: metrics, logger });
    metricsServer.start();
  }

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

  const reminderRunner = new ReminderRunner({
    store: reminderStore,
    notify: async (msg) => {
      if (config.telegramAllowedChatId !== undefined) {
        await telegramClient.sendMessage(config.telegramAllowedChatId, msg);
      }
    },
    intervalMs: config.reminderPollIntervalMs,
    logger,
  });

  const bot = new TelegramBot(config, built, session, {
    client: telegramClient,
    store,
    recorder,
    metrics,
    logger,
    confirmationStore,
    index: sessionIndex,
    reminderStore,
  });

  const retentionRunner = new SessionRetentionRunner({
    store,
    retentionDays: config.sessionRetentionDays,
    currentSessionId: () => session.sessionId,
    index: sessionIndex,
    logger,
  });

  // Webhook transport is an opt-in alternative to the polling loop. When both
  // PPMA_TELEGRAM_WEBHOOK_PORT and PPMA_TELEGRAM_WEBHOOK_URL are set, Telegram
  // pushes updates to the webhook endpoint and `bot.start()` is not called. See
  // src/telegram/webhook-transport.ts for the scaling rationale and trade-offs.
  let webhookTransport: TelegramWebhookTransport | null = null;
  if (config.telegramWebhookPort !== null && config.telegramWebhookUrl) {
    webhookTransport = new TelegramWebhookTransport({
      port: config.telegramWebhookPort,
      webhookUrl: config.telegramWebhookUrl,
      secretToken: config.telegramWebhookSecret || undefined,
      allowedChatId: config.telegramAllowedChatId,
      client: telegramClient,
      handleMessage: (chatId, text) => bot.handleMessage(chatId, text),
      logger,
    });
    logger
      .withMetadata({ port: config.telegramWebhookPort, url: config.telegramWebhookUrl })
      .info("webhook transport mode enabled (polling disabled)");
  }

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
    retentionRunner.stop();
    reminderRunner.stop();
    webhookServer?.stop();
    metricsServer?.stop();
    webhookTransport?.stop();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  const telegramTransport = webhookTransport ? webhookTransport.start() : bot.start();
  await Promise.all([
    telegramTransport,
    watcher.start(),
    retentionRunner.start(),
    reminderRunner.start(),
  ]);
  logger.info("ppmagent stopped");
}

main().catch((error: unknown) => {
  // The logger isn't in scope here (config may have failed to load); use a
  // single structured-ish stderr line and exit non-zero.
  createLogger({ level: "error", format: "json" }).withError(error).fatal("ppmagent crashed");
  process.exit(1);
});
