import { describe, expect, test } from "bun:test";
import { toMarkdownV2, toMarkdownV2Chunks } from "../src/telegram/mdv2.ts";

describe("toMarkdownV2", () => {
  test("passes text with no special chars unchanged", () => {
    expect(toMarkdownV2("hello world")).toBe("hello world");
  });

  test("escapes prose special characters", () => {
    expect(toMarkdownV2("Hello. World!")).toBe("Hello\\. World\\!");
    expect(toMarkdownV2("(see note)")).toBe("\\(see note\\)");
    expect(toMarkdownV2("a - b")).toBe("a \\- b");
    expect(toMarkdownV2("a_b")).toBe("a\\_b");
  });

  test("preserves fenced code blocks with minimal escaping", () => {
    const input = "Here:\n```\nconst x = `y`;\n```\n";
    const result = toMarkdownV2(input);
    // Colon is not a MarkdownV2 special char — stays as-is
    expect(result).toMatch(/^Here:\n```\n/);
    expect(result).toContain("```");
    // Backtick inside block is escaped (the only special char in code context)
    expect(result).toContain("\\`y\\`");
  });

  test("preserves language tag on fenced code blocks", () => {
    const input = "```python\nprint('hi')\n```";
    const result = toMarkdownV2(input);
    expect(result).toMatch(/^```python\n/);
    // Parens inside code blocks are NOT special — only ` and \ need escaping there
    expect(result).toContain("print('hi')");
  });

  test("handles diffs in code blocks without mangling +/- lines", () => {
    const diff = "```diff\n+ added line\n- removed line\n```";
    const result = toMarkdownV2(diff);
    // + and - are not special inside code blocks
    expect(result).toContain("+ added line");
    expect(result).toContain("- removed line");
  });

  test("preserves inline code spans", () => {
    const result = toMarkdownV2("Use `foo.bar()` here.");
    expect(result).toContain("`foo.bar()`");
    // The dot after "here" is in prose → escaped
    expect(result).toContain("here\\.");
  });

  test("escapes backslash inside code blocks", () => {
    const input = "```\npath\\to\\file\n```";
    const result = toMarkdownV2(input);
    expect(result).toContain("path\\\\to\\\\file");
  });

  test("handles multiple code blocks in one message", () => {
    const input = "First:\n```\na\n```\nThen:\n```\nb\n```\nDone.";
    const result = toMarkdownV2(input);
    expect(result).toContain("```\na\n```");
    expect(result).toContain("```\nb\n```");
    expect(result).toContain("Done\\.");
  });

  test("passes through text that has no code and no special chars", () => {
    const plain = "Context report ready";
    expect(toMarkdownV2(plain)).toBe(plain);
  });

  test("escapes parentheses in prose but not inside code", () => {
    const input = "Call `fn(x)` or just fn(x).";
    const result = toMarkdownV2(input);
    // Inside inline code: ( ) not escaped
    expect(result).toContain("`fn(x)`");
    // Outside inline code: ( ) escaped; . escaped
    expect(result).toContain("just fn\\(x\\)\\.");
  });
});

describe("toMarkdownV2Chunks", () => {
  test("returns a single chunk for short text, matching toMarkdownV2", () => {
    const text = "Hello **world**. Call `fn()`.";
    const chunks = toMarkdownV2Chunks(text);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.formatted).toBe(toMarkdownV2(text));
    expect(chunks[0]?.raw).toBe(text);
  });

  test("never splits inside a fenced code block", () => {
    // A code block that alone is well under maxLen, but pushes the running
    // chunk over the limit when appended to preceding prose.
    const prose = "x".repeat(4000);
    const code = "```\nconst a = 1;\nconst b = 2;\n```";
    const text = `${prose}\n${code}`;
    const chunks = toMarkdownV2Chunks(text, 4096);
    for (const { formatted } of chunks) {
      // Every chunk must have balanced fences: either no ``` at all, or an
      // even number (each opened fence is also closed within the chunk).
      const fenceCount = (formatted.match(/```/g) ?? []).length;
      expect(fenceCount % 2).toBe(0);
    }
    // The code block itself must appear intact, unescaped apart from ` and \.
    expect(chunks.some((c) => c.formatted.includes("const a = 1;"))).toBe(true);
  });

  test("every chunk stays within maxLen even when escaping inflates length", () => {
    // Dense reserved characters: every char doubles in length once escaped.
    const text = "!.".repeat(3000);
    const chunks = toMarkdownV2Chunks(text, 4096);
    expect(chunks.length).toBeGreaterThan(1);
    for (const { formatted } of chunks) {
      expect(formatted.length).toBeLessThanOrEqual(4096);
    }
  });

  test("splitting a raw chunk never leaves a dangling escape backslash", () => {
    const text = "!.".repeat(3000);
    const chunks = toMarkdownV2Chunks(text, 4096);
    for (const { formatted } of chunks) {
      // A trailing lone backslash would mean the split cut between `\` and
      // the character it escapes.
      expect(formatted.endsWith("\\")).toBe(false);
    }
  });

  test("splitting loses at most the whitespace separator between chunks", () => {
    const text = `${"a".repeat(3000)}\n${"b".repeat(3000)}`;
    const chunks = toMarkdownV2Chunks(text, 4096);
    expect(chunks.length).toBeGreaterThan(1);
    // No non-whitespace content is dropped; only the split-point separator
    // (a newline/space consumed by the split) is not carried into either chunk.
    const rejoinedNonWhitespace = chunks
      .map((c) => c.raw)
      .join("")
      .replace(/\s/g, "");
    expect(rejoinedNonWhitespace).toBe(text.replace(/\s/g, ""));
  });

  test("splits an oversized single code block into multiple balanced fences", () => {
    const bigCode = Array.from({ length: 500 }, (_, i) => `line ${i}`).join("\n");
    const text = `\`\`\`\n${bigCode}\n\`\`\``;
    const chunks = toMarkdownV2Chunks(text, 200);
    expect(chunks.length).toBeGreaterThan(1);
    for (const { formatted } of chunks) {
      expect(formatted.length).toBeLessThanOrEqual(200);
      expect(formatted.startsWith("```")).toBe(true);
      expect(formatted.endsWith("```")).toBe(true);
    }
  });
});
