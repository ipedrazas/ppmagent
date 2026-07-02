/**
 * Centralised secrets-redaction utilities. One place for all scrubbing so error
 * paths, log lines, and persisted data all use a consistent replacement token.
 */

export const REDACTED = "[REDACTED]";

/**
 * CLI flag names whose immediately-following value should be masked in argv
 * logs. The flag itself is preserved; only the value is replaced.
 */
export const SENSITIVE_FLAGS: ReadonlySet<string> = new Set([
  "--token",
  "--key",
  "--api-key",
  "--apikey",
  "--password",
  "--pass",
  "--secret",
  "--auth",
  "--bearer",
  "--credential",
  "--credentials",
]);

/**
 * Replace every occurrence of each secret in `input` with {@link REDACTED}.
 * Empty secrets are skipped (they would match every character boundary).
 */
export function redact(input: string, secrets: Iterable<string>): string {
  let result = input;
  for (const secret of secrets) {
    if (secret.length === 0) continue;
    result = result.split(secret).join(REDACTED);
  }
  return result;
}

/**
 * Walk an argv array and replace the value that immediately follows any flag in
 * `sensitiveFlags` with {@link REDACTED}. The flag name is kept so the structure
 * of the command remains readable in logs.
 */
export function redactArgs(
  args: readonly string[],
  sensitiveFlags: ReadonlySet<string> = SENSITIVE_FLAGS,
): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < args.length) {
    const arg = args[i] ?? "";
    out.push(arg);
    i++;
    if (sensitiveFlags.has(arg) && i < args.length) {
      out.push(REDACTED);
      i++; // skip the value
    }
  }
  return out;
}

/**
 * Recursively apply {@link redact} to every string leaf in `value`. Returns a
 * new object / array / primitive — the input is never mutated. Non-string
 * primitives pass through unchanged.
 */
export function redactDeep(value: unknown, secrets: Iterable<string>): unknown {
  if (typeof value === "string") return redact(value, secrets);
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, secrets));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = redactDeep(v, secrets);
    }
    return out;
  }
  return value;
}
