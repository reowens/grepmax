const ARCHIVE_SEGMENT = /^archived?$/i;
const DEFAULT_ARCHIVE_PENALTY = 0.5;

export function archivePenalty(): number {
  const value = Number.parseFloat(process.env.GMAX_ARCHIVE_PENALTY ?? "");
  return Number.isFinite(value) && value > 0 && value <= 1
    ? value
    : DEFAULT_ARCHIVE_PENALTY;
}

function withSlash(root: string): string {
  return root.endsWith("/") ? root : `${root}/`;
}

/** The longest root that contains `path`, so a nested project wins over its parent. */
export function containingRoot(
  path: string,
  roots: readonly string[],
): string | undefined {
  let best: string | undefined;
  for (const root of roots) {
    const base = withSlash(root);
    if (path.startsWith(base) && (!best || base.length > best.length)) {
      best = base;
    }
  }
  return best;
}

/**
 * True when a folder of `path` below `root` is named archive or archived. The
 * match never looks above the root, so a checkout under ~/archive/ is not
 * archived, and never at the file name itself.
 */
export function hasArchiveSegment(path: string, root: string): boolean {
  const base = withSlash(root);
  if (!path.startsWith(base)) return false;
  const folders = path.slice(base.length).split("/").slice(0, -1);
  return folders.some((segment) => ARCHIVE_SEGMENT.test(segment));
}

/** A scope prefix is a folder, so its last segment counts. */
export function isArchiveScope(prefix: string, root: string): boolean {
  return hasArchiveSegment(withSlash(prefix), root);
}
