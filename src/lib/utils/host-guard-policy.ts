import * as fs from "node:fs";
import * as path from "node:path";
import { PATHS } from "../../config";
import type { HostResourceSnapshot } from "./host-resource";
import { probeKernelZoneUsage, probeMemoryPressure } from "./kernel-zone";

export type HostGuardPolicy = "strict" | "critical-only";

/** Explicit operator preference. Unknown values preserve strict admission. */
export function hostGuardPolicy(): HostGuardPolicy {
  const environment = process.env.GMAX_HOST_GUARD_POLICY;
  if (environment !== undefined)
    return environment === "critical-only" ? "critical-only" : "strict";
  try {
    const config = JSON.parse(
      fs.readFileSync(path.join(PATHS.sharedRoot, "config.json"), "utf8"),
    ) as { hostGuardPolicy?: unknown };
    return config.hostGuardPolicy === "critical-only"
      ? "critical-only"
      : "strict";
  } catch {
    return "strict";
  }
}

/** No footprint scan or reservation ledger in explicitly selected critical-only
 * mode. Unknown probes stay visible as unknown; they are never called healthy. */
export function sampleCriticalPressure(): HostResourceSnapshot {
  const at = Date.now();
  const memory = probeMemoryPressure();
  const kernel = probeKernelZoneUsage();
  const freshMemory = probeMemoryPressure();
  const memoryPressure = [memory, freshMemory].some(
    (p) => p.status === "known" && p.pressure === "critical",
  )
    ? "critical"
    : freshMemory.status === "known"
      ? freshMemory.pressure
      : "unknown";
  return {
    at,
    completedAt: Date.now(),
    platform: process.platform,
    processes: [],
    aggregateFootprintMb: null,
    physicalFreeMb: null,
    swapUsedMb: null,
    memoryPressure,
    kernelPressure:
      kernel.status === "known" ? kernel.usage.pressure : "unknown",
    kernelBytes: kernel.status === "known" ? kernel.usage.bytes : null,
    incompleteReasons: [
      "aggregate admission disabled by explicit critical-only policy",
    ],
  };
}
