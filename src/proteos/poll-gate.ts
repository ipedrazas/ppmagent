/**
 * Backoff between repeated status polls of the same subject, in ms, indexed by
 * how many times it has already been checked. The first check is always free;
 * after that the model must wait 1s, then 10s, 30s, 90s, and finally 5m between
 * checks. The last entry is the steady-state cap.
 */
export const POLL_BACKOFF_MS = [1_000, 10_000, 30_000, 90_000, 300_000];

/**
 * Quiet period after which a subject's backoff resets to the start. A check that
 * comes this long after the previous one is a fresh user-driven question, not a
 * poll loop, so it should not inherit a 5m penalty.
 */
export const POLL_RESET_MS = 10 * 60_000;

/**
 * Consecutive blocked attempts tolerated before the turn is terminated. One
 * block is a nudge the model can act on; a second means it is looping and only
 * ending the turn will stop it.
 */
export const BLOCKS_BEFORE_TERMINATE = 2;

interface Entry {
  /** Number of polls actually executed for this key. */
  checks: number;
  lastCheckedAt: number;
  lastOutput: string;
  /** Consecutive blocked attempts since the last executed poll. */
  blocked: number;
}

export interface PollDecision {
  allowed: boolean;
  /** Time left before the next poll is permitted (0 when allowed). */
  waitMs: number;
  /** Output of the last executed poll, so a blocked caller is never data-starved. */
  lastOutput?: string;
  /** How long ago that output was fetched. */
  ageMs?: number;
  /** Consecutive blocked attempts including this one (0 when allowed). */
  blocked: number;
}

/**
 * Per-subject poll rate limiter with exponential-ish backoff.
 *
 * Status reads (`proteos task get`, `proteos task list`) are cheap enough that
 * the model will happily fire them several times a second while "waiting" for a
 * dispatched task — the prompt says not to, and roughly a third of the time it
 * does anyway. This makes the limit structural: a poll that arrives too soon is
 * never sent to the CLI, and the caller gets the last known output back with the
 * time it must wait.
 */
export class PollGate {
  private readonly entries = new Map<string, Entry>();

  constructor(private readonly now: () => number = Date.now) {}

  /** Decide whether `key` may be polled right now. Records the block if not. */
  check(key: string): PollDecision {
    const entry = this.entries.get(key);
    if (!entry) return { allowed: true, waitMs: 0, blocked: 0 };

    const elapsed = this.now() - entry.lastCheckedAt;
    if (elapsed >= POLL_RESET_MS) {
      this.entries.delete(key);
      return { allowed: true, waitMs: 0, blocked: 0 };
    }

    const required = POLL_BACKOFF_MS[Math.min(entry.checks - 1, POLL_BACKOFF_MS.length - 1)] ?? 0;
    if (elapsed >= required) return { allowed: true, waitMs: 0, blocked: 0 };

    entry.blocked += 1;
    return {
      allowed: false,
      waitMs: required - elapsed,
      lastOutput: entry.lastOutput,
      ageMs: elapsed,
      blocked: entry.blocked,
    };
  }

  /** Record an executed poll, advancing `key` to the next backoff step. */
  record(key: string, output: string): void {
    const now = this.now();
    const prev = this.entries.get(key);
    this.entries.set(key, {
      checks: (prev?.checks ?? 0) + 1,
      lastCheckedAt: now,
      lastOutput: output,
      blocked: 0,
    });
    this.prune(now);
  }

  /** Clear a subject's backoff — used when it changes (dispatch, follow-up turn). */
  reset(key: string): void {
    this.entries.delete(key);
  }

  private prune(now: number): void {
    for (const [key, entry] of this.entries) {
      if (now - entry.lastCheckedAt >= POLL_RESET_MS) this.entries.delete(key);
    }
  }
}

/** Human-readable duration for the "wait N before checking again" message. */
export function formatWait(ms: number): string {
  const seconds = Math.max(1, Math.ceil(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest === 0 ? `${minutes}m` : `${minutes}m ${rest}s`;
}
