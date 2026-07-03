import type { Logger } from "../logger.ts";
import type { PRNotificationStore } from "./pr-store.ts";

export interface GitHubPRPayload {
  action: string;
  pull_request: {
    title: string;
    html_url: string;
    number: number;
    draft: boolean;
    user: { login: string };
  };
  repository: {
    full_name: string;
  };
}

export interface PRHandlerDeps {
  store: PRNotificationStore;
  notify: (msg: string) => Promise<void>;
  monitoredRepos: string[];
  logger: Logger;
}

/**
 * Returns true if the repo full name (owner/repo) matches any pattern.
 * Patterns ending with `/*` match any repo under that owner.
 * An empty pattern list matches nothing.
 */
export function matchesMonitoredRepo(fullName: string, patterns: string[]): boolean {
  if (patterns.length === 0) return false;
  const [owner] = fullName.split("/");
  return patterns.some((pattern) => {
    if (pattern.endsWith("/*")) {
      return owner === pattern.slice(0, -2);
    }
    return fullName === pattern;
  });
}

export function formatPRNotification(payload: GitHubPRPayload): string {
  const { pull_request: pr, repository: repo } = payload;
  const verb = payload.action === "ready_for_review" ? "ready for review" : "opened";
  return `New PR ${verb}: ${pr.title}\nRepo: ${repo.full_name}\nAuthor: ${pr.user.login}\n${pr.html_url}`;
}

/**
 * Handle a GitHub pull_request webhook event. Filters by action, monitored
 * repos, and deduplicates before sending a Telegram notification.
 *
 * Draft PRs opened as drafts are skipped — we notify when they become
 * ready_for_review instead.
 */
export async function handlePREvent(payload: GitHubPRPayload, deps: PRHandlerDeps): Promise<void> {
  const { action, pull_request: pr, repository: repo } = payload;

  if (action === "opened" && pr.draft) return;
  if (action !== "opened" && action !== "ready_for_review") return;

  if (!matchesMonitoredRepo(repo.full_name, deps.monitoredRepos)) {
    deps.logger.withMetadata({ repo: repo.full_name }).debug("PR event from unmonitored repo");
    return;
  }

  if (deps.store.hasSeen(pr.html_url)) {
    deps.logger.withMetadata({ url: pr.html_url }).debug("PR already notified, skipping");
    return;
  }

  const msg = formatPRNotification(payload);
  try {
    await deps.notify(msg);
    deps.store.markSeen({ url: pr.html_url, repo: repo.full_name, seenAt: Date.now() });
    deps.logger.withMetadata({ url: pr.html_url, action }).info("PR notification sent");
  } catch (error) {
    deps.logger.withError(error).withMetadata({ url: pr.html_url }).warn("PR notification failed");
  }
}
