import { describe, expect, test } from "bun:test";
import type { PRHandlerDeps } from "../src/github/pr-handler.ts";
import {
  type GitHubPRPayload,
  formatPRNotification,
  handlePREvent,
  matchesMonitoredRepo,
} from "../src/github/pr-handler.ts";
import type { PRNotificationStore } from "../src/github/pr-store.ts";
import { nullLogger } from "../src/logger.ts";

// ── matchesMonitoredRepo ──────────────────────────────────────────────────────

describe("matchesMonitoredRepo", () => {
  test("wildcard owner/* matches any repo under that owner", () => {
    expect(matchesMonitoredRepo("acme/foo", ["acme/*"])).toBe(true);
    expect(matchesMonitoredRepo("acme/bar", ["acme/*"])).toBe(true);
  });

  test("wildcard does not match a different owner", () => {
    expect(matchesMonitoredRepo("other/foo", ["acme/*"])).toBe(false);
  });

  test("exact pattern matches only that repo", () => {
    expect(matchesMonitoredRepo("acme/specific", ["acme/specific"])).toBe(true);
    expect(matchesMonitoredRepo("acme/other", ["acme/specific"])).toBe(false);
  });

  test("empty pattern list matches nothing", () => {
    expect(matchesMonitoredRepo("acme/foo", [])).toBe(false);
  });

  test("first matching pattern wins (multiple patterns)", () => {
    expect(matchesMonitoredRepo("acme/foo", ["other/*", "acme/*"])).toBe(true);
  });
});

// ── formatPRNotification ──────────────────────────────────────────────────────

describe("formatPRNotification", () => {
  const base: GitHubPRPayload = {
    action: "opened",
    pull_request: {
      title: "Fix the bug",
      html_url: "https://github.com/acme/repo/pull/42",
      number: 42,
      draft: false,
      user: { login: "alice" },
    },
    repository: { full_name: "acme/repo" },
  };

  test("includes PR title, repo, author, and URL for opened action", () => {
    const msg = formatPRNotification(base);
    expect(msg).toContain("Fix the bug");
    expect(msg).toContain("acme/repo");
    expect(msg).toContain("alice");
    expect(msg).toContain("https://github.com/acme/repo/pull/42");
    expect(msg).toContain("opened");
  });

  test("uses 'ready for review' verb for ready_for_review action", () => {
    const msg = formatPRNotification({ ...base, action: "ready_for_review" });
    expect(msg).toContain("ready for review");
    expect(msg).not.toContain("opened");
  });
});

// ── handlePREvent ─────────────────────────────────────────────────────────────

function makeStore(seen: string[] = []): PRNotificationStore {
  const seenSet = new Set(seen);
  const marked: string[] = [];
  return {
    hasSeen: (url: string) => seenSet.has(url),
    markSeen: ({ url }: { url: string; repo: string; seenAt: number }) => {
      seenSet.add(url);
      marked.push(url);
    },
  } as unknown as PRNotificationStore;
}

function makeDeps(overrides: Partial<PRHandlerDeps> = {}): PRHandlerDeps & { notified: string[] } {
  const notified: string[] = [];
  return {
    store: makeStore(),
    notify: async (msg: string) => {
      notified.push(msg);
    },
    monitoredRepos: ["acme/*"],
    logger: nullLogger,
    notified,
    ...overrides,
  };
}

const openedPayload: GitHubPRPayload = {
  action: "opened",
  pull_request: {
    title: "Add feature",
    html_url: "https://github.com/acme/repo/pull/1",
    number: 1,
    draft: false,
    user: { login: "bob" },
  },
  repository: { full_name: "acme/repo" },
};

describe("handlePREvent", () => {
  test("sends notification for a new non-draft opened PR", async () => {
    const deps = makeDeps();
    await handlePREvent(openedPayload, deps);
    expect(deps.notified).toHaveLength(1);
    expect(deps.notified[0]).toContain("Add feature");
  });

  test("sends notification for ready_for_review action", async () => {
    const deps = makeDeps();
    await handlePREvent({ ...openedPayload, action: "ready_for_review" }, deps);
    expect(deps.notified).toHaveLength(1);
  });

  test("skips draft PRs opened as drafts", async () => {
    const deps = makeDeps();
    const draft: GitHubPRPayload = {
      ...openedPayload,
      pull_request: { ...openedPayload.pull_request, draft: true },
    };
    await handlePREvent(draft, deps);
    expect(deps.notified).toHaveLength(0);
  });

  test("skips events with unrelated actions (e.g. closed)", async () => {
    const deps = makeDeps();
    await handlePREvent({ ...openedPayload, action: "closed" }, deps);
    expect(deps.notified).toHaveLength(0);
  });

  test("skips PRs from repos not in the monitored list", async () => {
    const deps = makeDeps();
    const foreign: GitHubPRPayload = {
      ...openedPayload,
      repository: { full_name: "stranger/repo" },
    };
    await handlePREvent(foreign, deps);
    expect(deps.notified).toHaveLength(0);
  });

  test("deduplicates — does not notify for an already-seen PR", async () => {
    const deps = makeDeps({
      store: makeStore([openedPayload.pull_request.html_url]),
    });
    await handlePREvent(openedPayload, deps);
    expect(deps.notified).toHaveLength(0);
  });

  test("marks the PR as seen after notifying", async () => {
    const seen: string[] = [];
    const store = makeStore();
    const origMark = store.markSeen.bind(store);
    store.markSeen = (pr) => {
      seen.push(pr.url);
      origMark(pr);
    };
    const deps = makeDeps({ store });
    await handlePREvent(openedPayload, deps);
    expect(seen).toContain(openedPayload.pull_request.html_url);
  });

  test("does not mark seen when notify throws", async () => {
    const marked: string[] = [];
    const store = makeStore();
    store.markSeen = (pr) => marked.push(pr.url);
    const deps = makeDeps({
      store,
      notify: async () => {
        throw new Error("telegram down");
      },
    });
    await handlePREvent(openedPayload, deps);
    expect(marked).toHaveLength(0);
  });
});
