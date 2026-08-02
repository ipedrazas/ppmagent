import { describe, expect, test } from "bun:test";
import { formatWait, POLL_RESET_MS, PollGate } from "../src/proteos/poll-gate.ts";

/** A PollGate over a clock the test moves by hand. */
function gateWithClock() {
  let now = 1_000_000;
  const gate = new PollGate(() => now);
  return { gate, advance: (ms: number) => (now += ms) };
}

describe("PollGate", () => {
  test("allows the first check of a subject", () => {
    const { gate } = gateWithClock();
    expect(gate.check("t-1").allowed).toBe(true);
  });

  test("blocks an immediate re-check and reports the wait", () => {
    const { gate } = gateWithClock();
    gate.record("t-1", "status: running");
    const decision = gate.check("t-1");
    expect(decision.allowed).toBe(false);
    expect(decision.waitMs).toBe(1_000);
    expect(decision.blocked).toBe(1);
  });

  test("a blocked check still returns the last known output and its age", () => {
    const { gate, advance } = gateWithClock();
    gate.record("t-1", "status: running");
    advance(400);
    const decision = gate.check("t-1");
    expect(decision.lastOutput).toBe("status: running");
    expect(decision.ageMs).toBe(400);
  });

  test("backs off 1s, 10s, 30s, 90s, then caps at 5m", () => {
    const { gate, advance } = gateWithClock();
    const steps = [1_000, 10_000, 30_000, 90_000, 300_000, 300_000];
    for (const required of steps) {
      gate.record("t-1", "status: running");
      advance(required - 1);
      expect(gate.check("t-1").allowed).toBe(false);
      advance(1);
      expect(gate.check("t-1").allowed).toBe(true);
    }
  });

  test("counts consecutive blocked attempts, resetting after an executed check", () => {
    const { gate, advance } = gateWithClock();
    gate.record("t-1", "out");
    expect(gate.check("t-1").blocked).toBe(1);
    expect(gate.check("t-1").blocked).toBe(2);
    expect(gate.check("t-1").blocked).toBe(3);
    advance(1_000);
    expect(gate.check("t-1").allowed).toBe(true);
    gate.record("t-1", "out");
    expect(gate.check("t-1").blocked).toBe(1);
  });

  test("keys are independent, so a second task is not penalized", () => {
    const { gate } = gateWithClock();
    gate.record("t-1", "out");
    expect(gate.check("t-1").allowed).toBe(false);
    expect(gate.check("t-2").allowed).toBe(true);
  });

  test("backoff restarts from the beginning after a long quiet period", () => {
    const { gate, advance } = gateWithClock();
    // Climb to the 5m step.
    for (const required of [1_000, 10_000, 30_000, 90_000]) {
      gate.record("t-1", "out");
      advance(required);
      expect(gate.check("t-1").allowed).toBe(true);
    }
    gate.record("t-1", "out");
    advance(POLL_RESET_MS);
    expect(gate.check("t-1").allowed).toBe(true);
    // Back at step one: a 1s wait, not 5m.
    gate.record("t-1", "out");
    advance(1_000);
    expect(gate.check("t-1").allowed).toBe(true);
  });

  test("reset clears a subject's backoff", () => {
    const { gate } = gateWithClock();
    gate.record("t-1", "out");
    expect(gate.check("t-1").allowed).toBe(false);
    gate.reset("t-1");
    expect(gate.check("t-1").allowed).toBe(true);
  });
});

describe("formatWait", () => {
  test("rounds up to whole seconds and never reports zero", () => {
    expect(formatWait(1)).toBe("1s");
    expect(formatWait(1_000)).toBe("1s");
    expect(formatWait(29_400)).toBe("30s");
  });

  test("switches to minutes past 60s", () => {
    expect(formatWait(60_000)).toBe("1m");
    expect(formatWait(90_000)).toBe("1m 30s");
    expect(formatWait(300_000)).toBe("5m");
  });
});
