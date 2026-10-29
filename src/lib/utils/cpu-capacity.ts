import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

interface CpuCapacityOptions {
  platform?: NodeJS.Platform;
  parallelism?: number;
  readText?: (file: string) => string;
}

export interface CpuCapacity {
  affinityCpus: number | null;
  /** Tightest readable quota in CPU units, before rounding. */
  quotaCpus: number | null;
  quotaStatus:
    | "limited"
    | "unlimited"
    | "partial"
    | "unavailable"
    | "not-applicable";
  effectiveCpus: number;
}

/** The same inputs used for admission; no process inventory or host probes. */
function detectCpuCapacity(options: CpuCapacityOptions): CpuCapacity {
  const available = options.parallelism ?? os.availableParallelism();
  const affinityCpus = Number.isFinite(available)
    ? Math.max(1, Math.floor(available))
    : null;
  const result: CpuCapacity = {
    affinityCpus,
    quotaCpus: null,
    quotaStatus: "not-applicable",
    effectiveCpus: affinityCpus ?? 1,
  };
  if ((options.platform ?? process.platform) !== "linux") return result;
  result.quotaStatus = "unavailable";
  const read = options.readText ?? ((file) => fs.readFileSync(file, "utf8"));
  let relative: string | undefined;
  try {
    relative = read("/proc/self/cgroup")
      .split("\n")
      .find((line) => line.startsWith("0::"))
      ?.slice(3);
  } catch {
    return result;
  }
  if (!relative?.startsWith("/") || relative.split("/").includes(".."))
    return result;

  const root = "/sys/fs/cgroup";
  let readable = false;
  let incomplete = false;
  // Resolve removes trailing separators too, keeping root membership canonical.
  let current = path.posix.resolve(root + relative);
  while (current === root || current.startsWith(`${root}/`)) {
    try {
      const [quota, period] = read(`${current}/cpu.max`).trim().split(/\s+/);
      if (/^\d+$/.test(quota) && /^\d+$/.test(period)) {
        const q = Number(quota);
        const p = Number(period);
        if (
          Number.isSafeInteger(q) &&
          Number.isSafeInteger(p) &&
          q > 0 &&
          p > 0
        ) {
          readable = true;
          result.quotaCpus = Math.min(result.quotaCpus ?? Infinity, q / p);
          result.effectiveCpus = Math.min(
            result.effectiveCpus,
            Math.max(1, Math.floor(q / p)),
          );
        } else incomplete = true;
      } else if (
        quota === "max" &&
        /^\d+$/.test(period) &&
        Number.isSafeInteger(Number(period)) &&
        Number(period) > 0
      ) {
        readable = true;
      } else incomplete = true;
    } catch {
      // Missing/unreadable controller files leave affinity and other ancestors authoritative.
      incomplete = true;
    }
    if (current === root) break;
    current = path.posix.dirname(current);
  }
  result.quotaStatus = !readable
    ? "unavailable"
    : incomplete
      ? "partial"
      : result.quotaCpus === null
        ? "unlimited"
        : "limited";
  return result;
}

/** Affinity and inherited Linux cgroup v2 quotas, rounded down with a one-CPU floor. */
export function effectiveCpuCount(
  options: CpuCapacityOptions = {},
  capture?: (capacity: CpuCapacity) => void,
): number {
  const capacity = detectCpuCapacity(options);
  capture?.(capacity);
  return capacity.effectiveCpus;
}
