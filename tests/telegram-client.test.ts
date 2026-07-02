import { describe, expect, test } from "bun:test";
import { type FetchLike, TelegramClient } from "../src/telegram/client.ts";

describe("TelegramClient.getUpdates", () => {
  test("normalizes text messages and skips non-text updates", async () => {
    const fetchStub: FetchLike = async () =>
      new Response(
        JSON.stringify({
          ok: true,
          result: [
            { update_id: 5, message: { chat: { id: 42 }, text: "hello" } },
            { update_id: 6, message: { chat: { id: 42 } } }, // no text
          ],
        }),
      );
    const updates = await new TelegramClient("token", fetchStub).getUpdates(0);
    expect(updates).toEqual([
      { updateId: 5, message: { chatId: 42, text: "hello" } },
      { updateId: 6, message: undefined },
    ]);
  });

  test("passes the offset in the request url", async () => {
    let calledUrl = "";
    const fetchStub: FetchLike = async (url) => {
      calledUrl = url;
      return new Response(JSON.stringify({ ok: true, result: [] }));
    };
    await new TelegramClient("secret", fetchStub).getUpdates(99, 10);
    expect(calledUrl).toContain("/botsecret/getUpdates");
    expect(calledUrl).toContain("offset=99");
    expect(calledUrl).toContain("timeout=10");
  });
});

describe("TelegramClient.sendMessage", () => {
  test("posts chat_id + text as JSON", async () => {
    let body = "";
    const fetchStub: FetchLike = async (_url, init) => {
      body = String(init?.body ?? "");
      return new Response(JSON.stringify({ ok: true }));
    };
    await new TelegramClient("token", fetchStub).sendMessage(42, "hi there");
    expect(JSON.parse(body)).toEqual({ chat_id: 42, text: "hi there" });
  });

  test("includes parse_mode when MarkdownV2 is specified", async () => {
    let body = "";
    const fetchStub: FetchLike = async (_url, init) => {
      body = String(init?.body ?? "");
      return new Response(JSON.stringify({ ok: true }));
    };
    await new TelegramClient("token", fetchStub).sendMessage(42, "hi there", "MarkdownV2");
    expect(JSON.parse(body)).toEqual({ chat_id: 42, text: "hi there", parse_mode: "MarkdownV2" });
  });

  test("throws on a non-2xx response", async () => {
    const fetchStub: FetchLike = async () =>
      new Response(JSON.stringify({ ok: false, description: "Bad Request" }), { status: 400 });
    expect(new TelegramClient("token", fetchStub).sendMessage(42, "hi")).rejects.toThrow("400");
  });
});
