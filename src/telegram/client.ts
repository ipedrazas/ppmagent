/** Minimal Telegram Bot API client over fetch — just what the PoC needs. */

import { type Logger, nullLogger } from "../logger.ts";
import { redact } from "../redact.ts";

export interface InboundMessage {
  chatId: number;
  text: string;
}

export interface Update {
  updateId: number;
  message?: InboundMessage;
}

/** Injectable fetch so the client is unit-testable without a network. */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** Telegram message formatting mode; omitted means plain text. */
export type ParseMode = "MarkdownV2" | "HTML" | "Markdown";

const MAX_MESSAGE_LENGTH = 4096;
const DEFAULT_SEND_TIMEOUT_MS = 30_000;
const MAX_RATE_LIMIT_RETRIES = 5;

export class TelegramClient {
  private readonly base: string;
  private readonly token: string;
  private readonly log: Logger;
  private readonly sendTimeoutMs: number;

  constructor(
    token: string,
    private readonly fetchImpl: FetchLike = fetch,
    logger: Logger = nullLogger,
    sendTimeoutMs = DEFAULT_SEND_TIMEOUT_MS,
  ) {
    this.token = token;
    this.base = `https://api.telegram.org/bot${token}`;
    this.log = logger.child().withContext({ component: "telegram-client" });
    this.sendTimeoutMs = sendTimeoutMs;
  }

  /** Scrub the bot token from an error before logging or re-throwing it. */
  private sanitizeError(err: unknown): Error {
    if (!(err instanceof Error)) {
      return new Error(redact(String(err), [this.token]));
    }
    const sanitized = new Error(redact(err.message, [this.token]));
    sanitized.name = err.name;
    if (err.stack) {
      sanitized.stack = redact(err.stack, [this.token]);
    }
    return sanitized;
  }

  /** Wraps fetchImpl and sanitizes network errors (which may embed the request URL) before re-throwing. */
  private async safeFetch(url: string, init?: RequestInit): Promise<Response> {
    try {
      return await this.fetchImpl(url, init);
    } catch (err) {
      throw this.sanitizeError(err);
    }
  }

  /**
   * Long-poll for updates from `offset`. Returns normalized text messages only.
   * Pass `signal` to abort an in-flight poll (used to shut down promptly on
   * SIGTERM rather than blocking up to `timeoutSec`).
   */
  async getUpdates(offset: number, timeoutSec = 25, signal?: AbortSignal): Promise<Update[]> {
    const url = `${this.base}/getUpdates?offset=${offset}&timeout=${timeoutSec}`;
    // HTTP-level timeout: long-poll duration + buffer for network overhead
    const httpTimeoutMs = (timeoutSec + 5) * 1000;
    const timeoutSignal = AbortSignal.timeout(httpTimeoutMs);
    const effectiveSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
    const res = await this.safeFetch(url, { signal: effectiveSignal });
    const body = (await res.json()) as {
      ok: boolean;
      description?: string;
      result?: Array<{
        update_id: number;
        message?: { chat?: { id: number }; text?: string };
      }>;
    };
    if (!body.ok || !body.result) {
      // Telegram returns `ok: false` for conditions that resolve quickly — most
      // notably 409 Conflict when a second poller is running (e.g. an old
      // container instance overlapping a restart). Throw so the caller backs
      // off instead of re-polling in a tight loop, which pegs CPU and grows
      // memory until the process is OOM-killed.
      throw new Error(`getUpdates failed: ${body.description ?? `ok=${body.ok}`}`);
    }
    return body.result.map((u) => {
      const chatId = u.message?.chat?.id;
      const text = u.message?.text;
      return {
        updateId: u.update_id,
        message: chatId !== undefined && text !== undefined ? { chatId, text } : undefined,
      };
    });
  }

  async sendMessage(chatId: number, text: string, parseMode?: ParseMode): Promise<void> {
    for (const chunk of this.chunkText(text)) {
      await this.sendChunk(chatId, chunk, parseMode);
    }
  }

  private chunkText(text: string, maxLen = MAX_MESSAGE_LENGTH): string[] {
    if (text.length <= maxLen) return [text];
    const chunks: string[] = [];
    let pos = 0;
    while (pos < text.length) {
      if (pos + maxLen >= text.length) {
        chunks.push(text.slice(pos));
        break;
      }
      const window = text.slice(pos, pos + maxLen);
      // Prefer splitting on newline, then space, then hard-cut
      let splitAt = window.lastIndexOf("\n");
      if (splitAt > 0) {
        chunks.push(window.slice(0, splitAt));
        pos += splitAt + 1; // skip the newline itself
        continue;
      }
      splitAt = window.lastIndexOf(" ");
      if (splitAt > 0) {
        chunks.push(window.slice(0, splitAt));
        pos += splitAt + 1; // skip the space itself
        continue;
      }
      chunks.push(window);
      pos += maxLen;
    }
    return chunks;
  }

  private async sendChunk(chatId: number, text: string, parseMode?: ParseMode): Promise<void> {
    const payload = parseMode
      ? { chat_id: chatId, text, parse_mode: parseMode }
      : { chat_id: chatId, text };
    for (let attempt = 0; attempt <= MAX_RATE_LIMIT_RETRIES; attempt++) {
      const res = await this.safeFetch(`${this.base}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(this.sendTimeoutMs),
      });
      if (res.status === 429) {
        if (attempt === MAX_RATE_LIMIT_RETRIES) {
          this.log
            .withMetadata({ chatId })
            .warn("sendMessage rate limit retries exhausted, dropping chunk");
          return;
        }
        const body = (await res.json()) as {
          parameters?: { retry_after?: number };
        };
        const retryAfter = body.parameters?.retry_after ?? 5;
        this.log
          .withMetadata({ chatId, retryAfter, attempt })
          .warn("sendMessage rate limited, will retry");
        await new Promise<void>((resolve) => setTimeout(resolve, retryAfter * 1000));
        continue;
      }
      if (!res.ok) {
        this.log
          .withMetadata({ chatId, status: res.status })
          .warn("sendMessage returned a non-2xx status");
      }
      return;
    }
  }

  /**
   * Register a webhook URL with Telegram. Telegram will POST each update to
   * this URL instead of queuing it for `getUpdates`. Pass `secretToken` to
   * require the `X-Telegram-Bot-Api-Secret-Token` header on every request.
   */
  async setWebhook(url: string, secretToken?: string): Promise<void> {
    const payload: Record<string, string> = { url };
    if (secretToken) payload.secret_token = secretToken;
    await this.safeFetch(`${this.base}/setWebhook`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(this.sendTimeoutMs),
    });
  }

  /** Show a transient status (e.g. "typing") in the chat. Expires after ~5 s. */
  async sendChatAction(chatId: number, action: string): Promise<void> {
    await this.safeFetch(`${this.base}/sendChatAction`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, action }),
    });
  }
}
