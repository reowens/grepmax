export function escapeSqlString(str: string): string {
  // LanceDB (via DataFusion) treats backslashes literally in standard strings.
  // We only need to escape single quotes by doubling them.
  return str.replace(/'/g, "''");
}

/**
 * SQL predicate matching rows whose `path` begins with `prefix`.
 *
 * Use this instead of `path LIKE '<prefix>%'` for any path-prefix scope.
 * `escapeSqlString` only neutralizes quotes, not LIKE metacharacters, so a
 * prefix containing `_` (matches any single char) or `%` (matches anything)
 * would silently match — and delete — across sibling projects
 * (`/repo/my_app/` would match `/repo/myXapp/`). `starts_with()` has no
 * wildcard semantics, so the prefix is matched literally.
 *
 * Callers are responsible for trailing-slash boundary correctness: pass
 * `/repo/app/` (not `/repo/app`) so the scope can't bleed into `/repo/app2/`.
 */
export function pathStartsWith(prefix: string): string {
  return `starts_with(path, '${escapeSqlString(prefix)}')`;
}

/** Negation of {@link pathStartsWith} — excludes paths under `prefix`. */
export function pathNotStartsWith(prefix: string): string {
  return `NOT ${pathStartsWith(prefix)}`;
}

/**
 * Normalizes a path to use forward slashes, ensuring consistency across platforms.
 * @param p The path to normalize
 * @returns The normalized path with forward slashes
 */
export function normalizePath(p: string): string {
  return p.replace(/\\/g, "/");
}
