/**
 * Helpers for converting Markdown (as produced by Claude) to Telegram MarkdownV2.
 *
 * Standard Markdown entities are translated to their MarkdownV2 equivalents
 * (`**bold**` → `*bold*`, `# heading` → bold line, links, `~~strike~~` → `~strike~`)
 * so the agent's formatting actually renders. Telegram MarkdownV2 requires
 * every character from the set
 *   _ * [ ] ( ) ~ ` > # + - = | { } . ! \
 * to be escaped with a leading backslash **outside** of recognized entities.
 * Inside `code`/`pre` spans only `` ` `` and `\` need escaping.
 */

import { splitByLength } from "./chunk.ts";
import { MAX_MESSAGE_LENGTH } from "./client.ts";

/** Special chars that must be backslash-escaped in regular MarkdownV2 prose. */
const PROSE_RE = /([_*[\]()~`>#+=|{}.!\\-])/g;

/** Special chars that must be backslash-escaped inside a code span or block. */
const CODE_RE = /([`\\])/g;

const FENCE_RE = /```([\w]*)\n?([\s\S]*?)```/g;

function escapeText(s: string): string {
  return s.replace(PROSE_RE, "\\$1");
}

function escapeCode(s: string): string {
  return s.replace(CODE_RE, "\\$1");
}

/** Escape chars that are special inside the URL part of a MarkdownV2 link. */
function escapeUrl(s: string): string {
  return s.replace(/([)\\])/g, "\\$1");
}

/**
 * Inline Markdown entities recognized in prose, in priority order: inline
 * code, links, bold (`**`/`__`), italic (`*`/word-boundary `_`), strikethrough.
 * Entities never span lines; `_` italic requires non-word neighbours so
 * snake_case identifiers stay literal.
 */
const INLINE_RE =
  /(?<code>`[^`\n]+`)|(?<link>\[[^\]\n]*\]\((?:[^()\n]|\([^()\n]*\))*\))|(?<bold>\*\*[^\n]+?\*\*)|(?<ubold>__[^\n]+?__)|(?<italic>\*[^\s*](?:[^*\n]*?[^\s*])?\*)|(?<uitalic>(?<![\w\\])_[^\s_](?:[^_\n]*?[^\s_])?_(?!\w))|(?<strike>~~[^\n]+?~~)/g;

/**
 * Wrap converted content in a MarkdownV2 style marker (`*`, `_`, `~`) —
 * unless the content contains inline code: MarkdownV2 forbids code inside
 * other entities, so the style is dropped and the code span kept.
 */
function styled(marker: string, content: string): string {
  const converted = convertInline(content);
  return content.includes("`") ? converted : `${marker}${converted}${marker}`;
}

/**
 * Convert one line's worth of inline Markdown to MarkdownV2: recognized
 * entities are translated (recursing into their content for nesting like
 * bold-containing-italic); everything between them is escaped.
 */
function convertInline(text: string): string {
  const parts: string[] = [];
  let last = 0;
  // matchAll clones the regex, so recursive calls can't corrupt lastIndex.
  for (const m of text.matchAll(INLINE_RE)) {
    const index = m.index ?? 0;
    if (index > last) parts.push(escapeText(text.slice(last, index)));
    const g = m.groups ?? {};
    if (g.code !== undefined) {
      parts.push(`\`${escapeCode(g.code.slice(1, -1))}\``);
    } else if (g.link !== undefined) {
      // Split on the "](", which can't appear in either half: "]" is excluded
      // from link text and the URL pattern has no way to match "](".
      const sep = g.link.indexOf("](");
      const label = g.link.slice(1, sep);
      const url = g.link.slice(sep + 2, -1);
      parts.push(`[${convertInline(label)}](${escapeUrl(url)})`);
    } else if (g.bold !== undefined) {
      parts.push(styled("*", g.bold.slice(2, -2)));
    } else if (g.ubold !== undefined) {
      parts.push(styled("*", g.ubold.slice(2, -2)));
    } else if (g.italic !== undefined) {
      parts.push(styled("_", g.italic.slice(1, -1)));
    } else if (g.uitalic !== undefined) {
      parts.push(styled("_", g.uitalic.slice(1, -1)));
    } else if (g.strike !== undefined) {
      parts.push(styled("~", g.strike.slice(2, -2)));
    }
    last = index + m[0].length;
  }
  if (last < text.length) parts.push(escapeText(text.slice(last)));
  return parts.join("");
}

/**
 * Convert a segment of prose (no fenced code blocks) to MarkdownV2.
 * Heading lines become bold (MarkdownV2 has no headings); other lines get
 * inline entity translation via {@link convertInline}.
 */
function convertProse(text: string): string {
  return text
    .split("\n")
    .map((line) => {
      const h = line.match(/^#{1,6}\s+(.*\S)\s*$/);
      // Bold stand-in for headings — except when the heading contains inline
      // code, which MarkdownV2 forbids nesting inside bold. Bold markers in
      // the heading text are dropped (the whole line is bold anyway).
      if (h && !h[1]?.includes("`")) {
        return `*${convertInline((h[1] ?? "").replace(/\*\*([^\n]+?)\*\*/g, "$1"))}*`;
      }
      return convertInline(line);
    })
    .join("\n");
}

type Token = { kind: "prose"; raw: string } | { kind: "code"; lang: string; code: string };

/** Split text into alternating prose and fenced-code-block segments. */
function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  let last = 0;
  FENCE_RE.lastIndex = 0;
  for (let m = FENCE_RE.exec(text); m !== null; m = FENCE_RE.exec(text)) {
    if (m.index > last) tokens.push({ kind: "prose", raw: text.slice(last, m.index) });
    tokens.push({ kind: "code", lang: m[1] ?? "", code: m[2] ?? "" });
    last = m.index + m[0].length;
  }
  if (last < text.length) tokens.push({ kind: "prose", raw: text.slice(last) });
  return tokens;
}

function formatCode(lang: string, code: string): string {
  return `\`\`\`${lang}\n${escapeCode(code)}\`\`\``;
}

function formatToken(t: Token): string {
  return t.kind === "code" ? formatCode(t.lang, t.code) : convertProse(t.raw);
}

/**
 * Convert standard Markdown to Telegram MarkdownV2.
 *
 * Fenced code blocks (` ``` `) and inline code (`` ` ``) are preserved with
 * minimal content escaping (only `` ` `` and `\`). Bold, italic, headings,
 * links, and strikethrough are translated to their MarkdownV2 forms so they
 * render; any remaining special characters are escaped so Telegram accepts
 * the message.
 */
export function toMarkdownV2(text: string): string {
  return tokenize(text).map(formatToken).join("");
}

/**
 * Convert Markdown to one or more Telegram MarkdownV2 chunks, each no longer
 * than `maxLen`.
 *
 * Splitting happens on the *raw* Markdown before escaping, never on the
 * escaped output — cutting an already-escaped string at an arbitrary length
 * can land inside a fenced code block or between a `\` and the character it
 * escapes, producing invalid MarkdownV2 that Telegram rejects outright.
 * Each returned entry pairs the escaped chunk with its raw source so callers
 * can retry just that chunk as plain text if Telegram still rejects it.
 */
export function toMarkdownV2Chunks(
  text: string,
  maxLen: number = MAX_MESSAGE_LENGTH,
): Array<{ raw: string; formatted: string }> {
  const chunks: Array<{ raw: string; formatted: string }> = [];
  let rawBuf = "";
  let formattedBuf = "";

  const flush = () => {
    if (formattedBuf) chunks.push({ raw: rawBuf, formatted: formattedBuf });
    rawBuf = "";
    formattedBuf = "";
  };

  const append = (raw: string, formatted: string) => {
    if (formattedBuf.length + formatted.length > maxLen) flush();
    rawBuf += raw;
    formattedBuf += formatted;
  };

  for (const token of tokenize(text)) {
    if (token.kind === "code") {
      const formatted = formatCode(token.lang, token.code);
      if (formatted.length <= maxLen) {
        append(`\`\`\`${token.lang}\n${token.code}\`\`\``, formatted);
        continue;
      }
      // A single code block is too big even on its own — split its raw
      // content and re-wrap each piece in its own fence. Escaping at most
      // doubles length (every char a backtick/backslash), so budgeting half
      // of the available space guarantees each formatted piece fits.
      flush();
      const overhead = 7 + token.lang.length; // ``` + lang + \n + ```
      const rawBudget = Math.max(1, Math.floor((maxLen - overhead) / 2));
      for (const piece of splitByLength(token.code, rawBudget)) {
        chunks.push({
          raw: `\`\`\`${token.lang}\n${piece}\`\`\``,
          formatted: formatCode(token.lang, piece),
        });
      }
    } else {
      const formatted = convertProse(token.raw);
      if (formatted.length <= maxLen) {
        append(token.raw, formatted);
        continue;
      }
      // Same reasoning as above: escaping at most doubles prose length.
      // Each piece becomes its own chunk (never packed via `append`) since
      // splitByLength drops the separator it split on — reassembling pieces
      // into one buffer would silently swallow a newline/space from the
      // visible message instead of just from between two Telegram messages.
      flush();
      const rawBudget = Math.max(1, Math.floor(maxLen / 2));
      for (const piece of splitByLength(token.raw, rawBudget)) {
        chunks.push({ raw: piece, formatted: convertProse(piece) });
      }
    }
  }
  flush();
  return chunks.length ? chunks : [{ raw: "", formatted: "" }];
}
