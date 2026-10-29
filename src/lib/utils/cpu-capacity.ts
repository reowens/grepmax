import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

interface CpuCapacityOptions {
  platform?: NodeJS.Platform;
  parallelism?: number;
  readText?: (file: string) => string;
}

/** Affinity and inherited Linux cgroup v2 quotas, rounded down with a one-CPU floor. */
export function effectiveCpuCount(options: CpuCapacityOptions = {}): number {
  const available = options.parallelism ?? os.availableParallelism();
  let capacity = Number.isFinite(available)
    ? Math.max(1, Math.floor(available))
    : 1;
  if ((options.platform ?? process.platform) !== "linux") return capacity;
  const read = options.readText ?? ((file) => fs.readFileSync(file, "utf8"));
  let relative: string | undefined;
  try {
    relative = read("/proc/self/cgroup")
      .split("\n")
      .find((line) => line.startsWith("0::"))
      ?.slice(3);
  } catch {
    return capacity;
  }
  if (!relative?.startsWith("/") || relative.split("/").includes(".."))
    return capacity;

  const root = "/sys/fs/cgroup";
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
        )
          capacity = Math.min(capacity, Math.max(1, Math.floor(q / p)));
      }
    } catch {
      // Missing/unreadable controller files leave affinity and other ancestors authoritative.
    }
    if (current === root) break;
    current = path.posix.dirname(current);
  }
  return capacity;
}
