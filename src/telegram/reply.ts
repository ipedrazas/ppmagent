/**
 * Sending replies to Telegram, shared by the command router and turn runner.
 */
import type { Logger } from "../logger.ts";
import type { TelegramClient } from "./client.ts";
import { toMarkdownV2 } from "./mdv2.ts";

/** Deliver one or more reply messages to a chat. */
export type Send = (chatId: number, messages: string[]) => Promise<void>;

/**
 * Send each message as Telegram MarkdownV2, falling back to plain text if
 * Telegram rejects the formatting (e.g. a malformed entity) so a reply is never
 * silently dropped.
 */
export async function sendReplies(
  client: TelegramClient,
  log: Logger,
  chatId: number,
  messages: string[],
): Promise<void> {
  for (const text of messages) {
    const formatted = toMarkdownV2(text);
    try {
      await client.sendMessage(chatId, formatted, "MarkdownV2");
    } catch {
      // MarkdownV2 was rejected by Telegram (e.g. malformed entity) — retry as
      // plain text so the message is never silently dropped.
      log.withMetadata({ chatId }).warn("MarkdownV2 send failed; retrying as plain text");
      await client.sendMessage(chatId, text);
    }
  }
}
