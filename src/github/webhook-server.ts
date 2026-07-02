import { createHmac, timingSafeEqual } from "node:crypto";
import type { Logger } from "../logger.ts";
import { type GitHubPRPayload, type PRHandlerDeps, handlePREvent } from "./pr-handler.ts";

export interface WebhookServerOptions {
  port: number;
  /** HMAC-SHA256 secret. Empty string = skip signature verification (dev only). */
  secret: string;
  prHandlerDeps: PRHandlerDeps;
  logger: Logger;
}

function verifySignature(body: string, signature: string, secret: string): boolean {
  const expected = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
  try {
    return timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch {
    // timingSafeEqual throws when buffers have different lengths
    return false;
  }
}

/**
 * Pure request handler, exported for unit testing without starting a real server.
 */
export async function handleWebhookRequest(
  req: Request,
  opts: Pick<WebhookServerOptions, "secret" | "prHandlerDeps" | "logger">,
): Promise<Response> {
  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  const url = new URL(req.url);
  if (url.pathname !== "/webhook/github") {
    return new Response("Not Found", { status: 404 });
  }

  const body = await req.text();

  if (opts.secret) {
    const signature = req.headers.get("x-hub-signature-256") ?? "";
    if (!signature || !verifySignature(body, signature, opts.secret)) {
      opts.logger.warn("GitHub webhook rejected: missing or invalid signature");
      return new Response("Unauthorized", { status: 401 });
    }
  }

  const event = req.headers.get("x-github-event");
  if (event !== "pull_request") {
    return new Response("OK", { status: 200 });
  }

  let payload: GitHubPRPayload;
  try {
    payload = JSON.parse(body) as GitHubPRPayload;
  } catch {
    return new Response("Bad Request", { status: 400 });
  }

  opts.logger
    .withMetadata({ action: payload.action, repo: payload.repository.full_name })
    .debug("pull_request event received");

  // Respond to GitHub immediately; notification is best-effort
  handlePREvent(payload, opts.prHandlerDeps).catch((err) => {
    opts.logger.withError(err).warn("PR event handler failed");
  });

  return new Response("OK", { status: 200 });
}

export class GitHubWebhookServer {
  private server: ReturnType<typeof Bun.serve> | null = null;

  constructor(private readonly opts: WebhookServerOptions) {}

  start(): void {
    const { port, secret, prHandlerDeps, logger } = this.opts;
    this.server = Bun.serve({
      port,
      fetch: (req) => handleWebhookRequest(req, { secret, prHandlerDeps, logger }),
    });
    logger.withMetadata({ port }).info("GitHub webhook server listening");
  }

  stop(): void {
    this.server?.stop();
    this.server = null;
  }
}
