import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import type { PRHandlerDeps } from "../src/github/pr-handler.ts";
import type { PRNotificationStore } from "../src/github/pr-store.ts";
import { handleWebhookRequest } from "../src/github/webhook-server.ts";
import { nullLogger } from "../src/logger.ts";

const SECRET = "test-secret";

function sign(body: string, secret = SECRET): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

function makeDeps(notified: string[] = []): PRHandlerDeps {
  const store: PRNotificationStore = {
    hasSeen: () => false,
    markSeen: () => {},
  } as unknown as PRNotificationStore;
  return {
    store,
    notify: async (msg: string) => {
      notified.push(msg);
    },
    monitoredRepos: ["acme/*"],
    logger: nullLogger,
  };
}

const prPayload = JSON.stringify({
  action: "opened",
  pull_request: {
    title: "Fix bug",
    html_url: "https://github.com/acme/repo/pull/1",
    number: 1,
    draft: false,
    user: { login: "alice" },
  },
  repository: { full_name: "acme/repo" },
});

function makeRequest(
  body: string,
  opts: {
    method?: string;
    path?: string;
    event?: string;
    signature?: string | null;
  } = {},
): Request {
  const method = opts.method ?? "POST";
  const path = opts.path ?? "/webhook/github";
  const headers = new Headers({ "content-type": "application/json" });
  if (opts.event !== undefined) headers.set("x-github-event", opts.event);
  if (opts.signature !== undefined && opts.signature !== null) {
    headers.set("x-hub-signature-256", opts.signature);
  }
  return new Request(`http://localhost${path}`, { method, body, headers });
}

const opts = (notified: string[] = []) => ({
  secret: SECRET,
  prHandlerDeps: makeDeps(notified),
  logger: nullLogger,
});

describe("handleWebhookRequest", () => {
  test("returns 405 for non-POST requests", async () => {
    const req = makeRequest("", { method: "GET", event: "pull_request", signature: sign("") });
    const res = await handleWebhookRequest(req, opts());
    expect(res.status).toBe(405);
  });

  test("returns 404 for unknown paths", async () => {
    const req = makeRequest("", {
      path: "/unknown",
      event: "pull_request",
      signature: sign(""),
    });
    const res = await handleWebhookRequest(req, opts());
    expect(res.status).toBe(404);
  });

  test("returns 401 when signature header is missing", async () => {
    const req = makeRequest(prPayload, { event: "pull_request" });
    const res = await handleWebhookRequest(req, opts());
    expect(res.status).toBe(401);
  });

  test("returns 401 when signature is wrong", async () => {
    const req = makeRequest(prPayload, {
      event: "pull_request",
      signature: sign(prPayload, "wrong-secret"),
    });
    const res = await handleWebhookRequest(req, opts());
    expect(res.status).toBe(401);
  });

  test("returns 200 for non-pull_request events", async () => {
    const body = JSON.stringify({ action: "created" });
    const req = makeRequest(body, { event: "push", signature: sign(body) });
    const res = await handleWebhookRequest(req, opts());
    expect(res.status).toBe(200);
  });

  test("returns 200 for a valid pull_request event with correct signature", async () => {
    const req = makeRequest(prPayload, {
      event: "pull_request",
      signature: sign(prPayload),
    });
    const res = await handleWebhookRequest(req, opts());
    expect(res.status).toBe(200);
  });

  test("returns 400 for a pull_request event with invalid JSON body", async () => {
    const bad = "not-json{{";
    const req = makeRequest(bad, { event: "pull_request", signature: sign(bad) });
    const res = await handleWebhookRequest(req, opts());
    expect(res.status).toBe(400);
  });

  test("skips signature check when secret is empty", async () => {
    const req = makeRequest(prPayload, { event: "pull_request" });
    const res = await handleWebhookRequest(req, {
      secret: "",
      prHandlerDeps: makeDeps(),
      logger: nullLogger,
    });
    expect(res.status).toBe(200);
  });
});
