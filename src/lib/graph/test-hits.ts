import type { TestHit } from "./impact";

/**
 * One line per test file. `findTests` returns one hit per *caller symbol*
 * inside a test file — often internal helpers (e.g. `setTrackedPids`), which
 * read as if the helper were the test and multiply rows per file. The test
 * file is the unit the reader runs, so it leads; caller symbols become the
 * `via` detail.
 */
export interface TestFileHit {
  file: string;
  /** Line of the best (lowest-hop) hit in the file. */
  line: number;
  /** Min hops across the file's hits (-1 = import fallback). */
  hops: number;
  /** Caller symbols inside the test file, best hop first. */
  via: string[];
}

export function groupTestHitsByFile(hits: TestHit[]): TestFileHit[] {
  const byFile = new Map<string, TestFileHit>();
  // Sort by hops so the first hit per file carries the best line/hops and
  // `via` lists closest callers first ((referenced) fallback hits sort last).
  const ordered = [...hits].sort(
    (a, b) =>
      (a.hops === -1 ? Number.MAX_SAFE_INTEGER : a.hops) -
      (b.hops === -1 ? Number.MAX_SAFE_INTEGER : b.hops),
  );
  for (const h of ordered) {
    let g = byFile.get(h.file);
    if (!g) {
      g = { file: h.file, line: h.line, hops: h.hops, via: [] };
      byFile.set(h.file, g);
    }
    if (h.symbol && h.symbol !== "(referenced)" && !g.via.includes(h.symbol)) {
      g.via.push(h.symbol);
    }
  }
  return [...byFile.values()].sort(
    (a, b) =>
      (a.hops === -1 ? Number.MAX_SAFE_INTEGER : a.hops) -
        (b.hops === -1 ? Number.MAX_SAFE_INTEGER : b.hops) ||
      a.file.localeCompare(b.file),
  );
}

const MAX_VIA = 3;

/** `via=helperA,helperB(+2)` agent detail, or "" when there is none. */
export function formatViaAgent(via: string[]): string {
  if (via.length === 0) return "";
  const shown = via.slice(0, MAX_VIA).join(",");
  const more = via.length > MAX_VIA ? `(+${via.length - MAX_VIA})` : "";
  return `\tvia=${shown}${more}`;
}

/** `, via helperA, helperB (+2 more)` human detail, or "" when none. */
export function formatViaHuman(via: string[]): string {
  if (via.length === 0) return "";
  const shown = via.slice(0, MAX_VIA).join(", ");
  const more = via.length > MAX_VIA ? ` (+${via.length - MAX_VIA} more)` : "";
  return `, via ${shown}${more}`;
}

export function hopLabelAgent(hops: number): string {
  return hops === -1 ? "via-import" : hops === 0 ? "direct" : `${hops}-hop`;
}

export function hopLabelHuman(hops: number): string {
  return hops === -1
    ? "via import"
    : hops === 0
      ? "calls directly"
      : `${hops} hop${hops > 1 ? "s" : ""} away`;
}
