export function isFileCached(
  cached: { mtimeMs: number; size: number } | undefined | null,
  stats: { mtimeMs: number; size: number },
): boolean {
  if (!cached) return false;
  // Truncate to millisecond — APFS returns sub-ms precision that can
  // differ across stat calls or serialization round-trips.
  return (
    Math.trunc(cached.mtimeMs) === Math.trunc(stats.mtimeMs) &&
    cached.size === stats.size
  );
}
