export function isFileCached(
  cached: { mtimeMs: number; size: number } | undefined | null,
  stats: { mtimeMs: number; size: number },
): boolean {
  if (!cached) return false;
  return cached.mtimeMs === stats.mtimeMs && cached.size === stats.size;
}
