/**
 * Natural language → epoch-milliseconds parser for reminder "when" expressions.
 *
 * Accepts:
 *   ISO 8601 datetimes / dates  ("2025-07-07T09:00:00", "2025-07-08")
 *   Relative offsets            ("in 2 hours", "in 30 minutes", "in 3 days")
 *   Named times of day          ("tomorrow", "tonight", "this morning", etc.)
 *   Absolute clock times        ("at 3pm", "at 15:30")
 *   Weekday names               ("next Monday", "Friday")
 */

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

/**
 * Parse a clock string like "3pm", "3:30pm", "15:30", "9am".
 * Returns { h, m } in 24-hour format, or null if not recognised.
 */
function parseClock(s: string): { h: number; m: number } | null {
  s = s.trim().toLowerCase();
  // "3pm" / "3am"
  const simple = s.match(/^(\d{1,2})(am|pm)$/);
  if (simple) {
    let h = parseInt(simple[1], 10);
    const pm = simple[2] === "pm";
    if (h < 1 || h > 12) return null;
    if (pm && h !== 12) h += 12;
    if (!pm && h === 12) h = 0;
    return { h, m: 0 };
  }
  // "3:30pm" / "3:30am"
  const withMin = s.match(/^(\d{1,2}):(\d{2})(am|pm)$/);
  if (withMin) {
    let h = parseInt(withMin[1], 10);
    const m = parseInt(withMin[2], 10);
    const pm = withMin[3] === "pm";
    if (h < 1 || h > 12 || m > 59) return null;
    if (pm && h !== 12) h += 12;
    if (!pm && h === 12) h = 0;
    return { h, m };
  }
  // "15:30" (24-hour)
  const h24 = s.match(/^(\d{1,2}):(\d{2})$/);
  if (h24) {
    const h = parseInt(h24[1], 10);
    const m = parseInt(h24[2], 10);
    if (h > 23 || m > 59) return null;
    return { h, m };
  }
  return null;
}

/** Returns epoch ms for the next occurrence of H:mm on or after `now`. */
function nextClockToday(ref: Date, h: number, m: number, now: number): number {
  const candidate = new Date(ref);
  candidate.setHours(h, m, 0, 0);
  return candidate.getTime() > now ? candidate.getTime() : candidate.getTime() + 86_400_000;
}

/** Returns epoch ms for tomorrow (relative to ref) at H:mm. */
function tomorrowAt(ref: Date, h: number, m: number): number {
  const d = new Date(ref);
  d.setDate(d.getDate() + 1);
  d.setHours(h, m, 0, 0);
  return d.getTime();
}

/** Returns epoch ms for the next occurrence of the given weekday (0=Sun) at H:mm. */
function nextWeekday(ref: Date, targetDay: number, h: number, m: number): number {
  const d = new Date(ref);
  d.setHours(h, m, 0, 0);
  const currentDay = d.getDay();
  let daysAhead = targetDay - currentDay;
  if (daysAhead <= 0) daysAhead += 7; // always "next" occurrence
  d.setDate(d.getDate() + daysAhead);
  return d.getTime();
}

/**
 * Parse a natural-language time expression and return the corresponding
 * epoch milliseconds. `now` defaults to `Date.now()`.
 * Returns `null` when the expression is not recognised.
 */
export function parseWhen(when: string, now: number = Date.now()): number | null {
  const trimmed = when.trim();
  const lower = trimmed.toLowerCase();
  const ref = new Date(now);

  // ── ISO 8601 datetime / date ──────────────────────────────────────────────
  // "2025-07-08T09:00:00" or "2025-07-08" (treat date-only as 09:00 local)
  const isoDateTime = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2})?)?/.test(trimmed);
  if (isoDateTime) {
    const parsed = Date.parse(trimmed.includes("T") ? trimmed : trimmed + "T09:00:00");
    if (!isNaN(parsed)) return parsed;
  }

  // ── Relative offsets: "in N unit" ─────────────────────────────────────────
  const inMatch = lower.match(
    /^in\s+(\d+)\s*(minutes?|mins?|hours?|hrs?|days?|weeks?)$/,
  );
  if (inMatch) {
    const n = parseInt(inMatch[1], 10);
    const unit = inMatch[2];
    if (/^min|^min/.test(unit)) return now + n * 60_000;
    if (/^hr|^hour/.test(unit)) return now + n * 3_600_000;
    if (/^day/.test(unit)) return now + n * 86_400_000;
    if (/^week/.test(unit)) return now + n * 7 * 86_400_000;
  }

  // ── Named moment: tomorrow [at time] ─────────────────────────────────────
  if (lower === "tomorrow") return tomorrowAt(ref, 9, 0);

  const tomorrowAt_match = lower.match(/^tomorrow\s+at\s+(.+)$/);
  if (tomorrowAt_match) {
    const clock = parseClock(tomorrowAt_match[1]);
    if (clock) return tomorrowAt(ref, clock.h, clock.m);
  }

  const tomorrowMorning = lower.match(/^tomorrow\s+(morning)$/);
  if (tomorrowMorning) return tomorrowAt(ref, 9, 0);

  const tomorrowAfternoon = lower.match(/^tomorrow\s+(afternoon)$/);
  if (tomorrowAfternoon) return tomorrowAt(ref, 15, 0);

  const tomorrowEvening = lower.match(/^tomorrow\s+(evening)$/);
  if (tomorrowEvening) return tomorrowAt(ref, 19, 0);

  // ── Named moment: today shortcuts ─────────────────────────────────────────
  if (lower === "tonight" || lower === "this evening") return nextClockToday(ref, 20, 0, now);
  if (lower === "this morning") return nextClockToday(ref, 9, 0, now);
  if (lower === "this afternoon") return nextClockToday(ref, 15, 0, now);

  // ── "at <time>" ───────────────────────────────────────────────────────────
  const atMatch = lower.match(/^at\s+(.+)$/);
  if (atMatch) {
    const clock = parseClock(atMatch[1]);
    if (clock) return nextClockToday(ref, clock.h, clock.m, now);
  }

  // ── Weekday names ("next Monday", "Friday") ───────────────────────────────
  const weekdayMatch = lower.match(/^(?:next\s+)?(\w+)(?:\s+at\s+(.+))?$/);
  if (weekdayMatch) {
    const dayName = weekdayMatch[1];
    const dayIdx = WEEKDAYS.indexOf(dayName);
    if (dayIdx !== -1) {
      const clock = weekdayMatch[2] ? parseClock(weekdayMatch[2]) : null;
      const h = clock?.h ?? 9;
      const m = clock?.m ?? 0;
      return nextWeekday(ref, dayIdx, h, m);
    }
  }

  return null;
}

/** Format an epoch-ms timestamp as a human-readable string. */
export function formatDueAt(dueAt: number): string {
  return new Date(dueAt).toLocaleString("en-GB", {
    weekday: "short",
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
