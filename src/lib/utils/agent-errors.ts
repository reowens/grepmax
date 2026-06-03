/**
 * Shared "not found" / empty-result rendering for the symbol and file lookup
 * commands (peek/extract/trace/dead/impact/similar/related). Two jobs:
 *
 *  1. Unify the format — previously each command emitted its own variant
 *     ("Symbol not found: X", "(not found)", bare one-liners), and only
 *     peek/extract carried the rich human "Possible reasons / Try:" block.
 *  2. Stop discarding recovery hints under `--agent` — human mode keeps the
 *     full block; agent mode now gets a compact trailing `next:` line instead
 *     of a bare, dead-end error.
 *
 * Returns lines (caller joins with "\n"). `dim`/`bold` default to identity so
 * the helper stays color-agnostic; commands pass their own `style.*` to
 * preserve existing human coloring.
 */

export interface NotFoundOpts {
  /** Compact agent-mode output with a trailing `next:` recovery line. */
  agent?: boolean;
  dim?: (s: string) => string;
  bold?: (s: string) => string;
}

const identity = (s: string) => s;

/** `Symbol not found: X` — symbol lookup miss. */
export function symbolNotFoundLines(
  symbol: string,
  opts: NotFoundOpts = {},
): string[] {
  const { agent = false, dim = identity, bold = identity } = opts;
  if (agent) {
    return [
      `Symbol not found: ${symbol}`,
      `next: gmax status (indexed projects) · gmax search ${symbol} (fuzzy match)`,
    ];
  }
  return [
    `Symbol not found: ${bold(symbol)}`,
    "",
    dim("Possible reasons:"),
    dim("  • The symbol doesn't exist in any indexed project"),
    dim("  • The containing file hasn't been indexed yet"),
    dim("  • The name is spelled differently in the source"),
    "",
    dim("Try:"),
    dim("  gmax status          — see which projects are indexed"),
    dim("  gmax search <name>   — fuzzy search for similar symbols"),
  ];
}

/** `File not found in index: X` — file lookup miss. */
export function fileNotFoundLines(
  file: string,
  opts: NotFoundOpts = {},
): string[] {
  const { agent = false, dim = identity, bold = identity } = opts;
  if (agent) {
    return [
      `File not found in index: ${file}`,
      `next: use a path relative to the project root · gmax status · gmax add <project> (if untracked)`,
    ];
  }
  return [
    `File not found in index: ${bold(file)}`,
    "",
    dim("Try:"),
    dim("  ensure the path is relative to the project root"),
    dim("  gmax status          — see which projects are indexed"),
    dim("  gmax add <project>   — index a project that isn't tracked yet"),
  ];
}
