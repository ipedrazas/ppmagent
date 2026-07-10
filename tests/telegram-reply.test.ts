import { describe, expect, test } from "bun:test";
import { nullLogger } from "../src/logger.ts";
import { type FetchLike, TelegramClient } from "../src/telegram/client.ts";
import { sendReplies } from "../src/telegram/reply.ts";

describe("sendReplies", () => {
  test("sends MarkdownV2 when Telegram accepts it", async () => {
    const bodies: unknown[] = [];
    const fetchStub: FetchLike = async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body ?? "{}")));
      return new Response(JSON.stringify({ ok: true }));
    };
    const client = new TelegramClient("token", fetchStub);
    await sendReplies(client, nullLogger, 1, ["Hello **world**."]);
    expect(bodies).toHaveLength(1);
    expect((bodies[0] as { parse_mode?: string }).parse_mode).toBe("MarkdownV2");
  });

  test("falls back to plain text for a chunk Telegram rejects, without dropping it", async () => {
    const bodies: Array<{ text: string; parse_mode?: string }> = [];
    const fetchStub: FetchLike = async (_url, init) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { parse_mode?: string; text: string };
      bodies.push(body);
      if (body.parse_mode === "MarkdownV2") {
        return new Response(JSON.stringify({ ok: false, description: "can't parse entities" }), {
          status: 400,
        });
      }
      return new Response(JSON.stringify({ ok: true }));
    };
    const client = new TelegramClient("token", fetchStub);
    await sendReplies(client, nullLogger, 1, ["Some reply text."]);

    // First attempt: MarkdownV2, rejected. Second attempt: plain text fallback.
    expect(bodies).toHaveLength(2);
    expect(bodies[0]?.parse_mode).toBe("MarkdownV2");
    expect(bodies[1]?.parse_mode).toBeUndefined();
    expect(bodies[1]?.text).toBe("Some reply text.");
  });

  test("only retries the failing chunk(s) as plain text, not the whole message", async () => {
    const bodies: Array<{ text: string; parse_mode?: string }> = [];
    const bigCode = Array.from({ length: 500 }, (_, i) => `line ${i}`).join("\n");
    const text = `intro\n\`\`\`\n${bigCode}\n\`\`\``;
    const fetchStub: FetchLike = async (_url, init) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { parse_mode?: string; text: string };
      bodies.push(body);
      // Reject every MarkdownV2 chunk except the standalone "intro" one.
      if (body.parse_mode === "MarkdownV2" && !body.text.startsWith("intro")) {
        return new Response(JSON.stringify({ ok: false }), { status: 400 });
      }
      return new Response(JSON.stringify({ ok: true }));
    };
    const client = new TelegramClient("token", fetchStub);
    await sendReplies(client, nullLogger, 1, [text]);

    const introSends = bodies.filter((b) => b.text.startsWith("intro"));
    // "intro" was accepted as MarkdownV2 on the first try — never re-sent as plain text.
    expect(introSends).toHaveLength(1);
    expect(introSends[0]?.parse_mode).toBe("MarkdownV2");

    const plainTextBodies = bodies.filter((b) => b.parse_mode === undefined);
    expect(plainTextBodies.length).toBeGreaterThan(0);
    for (const b of plainTextBodies) {
      expect(b.text.startsWith("intro")).toBe(false);
    }
    // The rejected code-block content still made it through as plain text.
    expect(plainTextBodies.some((b) => b.text.includes("line 0"))).toBe(true);
    expect(plainTextBodies.some((b) => b.text.includes("line 499"))).toBe(true);
  });
});
