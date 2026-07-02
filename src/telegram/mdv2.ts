/**
 * Helpers for converting Markdown (as produced by Claude) to Telegram MarkdownV2.
 *
 * Telegram MarkdownV2 requires every character from the set
 *   _ * [ ] ( ) ~ ` > # + - = | { } . ! \
 * to be escaped with a leading backslash **outside** of code entities.
 * Inside `code`/`pre` spans only `` ` `` and `\` need escaping.
 */

/** Special chars that must be backslash-escaped in regular MarkdownV2 prose. */
const PROSE_RE = /([_*\[\]()~`>#+=|{}.!\\-])/g;

/** Special chars that must be backslash-escaped inside a code span or block. */
const CODE_RE = /([`\\])/g;

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

/**
 * Convert standard Markdown to Telegram MarkdownV2.
 *
 * Fenced code blocks (` ``` `) and inline code (`` ` ``) are preserved with
 * minimal content escaping (only `` ` `` and `\`).  All other text has the
 * full set of MarkdownV2 special characters escaped so Telegram accepts the
 * message.
 */
export function toMarkdownV2(text: string): string {
  const parts: string[] = [];
  const fenceRe = /```([\w]*)\n?([\s\S]*?)```/g;
  let last = 0;
  for (let m = fenceRe.exec(text); m !== null; m = fenceRe.exec(text)) {
    if (m.index > last) parts.push(convertProse(text.slice(last, m.index)));
    const lang = m[1] ?? "";
    const code = m[2] ?? "";
    parts.push(`\`\`\`${lang}\n${escapeCode(code)}\`\`\``);
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push(convertProse(text.slice(last)));
  return parts.join("");
}
