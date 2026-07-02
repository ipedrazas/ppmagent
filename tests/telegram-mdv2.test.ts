import { describe, expect, test } from "bun:test";
import { toMarkdownV2 } from "../src/telegram/mdv2.ts";

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
