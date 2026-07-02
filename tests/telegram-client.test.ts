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

  test("attaches an http timeout signal to each request", async () => {
    let capturedInit: RequestInit | undefined;
    const fetchStub: FetchLike = async (_url, init) => {
      capturedInit = init;
      return new Response(JSON.stringify({ ok: true, result: [] }));
    };
    await new TelegramClient("token", fetchStub).getUpdates(0, 25);
    expect(capturedInit?.signal).toBeDefined();
  });

  test("combines caller abort signal with the http timeout", async () => {
    let capturedInit: RequestInit | undefined;
    const fetchStub: FetchLike = async (_url, init) => {
      capturedInit = init;
      return new Response(JSON.stringify({ ok: true, result: [] }));
    };
    const controller = new AbortController();
    await new TelegramClient("token", fetchStub).getUpdates(0, 25, controller.signal);
    expect(capturedInit?.signal).toBeDefined();
    // Aborting the controller should also abort the combined signal
    controller.abort();
    expect(capturedInit?.signal?.aborted).toBe(true);
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

  test("attaches a timeout signal to each sendMessage request", async () => {
    let capturedInit: RequestInit | undefined;
    const fetchStub: FetchLike = async (_url, init) => {
      capturedInit = init;
      return new Response(JSON.stringify({ ok: true }));
    };
    await new TelegramClient("token", fetchStub).sendMessage(1, "hello");
    expect(capturedInit?.signal).toBeDefined();
  });

  test("splits messages over 4096 chars into multiple requests", async () => {
    const bodies: string[] = [];
    const fetchStub: FetchLike = async (_url, init) => {
      bodies.push(String(init?.body ?? ""));
      return new Response(JSON.stringify({ ok: true }));
    };
    // Build a message with a natural split point: two halves of 3000 chars joined by a newline
    const half = "a".repeat(3000);
    const longText = `${half}\n${half}`;
    await new TelegramClient("token", fetchStub).sendMessage(7, longText);
    expect(bodies.length).toBe(2);
    const [first, second] = bodies.map((b) => JSON.parse(b));
    expect(first.text.length).toBeLessThanOrEqual(4096);
    expect(second.text.length).toBeLessThanOrEqual(4096);
    expect(first.chat_id).toBe(7);
    expect(second.chat_id).toBe(7);
  });

  test("hard-splits messages with no natural boundary", async () => {
    const bodies: string[] = [];
    const fetchStub: FetchLike = async (_url, init) => {
      bodies.push(String(init?.body ?? ""));
      return new Response(JSON.stringify({ ok: true }));
    };
    const longText = "x".repeat(5000);
    await new TelegramClient("token", fetchStub).sendMessage(1, longText);
    expect(bodies.length).toBe(2);
    for (const b of bodies) {
      expect(JSON.parse(b).text.length).toBeLessThanOrEqual(4096);
    }
  });

  test("retries on 429 after the retry_after delay and sends successfully", async () => {
    const delays: number[] = [];
    const origSetTimeout = globalThis.setTimeout;
    // Intercept setTimeout to record the delay without actually waiting
    (globalThis as unknown as Record<string, unknown>).setTimeout = (
      fn: () => void,
      ms: number,
    ) => {
      delays.push(ms);
      fn(); // resolve immediately in tests
      return 0 as unknown as ReturnType<typeof setTimeout>;
    };

    let callCount = 0;
    const fetchStub: FetchLike = async () => {
      callCount++;
      if (callCount === 1) {
        return new Response(JSON.stringify({ ok: false, parameters: { retry_after: 2 } }), {
          status: 429,
        });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    };

    await new TelegramClient("token", fetchStub).sendMessage(1, "hello");
    (globalThis as unknown as Record<string, unknown>).setTimeout = origSetTimeout;

    expect(callCount).toBe(2);
    expect(delays).toEqual([2000]);
  });

  test("uses default retry_after of 5s when parameter is absent", async () => {
    const delays: number[] = [];
    const origSetTimeout = globalThis.setTimeout;
    (globalThis as unknown as Record<string, unknown>).setTimeout = (
      fn: () => void,
      ms: number,
    ) => {
      delays.push(ms);
      fn();
      return 0 as unknown as ReturnType<typeof setTimeout>;
    };

    let callCount = 0;
    const fetchStub: FetchLike = async () => {
      callCount++;
      if (callCount === 1) {
        return new Response(JSON.stringify({ ok: false }), { status: 429 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    };

    await new TelegramClient("token", fetchStub).sendMessage(1, "hello");
    (globalThis as unknown as Record<string, unknown>).setTimeout = origSetTimeout;

    expect(delays).toEqual([5000]);
  });
});
