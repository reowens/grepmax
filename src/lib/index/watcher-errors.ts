import * as path from "node:path";

/** Parcel reports these gaps without closing its FSEvents stream. Other errors
 * may clear the native callbacks and still require subscription recovery. */
export function isFSEventsGap(error: Error): boolean {
  return (
    error.message ===
      "Events were dropped by the FSEvents client. File system must be re-scanned." ||
    error.message ===
      "Events were dropped by the kernel. File system must be re-scanned." ||
    error.message === "Too many events. File system must be re-scanned."
  );
}

// Bound reconciliation under sustained churn without abandoning native edits
// for the five-minute polling fallback used by a failed subscription.
export const FSEVENTS_GAP_SCAN_INTERVAL_MS = 30_000;

const MISSING = "(?:No such file or directory|Not a directory)";
const MISSING_IN_CRAWL = new RegExp(`^${MISSING}$`);
const MISSING_WATCH = new RegExp(
  `^inotify_add_watch on '(.+)' failed: ${MISSING}$`,
);

function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

/** A subscribe that failed because a folder inside the root vanished while it
 * was crawled or watched. Returns that folder, "" when Parcel's crawl names no
 * path, or null for any other failure. */
export function vanishedSubscribePath(
  error: unknown,
  root: string,
): string | null {
  if (!(error instanceof Error)) return null;
  const { code, path: target } = error as NodeJS.ErrnoException;
  if (code === "ENOENT" || code === "ENOTDIR")
    return target && isInside(root, target) ? target : null;
  const watched = MISSING_WATCH.exec(error.message)?.[1];
  if (watched !== undefined) return isInside(root, watched) ? watched : null;
  return MISSING_IN_CRAWL.test(error.message) ? "" : null;
}
