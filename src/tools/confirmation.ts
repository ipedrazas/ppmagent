const TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

export interface PendingConfirmation {
  description: string;
  execute: (signal?: AbortSignal) => Promise<string>;
  expiresAt: number;
}

/**
 * Single-slot store for a mutation that is waiting for user approval.
 * A new `set()` replaces any previous pending confirmation.
 */
export class ConfirmationStore {
  private pending: PendingConfirmation | null = null;

  set(description: string, execute: (signal?: AbortSignal) => Promise<string>): void {
    this.pending = { description, execute, expiresAt: Date.now() + TIMEOUT_MS };
  }

  get(): PendingConfirmation | null {
    return this.pending;
  }

  clear(): void {
    this.pending = null;
  }

  hasPending(): boolean {
    return this.pending !== null;
  }

  isExpired(): boolean {
    return this.pending !== null && Date.now() >= this.pending.expiresAt;
  }
}

/** Standard suffix appended to every confirmation prompt sent to the user. */
export const CONFIRM_SUFFIX = "\n\nReply yes to confirm or no to cancel (expires in 5 min).";

/** True when the text is an affirmative reply (yes, y, approve, ok, confirm). */
export function isApproval(text: string): boolean {
  return /^(yes|y|approve|ok|confirm)\b/i.test(text.trim());
}

/** True when the text is a rejection (no, n, cancel, reject, abort). */
export function isRejection(text: string): boolean {
  return /^(no|n|cancel|reject|abort)\b/i.test(text.trim());
}
