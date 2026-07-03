import type { Logger } from "../logger.ts";
import type { MetricsCollector } from "./collector.ts";

export interface MetricsServerOptions {
  port: number;
  collector: MetricsCollector;
  logger: Logger;
}

/** Pure request handler, exported for unit testing without starting a real server. */
export function handleMetricsRequest(req: Request, collector: MetricsCollector): Response {
  const url = new URL(req.url);
  if (url.pathname !== "/metrics") {
    return new Response("Not Found", { status: 404 });
  }
  if (req.method !== "GET") {
    return new Response("Method Not Allowed", { status: 405 });
  }
  return new Response(JSON.stringify(collector.snapshot()), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

export class MetricsServer {
  private server: ReturnType<typeof Bun.serve> | null = null;

  constructor(private readonly opts: MetricsServerOptions) {}

  start(): void {
    const { port, collector, logger } = this.opts;
    this.server = Bun.serve({
      port,
      fetch: (req) => handleMetricsRequest(req, collector),
    });
    logger.withMetadata({ port }).info("metrics server listening");
  }

  stop(): void {
    this.server?.stop();
    this.server = null;
  }
}
