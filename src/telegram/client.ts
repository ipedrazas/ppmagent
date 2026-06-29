/** Minimal Telegram Bot API client over fetch — just what the PoC needs. */

import { type Logger, nullLogger } from "../logger.ts";

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

export class TelegramClient {
  private readonly base: string;
  private readonly log: Logger;

  constructor(
    token: string,
    private readonly fetchImpl: FetchLike = fetch,
    logger: Logger = nullLogger,
  ) {
    this.base = `https://api.telegram.org/bot${token}`;
    this.log = logger.child().withContext({ component: "telegram-client" });
  }

  /**
   * Long-poll for updates from `offset`. Returns normalized text messages only.
   * Pass `signal` to abort an in-flight poll (used to shut down promptly on
   * SIGTERM rather than blocking up to `timeoutSec`).
   */
  async getUpdates(offset: number, timeoutSec = 25, signal?: AbortSignal): Promise<Update[]> {
    const url = `${this.base}/getUpdates?offset=${offset}&timeout=${timeoutSec}`;
    const res = await this.fetchImpl(url, { signal });
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

  async sendMessage(chatId: number, text: string): Promise<void> {
    const res = await this.fetchImpl(`${this.base}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text }),
    });
    if (!res.ok) {
      this.log
        .withMetadata({ chatId, status: res.status })
        .warn("sendMessage returned a non-2xx status");
    }
  }
}
