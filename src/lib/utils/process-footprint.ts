import { execFileSync } from "node:child_process";

/**
 * Physical footprint of a process, in MB — the number Activity Monitor and jetsam
 * use, and the one the daemon's recycle watermark has to read.
 *
 * `process.memoryUsage().rss` is not that number on macOS. RSS only counts pages
 * currently resident, so once the compressor or swap takes a page it drops out:
 * the daemon read 469 MB of RSS while `footprint` reported 4 GB (9.6 GB peak), and
 * the RSS watermark never fired. `footprint -p` counts compressed and swapped dirty
 * memory too, and costs ~50 ms.
 *
 * Off macOS, or when the sample cannot be parsed, falls back to RSS — an
 * underestimate, which only ever delays a recycle, never causes a spurious one.
 */
export function readFootprintMb(pid: number = process.pid): number {
  if (process.platform === "darwin") {
    try {
      const output = execFileSync("footprint", ["-p", String(pid)], {
        encoding: "utf-8",
        timeout: 5000,
        stdio: ["ignore", "pipe", "ignore"],
      });
      const parsed = parseFootprintMb(output);
      if (parsed != null) return parsed;
    } catch {}
  }
  return pid === process.pid ? process.memoryUsage().rss / (1024 * 1024) : 0;
}

const UNIT_TO_MB: Record<string, number> = {
  B: 1 / (1024 * 1024),
  KB: 1 / 1024,
  MB: 1,
  GB: 1024,
};

/** Parse the `Footprint: 4232 MB` header line of `footprint -p` output. */
export function parseFootprintMb(output: string): number | null {
  const match = /Footprint:\s*([\d.]+)\s*(B|KB|MB|GB)\b/.exec(output);
  if (!match) return null;
  const value = Number(match[1]);
  const scale = UNIT_TO_MB[match[2]];
  if (!Number.isFinite(value) || scale == null) return null;
  return value * scale;
}
