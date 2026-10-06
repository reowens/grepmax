export interface CompactionResult {
  status: "completed" | "skipped" | "failed";
  at: number;
  attempts: number;
  elapsedMs: number;
  reason?: string;
  logicalBytes?: number;
  diskBytesBefore?: number;
  diskBytesAfter?: number;
  freeBytesBefore?: number;
  freeBytesAfter?: number;
  /** Gross native bytes deleted, including the cleanup pass. */
  bytesReclaimed?: number;
  /** Physical bytes before minus after; negative means net growth. */
  netBytesReclaimed?: number;
  cleanupPasses?: number;
  cleanupReason?: string;
}

export function skippedCompaction(reason: string): CompactionResult {
  return {
    status: "skipped",
    reason,
    at: Date.now(),
    attempts: 0,
    elapsedMs: 0,
  };
}

export function parseCompactionResult(
  value: unknown,
): CompactionResult | undefined {
  if (!value || typeof value !== "object") return undefined;
  const r = value as CompactionResult;
  if (
    !["completed", "skipped", "failed"].includes(r.status) ||
    !Number.isFinite(r.at) ||
    Number.isNaN(new Date(r.at).getTime()) ||
    !Number.isFinite(r.attempts) ||
    !Number.isFinite(r.elapsedMs) ||
    (r.reason !== undefined && typeof r.reason !== "string")
  )
    return undefined;
  return r;
}

export function formatCompactionStatus(value: unknown): string | undefined {
  const result = parseCompactionResult(value);
  if (!result) return undefined;
  const reason = result.reason?.replace(/[\r\n\t]/g, " ").slice(0, 512);
  return `Last compaction: ${result.status} at ${new Date(result.at).toISOString()} (${result.attempts} attempts, ${result.elapsedMs}ms)${reason ? ` — ${reason}` : ""}`;
}
