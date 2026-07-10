/** Shared text-splitting helper for staying under Telegram's per-message length limit. */

/**
 * Split `text` into pieces no longer than `maxLen`, preferring to break on a
 * newline, then a space, and falling back to a hard cut at `maxLen`.
 */
export function splitByLength(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];
  const chunks: string[] = [];
  let pos = 0;
  while (pos < text.length) {
    if (pos + maxLen >= text.length) {
      chunks.push(text.slice(pos));
      break;
    }
    const window = text.slice(pos, pos + maxLen);
    let splitAt = window.lastIndexOf("\n");
    if (splitAt > 0) {
      chunks.push(window.slice(0, splitAt));
      pos += splitAt + 1; // skip the newline itself
      continue;
    }
    splitAt = window.lastIndexOf(" ");
    if (splitAt > 0) {
      chunks.push(window.slice(0, splitAt));
      pos += splitAt + 1; // skip the space itself
      continue;
    }
    chunks.push(window);
    pos += maxLen;
  }
  return chunks;
}
