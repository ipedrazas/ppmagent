import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface SeenPR {
  url: string;
  repo: string;
  seenAt: number;
}

interface SeenPRsFile {
  prs: SeenPR[];
  updatedAt: number;
}

/**
 * File-backed store for PR notifications that have already been sent.
 * Persists across process restarts so webhook replays don't re-notify.
 */
export class PRNotificationStore {
  constructor(private readonly filePath: string) {}

  private read(): SeenPR[] {
    if (!existsSync(this.filePath)) return [];
    try {
      const raw = readFileSync(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<SeenPRsFile>;
      return Array.isArray(parsed.prs) ? (parsed.prs as SeenPR[]) : [];
    } catch {
      return [];
    }
  }

  private write(prs: SeenPR[]): void {
    const dir = dirname(this.filePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const file: SeenPRsFile = { prs, updatedAt: Date.now() };
    writeFileSync(this.filePath, JSON.stringify(file, null, 2));
  }

  hasSeen(url: string): boolean {
    return this.read().some((pr) => pr.url === url);
  }

  /** Record a PR notification as sent (idempotent — duplicate url is a no-op). */
  markSeen(pr: SeenPR): void {
    const prs = this.read();
    if (!prs.find((p) => p.url === pr.url)) {
      prs.push(pr);
      this.write(prs);
    }
  }
}
