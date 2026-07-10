/**
 * Helpers for converting Markdown (as produced by Claude) to Telegram MarkdownV2.
 *
 * Telegram MarkdownV2 requires every character from the set
 *   _ * [ ] ( ) ~ ` > # + - = | { } . ! \
 * to be escaped with a leading backslash **outside** of code entities.
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

/**
 * Convert a segment of prose (no fenced code blocks) to MarkdownV2.
 * Inline `` `code` `` spans are kept as-is (content escaped for code context);
 * everything else has prose special chars escaped.
 */
function convertProse(text: string): string {
  const parts: string[] = [];
  const inlineRe = /`([^`]+)`/g;
  let last = 0;
  for (let m = inlineRe.exec(text); m !== null; m = inlineRe.exec(text)) {
    if (m.index > last) parts.push(escapeText(text.slice(last, m.index)));
    parts.push(`\`${escapeCode(m[1] ?? "")}\``);
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push(escapeText(text.slice(last)));
  return parts.join("");
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
 * minimal content escaping (only `` ` `` and `\`).  All other text has the
 * full set of MarkdownV2 special characters escaped so Telegram accepts the
 * message.
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
