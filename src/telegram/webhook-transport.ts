/**
 * Telegram webhook transport (prototype).
 *
 * ## Why webhooks scale better than polling
 *
 * The polling loop in `TelegramBot.start()` holds one long-lived HTTP connection
 * to Telegram and processes updates sequentially. This works well for a single
 * instance but does not scale horizontally: running two instances causes both to
 * race on `getUpdates`, and each update is consumed by only one of them —
 * whichever wins the race. The loser gets nothing. You cannot share load across
 * replicas without a custom coordination layer.
 *
 * Telegram's webhook mode inverts the flow. You register a public HTTPS URL with
 * `setWebhook` and Telegram POSTs each update there. A load balancer can front
 * any number of replicas; Telegram retries deliveries that return non-2xx for up
 * to 24 hours, giving better at-least-once guarantees than a polling loop that
 * crashes mid-batch.
 *
 * ## Trade-offs
 *
 * - Requires a public HTTPS URL (polling works from any outbound connection).
 * - Telegram retries non-2xx responses — the handler must be idempotent or track
 *   processed `update_id`s to avoid double-processing.
 * - No `/cancel`-while-polling trick: the polling timeout is what makes the bot
 *   notice `/cancel` within ~1 s while a turn is running. In webhook mode,
 *   `/cancel` arrives as a separate POST and must abort the in-flight turn via a
 *   shared signal (the `TelegramBot` already has one; the webhook transport calls
 *   `handleMessage` which routes through the same abort-aware turn runner).
 * - `setWebhook` and `getUpdates` are mutually exclusive — while a webhook is
 *   registered, Telegram will not serve `getUpdates`.
 *
 * ## Wiring (see `src/index.ts`)
 *
 * Set `PPMA_TELEGRAM_WEBHOOK_PORT` and `PPMA_TELEGRAM_WEBHOOK_URL` to activate.
 * When set, the main loop awaits `TelegramWebhookTransport.start()` instead of
 * `TelegramBot.start()`. The `TelegramBot` is still constructed (its `handleMessage`
 * drives the turn runner), but its polling loop is never started.
 */
import { type Logger, nullLogger } from "../logger.ts";
import type { TelegramClient } from "./client.ts";

/** Partial shape of a Telegram Update object (only fields we use). */
interface TelegramUpdate {
  update_id: number;
  message?: {
    chat?: { id: number };
    text?: string;
    photo?: unknown;
    voice?: unknown;
    audio?: unknown;
    video?: unknown;
    sticker?: unknown;
    document?: unknown;
    animation?: unknown;
  };
  edited_message?: { chat?: { id: number }; text?: string };
}

export interface WebhookHandlerOpts {
  /** Optional secret token; when set, the `X-Telegram-Bot-Api-Secret-Token` header must match. */
  secretToken?: string;
  /** The single allowed chat id. `undefined` = open to all (PPMA_ALLOW_ANY_CHAT). */
  allowedChatId?: number;
  /** Called for each valid inbound text message. Same contract as TelegramBot.handleMessage(). */
  handleMessage: (chatId: number, text: string) => Promise<unknown>;
  /** Called to send a reply (e.g. for non-text message feedback). When absent, non-text messages are silently ignored. */
  sendMessage?: (chatId: number, text: string) => Promise<void>;
  logger: Logger;
}

/**
 * Pure request handler, exported for unit testing without starting a real server.
 */
export async function handleWebhookRequest(
  req: Request,
  opts: WebhookHandlerOpts,
): Promise<Response> {
  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  const url = new URL(req.url);
  if (url.pathname !== "/webhook/telegram") {
    return new Response("Not Found", { status: 404 });
  }

  if (opts.secretToken) {
    const header = req.headers.get("X-Telegram-Bot-Api-Secret-Token");
    if (header !== opts.secretToken) {
      opts.logger.warn("telegram webhook: rejected request with invalid secret token");
      return new Response("Unauthorized", { status: 401 });
    }
  }

  let update: TelegramUpdate;
  try {
    update = (await req.json()) as TelegramUpdate;
  } catch {
    return new Response("Bad Request", { status: 400 });
  }

  const msg = update.message;
  const editedMsg = update.edited_message;
  const chatId = msg?.chat?.id ?? editedMsg?.chat?.id;
  if (!chatId) {
    return new Response("OK", { status: 200 });
  }

  if (opts.allowedChatId !== undefined && chatId !== opts.allowedChatId) {
    opts.logger.withMetadata({ chatId }).debug("telegram webhook: ignoring disallowed chat");
    return new Response("OK", { status: 200 });
  }

  const text = msg?.text;
  if (!text) {
    // Non-text message (photo, voice, edit, etc.) — send a helpful reply when possible.
    if (opts.sendMessage) {
      const kind = editedMsg
        ? "edit"
        : msg?.photo
          ? "photo"
          : msg?.voice
            ? "voice"
            : msg?.audio
              ? "audio"
              : msg?.video
                ? "video"
                : msg?.sticker
                  ? "sticker"
                  : "unknown";
      opts
        .sendMessage(chatId, `I can only process text messages (received: ${kind}).`)
        .catch((err) =>
          opts.logger.withError(err).warn("telegram webhook: error sending non-text reply"),
        );
    }
    return new Response("OK", { status: 200 });
  }

  // Respond 200 immediately — Telegram considers non-2xx a delivery failure
  // and retries. The handler is fire-and-forget so the response is instant.
  opts
    .handleMessage(chatId, text)
    .catch((err) =>
      opts.logger
        .withError(err)
        .withMetadata({ updateId: update.update_id, chatId })
        .warn("telegram webhook: error handling message"),
    );

  return new Response("OK", { status: 200 });
}

export interface TelegramWebhookTransportOptions {
  /** HTTP port the server listens on (reverse-proxied to HTTPS externally). */
  port: number;
  /**
   * Public HTTPS URL Telegram will POST to.
   * Example: `https://bot.example.com/webhook/telegram`
   */
  webhookUrl: string;
  /** Telegram API client (used to register the webhook URL). */
  client: TelegramClient;
  /** Optional secret token sent in `X-Telegram-Bot-Api-Secret-Token` for verification. */
  secretToken?: string;
  /** The single allowed chat id. `undefined` = open to all. */
  allowedChatId?: number;
  /** Called for each valid inbound message. */
  handleMessage: (chatId: number, text: string) => Promise<unknown>;
  logger?: Logger;
}

/**
 * Webhook-based transport alternative to the long-poll loop in `TelegramBot`.
 * Call `start()` instead of `TelegramBot.start()` — both resolve when `stop()`
 * is called, so they compose identically in `Promise.all`.
 */
export class TelegramWebhookTransport {
  private readonly log: Logger;
  private server: ReturnType<typeof Bun.serve> | null = null;
  private resolveStart: (() => void) | null = null;

  constructor(private readonly opts: TelegramWebhookTransportOptions) {
    this.log = (opts.logger ?? nullLogger).child().withContext({ component: "webhook-transport" });
  }

  /**
   * Register the webhook URL with Telegram, start the HTTP server, and wait
   * until {@link stop} is called (mirrors the `bot.start()` contract).
   */
  async start(): Promise<void> {
    await this.opts.client.setWebhook(this.opts.webhookUrl, this.opts.secretToken);
    this.log.withMetadata({ url: this.opts.webhookUrl }).info("telegram webhook registered");

    const handlerOpts: WebhookHandlerOpts = {
      secretToken: this.opts.secretToken,
      allowedChatId: this.opts.allowedChatId,
      handleMessage: this.opts.handleMessage,
      sendMessage: (chatId, text) => this.opts.client.sendMessage(chatId, text),
      logger: this.log,
    };

    this.server = Bun.serve({
      port: this.opts.port,
      fetch: (req) => handleWebhookRequest(req, handlerOpts),
    });

    this.log
      .withMetadata({ port: this.opts.port, webhookUrl: this.opts.webhookUrl })
      .info("telegram webhook transport started");

    return new Promise<void>((resolve) => {
      this.resolveStart = resolve;
    });
  }

  stop(): void {
    this.server?.stop();
    this.server = null;
    this.resolveStart?.();
    this.resolveStart = null;
    this.log.info("telegram webhook transport stopped");
  }
}
