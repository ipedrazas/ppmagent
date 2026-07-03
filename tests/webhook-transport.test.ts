import { describe, expect, test } from "bun:test";
import { nullLogger } from "../src/logger.ts";
import { handleWebhookRequest } from "../src/telegram/webhook-transport.ts";

const SECRET = "test-secret-token";

function makeUpdate(chatId: number, text: string, updateId = 1) {
  return JSON.stringify({ update_id: updateId, message: { chat: { id: chatId }, text } });
}

function makeRequest(
  body: string,
  opts: { method?: string; path?: string; secretHeader?: string | null } = {},
): Request {
  const method = opts.method ?? "POST";
  const path = opts.path ?? "/webhook/telegram";
  const headers = new Headers({ "content-type": "application/json" });
  if (opts.secretHeader !== undefined && opts.secretHeader !== null) {
    headers.set("X-Telegram-Bot-Api-Secret-Token", opts.secretHeader);
  }
  return new Request(`http://localhost${path}`, { method, body, headers });
}

function makeOpts(
  received: Array<{ chatId: number; text: string }>,
  overrides: Partial<Parameters<typeof handleWebhookRequest>[1]> = {},
): Parameters<typeof handleWebhookRequest>[1] {
  return {
    handleMessage: async (chatId, text) => {
      received.push({ chatId, text });
    },
    logger: nullLogger,
    ...overrides,
  };
}

describe("handleWebhookRequest", () => {
  test("returns 405 for non-POST requests", async () => {
    const res = await handleWebhookRequest(makeRequest("", { method: "GET" }), makeOpts([]));
    expect(res.status).toBe(405);
  });

  test("returns 404 for unknown paths", async () => {
    const res = await handleWebhookRequest(makeRequest("", { path: "/other" }), makeOpts([]));
    expect(res.status).toBe(404);
  });

  test("returns 401 when secret token is wrong", async () => {
    const res = await handleWebhookRequest(
      makeRequest(makeUpdate(1, "hi"), { secretHeader: "wrong" }),
      makeOpts([], { secretToken: SECRET }),
    );
    expect(res.status).toBe(401);
  });

  test("returns 401 when secret token header is missing but token is configured", async () => {
    const res = await handleWebhookRequest(
      makeRequest(makeUpdate(1, "hi")),
      makeOpts([], { secretToken: SECRET }),
    );
    expect(res.status).toBe(401);
  });

  test("returns 400 for invalid JSON body", async () => {
    const res = await handleWebhookRequest(makeRequest("not-json{{"), makeOpts([]));
    expect(res.status).toBe(400);
  });

  test("returns 200 and dispatches message when valid", async () => {
    const received: Array<{ chatId: number; text: string }> = [];
    const res = await handleWebhookRequest(
      makeRequest(makeUpdate(42, "hello")),
      makeOpts(received),
    );
    expect(res.status).toBe(200);
    // handleMessage is fire-and-forget — give it a tick to run
    await Bun.sleep(5);
    expect(received).toHaveLength(1);
    expect(received[0]).toEqual({ chatId: 42, text: "hello" });
  });

  test("returns 200 with correct secret token", async () => {
    const received: Array<{ chatId: number; text: string }> = [];
    const res = await handleWebhookRequest(
      makeRequest(makeUpdate(7, "hi"), { secretHeader: SECRET }),
      makeOpts(received, { secretToken: SECRET }),
    );
    expect(res.status).toBe(200);
  });

  test("skips verification when no secretToken is configured", async () => {
    const received: Array<{ chatId: number; text: string }> = [];
    const res = await handleWebhookRequest(makeRequest(makeUpdate(3, "open")), makeOpts(received));
    expect(res.status).toBe(200);
    await Bun.sleep(5);
    expect(received).toHaveLength(1);
  });

  test("returns 200 but skips dispatch for disallowed chat", async () => {
    const received: Array<{ chatId: number; text: string }> = [];
    const res = await handleWebhookRequest(
      makeRequest(makeUpdate(999, "intruder")),
      makeOpts(received, { allowedChatId: 42 }),
    );
    expect(res.status).toBe(200);
    await Bun.sleep(5);
    expect(received).toHaveLength(0);
  });

  test("dispatches for the allowed chat id", async () => {
    const received: Array<{ chatId: number; text: string }> = [];
    const res = await handleWebhookRequest(
      makeRequest(makeUpdate(42, "allowed")),
      makeOpts(received, { allowedChatId: 42 }),
    );
    expect(res.status).toBe(200);
    await Bun.sleep(5);
    expect(received[0]).toEqual({ chatId: 42, text: "allowed" });
  });

  test("returns 200 for an update with no message text (non-text update)", async () => {
    const body = JSON.stringify({ update_id: 1, message: { chat: { id: 1 } } }); // no text
    const res = await handleWebhookRequest(makeRequest(body), makeOpts([]));
    expect(res.status).toBe(200);
  });

  test("sends a helpful reply for photo messages when sendMessage is provided", async () => {
    const replied: Array<{ chatId: number; text: string }> = [];
    const body = JSON.stringify({
      update_id: 1,
      message: { chat: { id: 7 }, photo: [{}] },
    });
    const res = await handleWebhookRequest(
      makeRequest(body),
      makeOpts([], {
        sendMessage: async (chatId, text) => {
          replied.push({ chatId, text });
        },
      }),
    );
    expect(res.status).toBe(200);
    await Bun.sleep(5);
    expect(replied).toHaveLength(1);
    expect(replied[0]?.chatId).toBe(7);
    expect(replied[0]?.text).toContain("photo");
  });

  test("sends a helpful reply for edited_message updates when sendMessage is provided", async () => {
    const replied: Array<{ chatId: number; text: string }> = [];
    const body = JSON.stringify({
      update_id: 2,
      edited_message: { chat: { id: 9 }, text: "edited text" },
    });
    const res = await handleWebhookRequest(
      makeRequest(body),
      makeOpts([], {
        sendMessage: async (chatId, text) => {
          replied.push({ chatId, text });
        },
      }),
    );
    expect(res.status).toBe(200);
    await Bun.sleep(5);
    expect(replied).toHaveLength(1);
    expect(replied[0]?.chatId).toBe(9);
    expect(replied[0]?.text).toContain("edit");
  });

  test("does not call handleMessage for non-text messages", async () => {
    const received: Array<{ chatId: number; text: string }> = [];
    const body = JSON.stringify({
      update_id: 3,
      message: { chat: { id: 5 }, voice: {} },
    });
    const res = await handleWebhookRequest(makeRequest(body), makeOpts(received));
    expect(res.status).toBe(200);
    await Bun.sleep(5);
    expect(received).toHaveLength(0);
  });
});
