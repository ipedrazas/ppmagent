/**
 * Sending replies to Telegram, shared by the command router and turn runner.
 */
import type { Logger } from "../logger.ts";
import type { TelegramClient } from "./client.ts";
import { toMarkdownV2Chunks } from "./mdv2.ts";

/** Deliver one or more reply messages to a chat. */
export type Send = (chatId: number, messages: string[]) => Promise<void>;

/**
 * Send each message as Telegram MarkdownV2, falling back to plain text if
 * Telegram rejects the formatting (e.g. a malformed entity) so a reply is never
 * silently dropped.
 *
 * Messages are split into MarkdownV2-safe chunks before sending — never at an
 * arbitrary byte offset — so a long reply can't get cut mid-entity (e.g.
 * inside a fenced code block) and each chunk falls back to its own raw text
 * independently if Telegram still rejects it.
 */
export async function sendReplies(
  client: TelegramClient,
  log: Logger,
  chatId: number,
  messages: string[],
): Promise<void> {
  for (const text of messages) {
    for (const { raw, formatted } of toMarkdownV2Chunks(text)) {
      try {
        await client.sendMessage(chatId, formatted, "MarkdownV2");
      } catch {
        // MarkdownV2 was rejected by Telegram (e.g. malformed entity) — retry
        // as plain text so the message is never silently dropped.
        log.withMetadata({ chatId }).warn("MarkdownV2 send failed; retrying as plain text");
        await client.sendMessage(chatId, raw);
      }
    }
  }
}
