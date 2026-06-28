import { describe, expect, it } from "vitest";
import {
  formatViaAgent,
  formatViaHuman,
  groupTestHitsByFile,
} from "../src/lib/graph/test-hits";

describe("groupTestHitsByFile", () => {
  it("collapses multiple helper hits in one file to a single line", () => {
    const grouped = groupTestHitsByFile([
      {
        file: "/p/tests/pool.test.ts",
        symbol: "setTrackedPids",
        line: 170,
        hops: 1,
      },
      {
        file: "/p/tests/pool.test.ts",
        symbol: "spawnFakeWorker",
        line: 12,
        hops: 0,
      },
      {
        file: "/p/tests/pool.test.ts",
        symbol: "setTrackedPids",
        line: 170,
        hops: 2,
      },
    ]);
    expect(grouped).toHaveLength(1);
    const g = grouped[0];
    // Leads with the best (lowest-hop) hit's line and hops.
    expect(g.hops).toBe(0);
    expect(g.line).toBe(12);
    // Helpers preserved as detail, closest caller first, deduped.
    expect(g.via).toEqual(["spawnFakeWorker", "setTrackedPids"]);
  });

  it("sorts files by hops, import-fallback hits last", () => {
    const grouped = groupTestHitsByFile([
      { file: "/p/tests/b.test.ts", symbol: "(referenced)", line: 0, hops: -1 },
      { file: "/p/tests/a.test.ts", symbol: "helper", line: 5, hops: 1 },
    ]);
    expect(grouped.map((g) => g.file)).toEqual([
      "/p/tests/a.test.ts",
      "/p/tests/b.test.ts",
    ]);
    // The (referenced) placeholder is not a caller symbol.
    expect(grouped[1].via).toEqual([]);
  });
});

describe("via formatting", () => {
  it("caps the symbol list and counts the rest", () => {
    const via = ["a", "b", "c", "d", "e"];
    expect(formatViaAgent(via)).toBe("\tvia=a,b,c(+2)");
    expect(formatViaHuman(via)).toBe(", via a, b, c (+2 more)");
    expect(formatViaAgent([])).toBe("");
    expect(formatViaHuman([])).toBe("");
  });
});
