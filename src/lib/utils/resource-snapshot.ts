import type { HostResourceSnapshot } from "./host-resource";

/** Cached counters; collecting this response runs no probes or store scans. */
export interface ResourceSnapshot {
  at: number;
  reason: string;
  footprintMb: number | null;
  rssMb: number;
  heapUsedMb: number;
  externalMb: number;
  arrayBuffersMb: number;
  lanceCacheMb: number | null;
  workers: number;
  pendingFiles: number;
  operations: number;
  maintenance: boolean;
  host?: HostResourceSnapshot | null;
}

export function buildResourceSnapshot(
  counters: Pick<
    ResourceSnapshot,
    | "reason"
    | "footprintMb"
    | "workers"
    | "pendingFiles"
    | "operations"
    | "maintenance"
  > & { lanceCacheBytes: number | null; host?: HostResourceSnapshot | null },
  memory = process.memoryUsage(),
  at = Date.now(),
): ResourceSnapshot {
  const mb = (bytes: number) => Math.round(bytes / 1024 / 1024);
  return {
    at,
    reason: counters.reason,
    footprintMb: counters.footprintMb,
    rssMb: mb(memory.rss),
    heapUsedMb: mb(memory.heapUsed),
    externalMb: mb(memory.external),
    arrayBuffersMb: mb(memory.arrayBuffers),
    lanceCacheMb:
      counters.lanceCacheBytes === null ? null : mb(counters.lanceCacheBytes),
    workers: counters.workers,
    pendingFiles: counters.pendingFiles,
    operations: counters.operations,
    maintenance: counters.maintenance,
    ...(counters.host ? { host: counters.host } : {}),
  };
}
