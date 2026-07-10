// biome-ignore lint/suspicious/noControlCharactersInRegex: intentional control-character matching
const CONTROL_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;

/** Strip null bytes and unsafe control characters. Preserves \t and \n. */
export function sanitizeString(s: string): string {
  return s.replace(CONTROL_RE, "");
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: intentional control-character matching
const PROMPT_CONTROL_RE = /[\x00-\x08\x0b-\x1f]/g;

/**
 * Strip ASCII control characters (0x00-0x1F) from a freeform prompt before it
 * is dispatched to the proteos CLI. Preserves \n and \t since prompts are
 * natural language and may legitimately span multiple lines or columns.
 */
export function sanitizePrompt(s: string): string {
  return s.replace(PROMPT_CONTROL_RE, "");
}

/** Sanitize and collapse to a single printable line (no embedded newlines).
 * Use for titles, branch names, refs, and other single-line fields. */
export function sanitizeLine(s: string): string {
  return sanitizeString(s)
    .replace(/[\r\n]+/g, " ")
    .trim();
}
