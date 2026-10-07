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
