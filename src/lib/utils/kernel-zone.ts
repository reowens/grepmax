import { execFileSync } from "node:child_process";

/**
 * macOS kernel-zone pressure guard.
 *
 * On macOS 26.5.2 (build 25F84) the `data.kalloc.1024` kernel zone leaks under
 * sustained filesystem write pressure and is never reclaimed. Exhausting it panics
 * the host outright — no jetsam, no swap warning, no chance to intervene, because
 * the failing resource is wired kernel memory rather than anything the VM system
 * manages.
 *
 * This host panicked three times that way. The third time the zone sat near 1.4 GB
 * for twelve days, then climbed to 17.9 GB in eight hours while gmax's compactor
 * dirtied 549.76 GB of file-backed memory. See
 * docs/2026-08-04-macos-kernel-zone-panic-incident.md.
 *
 * gmax cannot fix the kernel defect, but it can decline to be the thing that
 * detonates it. Sampling the zone is cheap (~0.2 s), so the daemon watches its own
 * blast radius and stands down while there are still hours of headroom.
 */

/** The zone that leaks. Named explicitly so `zprint` returns a single line. */
const ZONE_NAME = "data.kalloc.1024";

/**
 * Warn threshold.
 *
 * Twelve days of ordinary use held this zone between 0.67 and 1.37 GiB, so 4 GiB is
 * roughly 3x anything a healthy host has been observed to reach. During the
 * August 17 burst the zone crossed this about 90 minutes in — early enough that
 * stopping then would have avoided the panic with hours to spare.
 */
const WARN_BYTES = 4 * 1024 ** 3;

/**
 * Critical threshold — the daemon stands down here.
 *
 * The observed zone map cap on this hardware is ~17.6 GiB. Eight GiB is under half
 * of it, and at the burst rate actually measured (~2.0 GiB/hour) it still leaves
 * roughly five hours before exhaustion. The margin is deliberately generous: the
 * cost of standing down early is a stale index, and the cost of standing down late
 * is an unplanned reboot.
 */
const CRITICAL_BYTES = 8 * 1024 ** 3;

export type ZonePressure = "ok" | "warn" | "critical";

export interface KernelZoneUsage {
  /** Live elements in the zone. */
  elements: number;
  /** Element size in bytes, as reported by the kernel. */
  elementSize: number;
  /** elements * elementSize. */
  bytes: number;
  pressure: ZonePressure;
}

export function classifyZonePressure(bytes: number): ZonePressure {
  if (bytes >= CRITICAL_BYTES) return "critical";
  if (bytes >= WARN_BYTES) return "warn";
  return "ok";
}

/**
 * Parse one `zprint <zone>` report.
 *
 * Exported for tests; the column layout is a stable but undocumented text format,
 * so this validates rather than trusting it:
 *
 * ```
 *                             elem         cur         max        cur         max         cur  alloc  alloc
 * zone name                   size        size        size      #elts       #elts       inuse   size  count
 * data.kalloc.1024            1024          0K          0K          0           0        3416     0K      0
 * ```
 *
 * The `cur size` column reads `0K` on this build, which is why the byte figure is
 * derived from `cur inuse` x `elem size` rather than read directly.
 */
export function parseZprintOutput(
  output: string,
  zoneName = ZONE_NAME,
): { elements: number; elementSize: number } | null {
  for (const line of output.split("\n")) {
    const fields = line.trim().split(/\s+/);
    if (fields[0] !== zoneName) continue;
    const elementSize = Number(fields[1]);
    const elements = Number(fields[6]);
    if (!Number.isInteger(elementSize) || elementSize <= 0) return null;
    if (!Number.isInteger(elements) || elements < 0) return null;
    return { elements, elementSize };
  }
  return null;
}

/**
 * Sample the zone. Returns null off macOS, or whenever the sample cannot be
 * trusted — an unparseable report must read as "unknown", never as "healthy" and
 * never as a reason to stop working.
 */
export function readKernelZoneUsage(
  zoneName = ZONE_NAME,
): KernelZoneUsage | null {
  if (process.platform !== "darwin") return null;
  try {
    const output = execFileSync("zprint", [zoneName], {
      encoding: "utf-8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const parsed = parseZprintOutput(output, zoneName);
    if (!parsed) return null;
    const bytes = parsed.elements * parsed.elementSize;
    return { ...parsed, bytes, pressure: classifyZonePressure(bytes) };
  } catch {
    return null;
  }
}

export function formatZoneUsage(usage: KernelZoneUsage): string {
  const gib = (usage.bytes / 1024 ** 3).toFixed(2);
  return `${ZONE_NAME} at ${gib}GiB (${usage.elements.toLocaleString()} elements)`;
}

export const ZONE_THRESHOLDS = {
  warnBytes: WARN_BYTES,
  criticalBytes: CRITICAL_BYTES,
  zoneName: ZONE_NAME,
} as const;
