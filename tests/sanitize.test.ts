import { describe, expect, test } from "bun:test";
import { sanitizeLine, sanitizePrompt, sanitizeString } from "../src/tools/sanitize.ts";

describe("sanitizeString", () => {
  test("passes through normal text unchanged", () => {
    expect(sanitizeString("hello world")).toBe("hello world");
  });

  test("preserves newlines", () => {
    expect(sanitizeString("line1\nline2")).toBe("line1\nline2");
  });

  test("preserves tabs", () => {
    expect(sanitizeString("col1\tcol2")).toBe("col1\tcol2");
  });

  test("strips null bytes", () => {
    expect(sanitizeString("foo\x00bar")).toBe("foobar");
  });

  test("strips SOH through BS (0x01–0x08)", () => {
    expect(sanitizeString("\x01\x02\x03\x04\x05\x06\x07\x08")).toBe("");
  });

  test("strips VT and FF (0x0b–0x0c)", () => {
    expect(sanitizeString("a\x0bb\x0cc")).toBe("abc");
  });

  test("strips SO through US (0x0e–0x1f)", () => {
    expect(sanitizeString("\x0e\x1f")).toBe("");
  });

  test("strips DEL (0x7f)", () => {
    expect(sanitizeString("a\x7fb")).toBe("ab");
  });

  test("does not strip printable ASCII", () => {
    const printable = " !\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~";
    expect(sanitizeString(printable)).toBe(printable);
  });
});

describe("sanitizeLine", () => {
  test("passes through a single-line string", () => {
    expect(sanitizeLine("hello world")).toBe("hello world");
  });

  test("collapses \\n to a space", () => {
    expect(sanitizeLine("line1\nline2")).toBe("line1 line2");
  });

  test("collapses \\r\\n to a space", () => {
    expect(sanitizeLine("line1\r\nline2")).toBe("line1 line2");
  });

  test("trims leading and trailing whitespace", () => {
    expect(sanitizeLine("  hello  ")).toBe("hello");
  });

  test("strips control chars", () => {
    expect(sanitizeLine("foo\x00bar")).toBe("foobar");
  });

  test("collapses multiple newlines into one space", () => {
    expect(sanitizeLine("a\n\n\nb")).toBe("a b");
  });
});

describe("sanitizePrompt", () => {
  test("passes through a clean prompt unchanged", () => {
    expect(sanitizePrompt("fix the bug in src/app.ts")).toBe("fix the bug in src/app.ts");
  });

  test("preserves newlines", () => {
    expect(sanitizePrompt("line1\nline2")).toBe("line1\nline2");
  });

  test("preserves tabs", () => {
    expect(sanitizePrompt("col1\tcol2")).toBe("col1\tcol2");
  });

  test("strips null bytes", () => {
    expect(sanitizePrompt("foo\x00bar")).toBe("foobar");
  });

  test("strips SOH through BS (0x01–0x08)", () => {
    expect(sanitizePrompt("\x01\x02\x03\x04\x05\x06\x07\x08")).toBe("");
  });

  test("strips VT, FF, and CR (0x0b, 0x0c, 0x0d)", () => {
    expect(sanitizePrompt("a\x0bb\x0cc\x0dd")).toBe("abcd");
  });

  test("strips SO through US (0x0e–0x1f)", () => {
    expect(sanitizePrompt("\x0e\x1f")).toBe("");
  });

  test("does not strip DEL (0x7f) or printable ASCII", () => {
    const text = "a\x7fb !\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~";
    expect(sanitizePrompt(text)).toBe(text);
  });
});
