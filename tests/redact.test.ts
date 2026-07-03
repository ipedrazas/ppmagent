import { describe, expect, test } from "bun:test";
import { REDACTED, redact, redactArgs, redactDeep } from "../src/redact.ts";

describe("redact", () => {
  test("replaces a single secret", () => {
    expect(redact("hello secret world", ["secret"])).toBe(`hello ${REDACTED} world`);
  });

  test("replaces multiple occurrences of the same secret", () => {
    expect(redact("a secret b secret c", ["secret"])).toBe(`a ${REDACTED} b ${REDACTED} c`);
  });

  test("replaces multiple different secrets in one pass", () => {
    expect(redact("token=abc and key=xyz", ["abc", "xyz"])).toBe(
      `token=${REDACTED} and key=${REDACTED}`,
    );
  });

  test("ignores empty secrets", () => {
    expect(redact("hello world", [""])).toBe("hello world");
  });

  test("returns the string unchanged when secrets list is empty", () => {
    expect(redact("hello world", [])).toBe("hello world");
  });

  test("replaces a secret embedded in a URL-like string", () => {
    const token = "abc123";
    expect(redact(`https://api.example.com/bot${token}/getUpdates`, [token])).toBe(
      `https://api.example.com/bot${REDACTED}/getUpdates`,
    );
  });
});

describe("redactArgs", () => {
  test("redacts the value after a sensitive flag", () => {
    expect(redactArgs(["--token", "abc123"])).toEqual(["--token", REDACTED]);
  });

  test("preserves non-sensitive flags and their values", () => {
    expect(redactArgs(["--url", "http://example.com", "--machine", "m1"])).toEqual([
      "--url",
      "http://example.com",
      "--machine",
      "m1",
    ]);
  });

  test("redacts multiple sensitive flags in a single argv", () => {
    expect(
      redactArgs(["task", "run", "--token", "tok123", "--secret", "mysecret", "--project", "p"]),
    ).toEqual(["task", "run", "--token", REDACTED, "--secret", REDACTED, "--project", "p"]);
  });

  test("handles a sensitive flag at the end with no following value", () => {
    expect(redactArgs(["--token"])).toEqual(["--token"]);
  });

  test("passes through args with no sensitive flags unchanged", () => {
    const args = ["machines", "ls", "--machine", "m1"];
    expect(redactArgs(args)).toEqual(args);
  });

  test("accepts a custom set of sensitive flags", () => {
    const custom = new Set(["--my-flag"]);
    expect(redactArgs(["--my-flag", "value", "--other", "kept"], custom)).toEqual([
      "--my-flag",
      REDACTED,
      "--other",
      "kept",
    ]);
  });

  test("does not mutate the input array", () => {
    const original = ["--token", "secret"];
    redactArgs(original);
    expect(original).toEqual(["--token", "secret"]);
  });
});

describe("redactDeep", () => {
  test("redacts secrets in a plain string", () => {
    expect(redactDeep("contains abc123", ["abc123"])).toBe(`contains ${REDACTED}`);
  });

  test("redacts secrets nested inside an object", () => {
    const result = redactDeep({ a: "has abc123 here", b: 42 }, ["abc123"]);
    expect(result).toEqual({ a: `has ${REDACTED} here`, b: 42 });
  });

  test("redacts secrets inside arrays", () => {
    const result = redactDeep(["safe", "contains abc123"], ["abc123"]);
    expect(result).toEqual(["safe", `contains ${REDACTED}`]);
  });

  test("walks nested structures recursively", () => {
    const input = {
      messages: [{ role: "user", content: [{ type: "text", text: "token abc123" }] }],
    };
    const result = redactDeep(input, ["abc123"]);
    expect(result).toEqual({
      messages: [{ role: "user", content: [{ type: "text", text: `token ${REDACTED}` }] }],
    });
  });

  test("does not mutate the original value", () => {
    const original = { text: "abc123" };
    redactDeep(original, ["abc123"]);
    expect(original.text).toBe("abc123");
  });

  test("passes non-string primitives through unchanged", () => {
    expect(redactDeep(42, ["42"])).toBe(42);
    expect(redactDeep(true, ["true"])).toBe(true);
    expect(redactDeep(null, ["null"])).toBeNull();
  });

  test("handles an empty secrets list without modifying strings", () => {
    expect(redactDeep("no change", [])).toBe("no change");
    expect(redactDeep({ key: "no change" }, [])).toEqual({ key: "no change" });
  });
});
