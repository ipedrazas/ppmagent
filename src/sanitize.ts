/**
 * Central validation for model-supplied strings that land as CLI arguments.
 *
 * execCommand uses spawn() (not sh -c), so shell metacharacters do not cause
 * OS-level injection via the argument array. The risks we guard against are:
 *   1. Argument injection: a value starting with '-' being parsed as a flag by
 *      the child CLI.
 *   2. Defense-in-depth: child CLIs sometimes shell out internally and pass
 *      these values to a secondary shell.
 *   3. Path traversal: values used as filesystem paths on remote machines.
 *
 * All validators return the value unchanged when valid, so callers can write
 *   args.push(validateSlug(slug))
 * and throw ArgInjectionError on rejection (never silently mutate).
 */

export class ArgInjectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArgInjectionError";
  }
}

/** Shell metacharacters that could trigger secondary injection if the child CLI
 * passes the value to a shell (e.g. git hooks, make targets). */
const SHELL_META_RE = /[;&|`$<>\\]/;

/** Path traversal: '..' sequence that could escape a working directory. */
const PATH_TRAVERSAL_RE = /\.\./;

/** Metacharacters for filter expressions: like SHELL_META_RE but allows '<' and '>'
 * because the filter DSL uses them as comparison operators (e.g. priority>2). */
const FILTER_META_RE = /[;&|`$\\]/;

/** Return true if value contains a null byte, CR, or LF. Avoids embedding
 * control characters in a regex literal (Biome noControlCharactersInRegex). */
function hasControlChar(value: string): boolean {
  return value.includes("\0") || value.includes("\n") || value.includes("\r");
}

/**
 * Validate a model-supplied string destined for a positional argv slot.
 *
 * Rejects:
 *   - empty strings
 *   - values starting with '-' (flag injection)
 *   - null bytes or newlines (argv structure corruption)
 *   - shell metacharacters (secondary injection defense)
 *   - path traversal sequences '..' or an absolute '/' prefix
 *
 * Returns the value unchanged when valid.
 */
export function validateArg(value: string, label: string): string {
  if (value.length === 0) throw new ArgInjectionError(`${label} must not be empty`);
  if (value.startsWith("-"))
    throw new ArgInjectionError(
      `${label} must not start with '-' (would be parsed as a flag): ${JSON.stringify(value)}`,
    );
  if (hasControlChar(value))
    throw new ArgInjectionError(`${label} must not contain control characters`);
  if (SHELL_META_RE.test(value))
    throw new ArgInjectionError(`${label} contains shell metacharacters: ${JSON.stringify(value)}`);
  if (PATH_TRAVERSAL_RE.test(value) || value.startsWith("/"))
    throw new ArgInjectionError(
      `${label} contains a path traversal sequence: ${JSON.stringify(value)}`,
    );
  return value;
}

/**
 * Validate a model-supplied string destined for a named-flag value position
 * (e.g. `--content <value>`, `-m <message>`, after `--`).
 *
 * The named flag or `--` separator already protects the value from being
 * parsed as a flag by the child CLI, so the leading-'-', metacharacter, and
 * path-traversal checks do not apply. We only reject null bytes and newlines
 * that would corrupt the argv structure itself.
 *
 * Returns the value unchanged when valid.
 */
export function validateFreeText(value: string, label: string): string {
  if (value.length === 0) throw new ArgInjectionError(`${label} must not be empty`);
  if (hasControlChar(value))
    throw new ArgInjectionError(`${label} must not contain control characters`);
  return value;
}

/**
 * Validate a search query (positional arg, but free-text content expected).
 * Only rejects leading '-' (flag injection) and control characters.
 * Shell metacharacters are allowed because search queries legitimately contain
 * characters like '$', '(' as part of natural language.
 */
export function validateSearchQuery(value: string, label: string): string {
  if (value.length === 0) throw new ArgInjectionError(`${label} must not be empty`);
  if (value.startsWith("-"))
    throw new ArgInjectionError(
      `${label} must not start with '-' (would be parsed as a flag): ${JSON.stringify(value)}`,
    );
  if (hasControlChar(value))
    throw new ArgInjectionError(`${label} must not contain control characters`);
  return value;
}

// ── Format-constrained validators ──────────────────────────────────────────

/**
 * Validate a ppm project slug: kebab-case key, e.g. `my-project`.
 * Allows alphanumeric, hyphens, underscores, dots. Must start with
 * an alphanumeric character.
 */
export function validateSlug(value: string): string {
  validateArg(value, "project slug");
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(value))
    throw new ArgInjectionError(
      `project slug must start with alphanumeric and contain only letters, digits, '.', '_', '-': ${JSON.stringify(value)}`,
    );
  return value;
}

/**
 * Validate a git branch or ref name.
 * Allows alphanumeric, hyphens, underscores, dots, and '/' (for feat/foo style).
 * Rejects git-invalid sequences: '..', '@{', trailing '.' or '/'.
 */
export function validateBranchName(value: string): string {
  if (value.length === 0) throw new ArgInjectionError("branch name must not be empty");
  if (value.startsWith("-"))
    throw new ArgInjectionError(`branch name must not start with '-': ${JSON.stringify(value)}`);
  if (hasControlChar(value))
    throw new ArgInjectionError("branch name must not contain control characters");
  if (/[;&|`$<>\\~^:?*[ ]/.test(value))
    throw new ArgInjectionError(
      `branch name contains invalid characters: ${JSON.stringify(value)}`,
    );
  if (PATH_TRAVERSAL_RE.test(value))
    throw new ArgInjectionError(
      `branch name contains '..' path traversal: ${JSON.stringify(value)}`,
    );
  if (value.includes("@{"))
    throw new ArgInjectionError(`branch name must not contain '@{': ${JSON.stringify(value)}`);
  if (value.endsWith(".") || value.endsWith("/"))
    throw new ArgInjectionError(
      `branch name must not end with '.' or '/': ${JSON.stringify(value)}`,
    );
  return value;
}

/**
 * Validate a task/issue reference: UUID or human identifier like `ENG-123`.
 * Allows alphanumeric, hyphens, underscores. Must start with alphanumeric.
 */
export function validateRef(value: string): string {
  validateArg(value, "task reference");
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(value))
    throw new ArgInjectionError(
      `task reference must be alphanumeric with hyphens/underscores: ${JSON.stringify(value)}`,
    );
  return value;
}

/**
 * Validate a machine or task id (e.g. `m-123`, `t-456`).
 * Allows alphanumeric and hyphens. Must start with alphanumeric.
 */
export function validateId(value: string): string {
  validateArg(value, "id");
  if (!/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(value))
    throw new ArgInjectionError(`id must be alphanumeric with hyphens: ${JSON.stringify(value)}`);
  return value;
}

/**
 * Validate a GitHub repository in `owner/repo` format.
 * Each component allows alphanumeric, hyphens, underscores, dots.
 */
export function validateRepo(value: string): string {
  if (value.length === 0) throw new ArgInjectionError("repo must not be empty");
  if (value.startsWith("-"))
    throw new ArgInjectionError(`repo must not start with '-': ${JSON.stringify(value)}`);
  if (hasControlChar(value))
    throw new ArgInjectionError("repo must not contain control characters");
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value))
    throw new ArgInjectionError(
      `repo must be in owner/repo format with alphanumeric components: ${JSON.stringify(value)}`,
    );
  return value;
}

/**
 * Validate a dbxcli filter expression, e.g. `status=Done`, `status!=Canceled`,
 * `labels in bug,urgent`, `priority>2`. Rejects leading '-' and shell metacharacters;
 * allows comparison operators '<', '>' that the filter syntax requires.
 */
export function validateFilter(value: string): string {
  if (value.length === 0) throw new ArgInjectionError("filter must not be empty");
  if (value.startsWith("-"))
    throw new ArgInjectionError(`filter must not start with '-': ${JSON.stringify(value)}`);
  if (hasControlChar(value))
    throw new ArgInjectionError("filter must not contain control characters");
  if (FILTER_META_RE.test(value))
    throw new ArgInjectionError(`filter contains shell metacharacters: ${JSON.stringify(value)}`);
  return value;
}
