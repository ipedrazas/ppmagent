import { S3Client } from "bun";
import type { SessionBucketConfig } from "../config.ts";
import { type Logger, nullLogger } from "../logger.ts";

/** Where {@link SessionStore} sends each session file after writing it locally. */
export interface SessionMirror {
  /** Queue an upload of the session's file body. Never throws. */
  put(sessionId: string, body: string): void;
}

/** The object operation the mirror needs; `Bun.S3Client` satisfies it. */
export interface ObjectWriter {
  write(key: string, body: string, options?: { type?: string }): Promise<unknown>;
}

/**
 * Mirrors session files into an S3-compatible bucket (Tigris by default) so
 * casa can read them with `casa analyze t3://bucket/prefix/` or its Bucket tab.
 * The local store stays the source of truth; the bucket is a best-effort copy.
 * Objects are never deleted: the bucket keeps sessions after local retention
 * removes them, so casa can still analyse old conversations.
 *
 * Uploads are off the turn's critical path and coalesced per session: a save
 * that lands while that session's upload is in flight replaces the queued body,
 * so a burst of saves costs at most one extra PUT and the last one always wins.
 * Failures are logged, never thrown — a bucket outage must not break a turn.
 */
export class SessionBucket implements SessionMirror {
  private readonly log: Logger;
  /** Latest body waiting to be uploaded, per session. */
  private readonly pending = new Map<string, string>();
  /** The running upload loop, per session. */
  private readonly inflight = new Map<string, Promise<void>>();

  constructor(
    private readonly client: ObjectWriter,
    private readonly prefix: string,
    logger?: Logger,
  ) {
    this.log = (logger ?? nullLogger).child().withContext({ component: "session-bucket" });
  }

  /** Build a mirror from config, talking to the bucket through `Bun.S3Client`. */
  static fromConfig(cfg: SessionBucketConfig, logger?: Logger): SessionBucket {
    const client = new S3Client({
      bucket: cfg.bucket,
      endpoint: cfg.endpoint || undefined,
      region: cfg.region,
      accessKeyId: cfg.accessKeyId,
      secretAccessKey: cfg.secretAccessKey,
    });
    return new SessionBucket(client, cfg.prefix, logger);
  }

  key(sessionId: string): string {
    return `${this.prefix}${sessionId}.json`;
  }

  put(sessionId: string, body: string): void {
    this.pending.set(sessionId, body);
    if (!this.inflight.has(sessionId)) {
      this.inflight.set(sessionId, this.drain(sessionId));
    }
  }

  /** Wait for every queued upload; call before exiting. */
  async flush(): Promise<void> {
    while (this.inflight.size > 0) {
      await Promise.all(this.inflight.values());
    }
  }

  private async drain(sessionId: string): Promise<void> {
    try {
      for (
        let body = this.pending.get(sessionId);
        body !== undefined;
        body = this.pending.get(sessionId)
      ) {
        this.pending.delete(sessionId);
        const key = this.key(sessionId);
        try {
          await this.client.write(key, body, { type: "application/json" });
          this.log.withMetadata({ key, bytes: body.length }).debug("session uploaded");
        } catch (error) {
          this.log.withError(error).withMetadata({ key }).warn("session upload failed");
        }
      }
    } finally {
      this.inflight.delete(sessionId);
    }
  }
}
