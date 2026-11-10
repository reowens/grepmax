import type { ScoreBreakdown } from "../store/types";

/** ` [ARCHIVED]` for a retired doc, empty for everything else. */
export function docStatusTag(status: unknown): string {
  return typeof status === "string" && status
    ? ` [${status.toUpperCase()}]`
    : "";
}

/** The archive factor when it lowered the score; null when it did not apply. */
export function appliedArchiveFactor(
  breakdown: ScoreBreakdown | undefined,
): string | null {
  const factor = breakdown?.archive;
  return typeof factor === "number" && factor < 1 ? factor.toFixed(2) : null;
}
