/**
 * Safely escapes a string for use in a SQL-like filter.
 * Escapes single quotes and backslashes.
 *
 * @param str The string to escape
 * @returns The escaped string
 */
export function escapeSqlString(str: string): string {
    return str.replace(/\\/g, "\\\\").replace(/'/g, "''");
}

/**
 * Normalizes a path to use forward slashes, ensuring consistency across platforms.
 * @param p The path to normalize
 * @returns The normalized path with forward slashes
 */
export function normalizePath(p: string): string {
    return p.replace(/\\/g, "/");
}
