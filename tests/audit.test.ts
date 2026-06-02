import { describe, expect, it } from "vitest";
import { type AuditRow, computeAudit } from "../src/commands/audit";

/**
 * Unit coverage for the `gmax audit` aggregator. Pure function over synthetic
 * chunk rows — no DB. Validates the three derived categories (god nodes, hub
 * files, dead candidates) plus the cross-file/self-reference edge handling.
 */

const PREFIX = "/proj/";

function row(
  path: string,
  startLine: number,
  exported: boolean,
  defs: string[],
  refs: string[],
): AuditRow {
  return {
    path: `${PREFIX}${path}`,
    start_line: startLine,
    is_exported: exported,
    defined_symbols: defs,
    referenced_symbols: refs,
  };
}

describe("computeAudit", () => {
  it("ranks god nodes by distinct external inbound files", () => {
    const rows: AuditRow[] = [
      // Core defines `BeyondError`; three other files reference it.
      row("core.ts", 0, true, ["BeyondError"], []),
      row("a.ts", 0, false, ["a"], ["BeyondError"]),
      row("b.ts", 0, false, ["b"], ["BeyondError"]),
      row("c.ts", 0, false, ["c"], ["BeyondError", "BeyondError"]),
      // `lonely` is defined but only referenced from its own file → not a god.
      row("d.ts", 0, true, ["lonely"], ["lonely"]),
    ];
    const r = computeAudit(rows, PREFIX, 10);
    const god = r.godNodes.find((g) => g.symbol === "BeyondError");
    expect(god).toBeDefined();
    expect(god!.inboundFiles).toBe(3);
    expect(god!.totalRefs).toBe(4); // a + b + c×2
    expect(god!.file).toBe("core.ts");
    // self-only reference excluded from god nodes
    expect(r.godNodes.some((g) => g.symbol === "lonely")).toBe(false);
  });

  it("excludes sub-3-char symbol names from god nodes", () => {
    const rows: AuditRow[] = [
      row("core.ts", 0, true, ["id"], []),
      row("a.ts", 0, false, ["a"], ["id"]),
      row("b.ts", 0, false, ["b"], ["id"]),
    ];
    const r = computeAudit(rows, PREFIX, 10);
    expect(r.godNodes.some((g) => g.symbol === "id")).toBe(false);
  });

  it("ranks hub files by distinct external dependents", () => {
    const rows: AuditRow[] = [
      row("hub.ts", 0, true, ["util"], []),
      row("x.ts", 0, false, ["x"], ["util"]),
      row("y.ts", 0, false, ["y"], ["util"]),
      // leaf.ts defines something nobody references.
      row("leaf.ts", 0, false, ["leaf"], ["util"]),
    ];
    const r = computeAudit(rows, PREFIX, 10);
    const hub = r.hubFiles.find((h) => h.file === "hub.ts");
    expect(hub).toBeDefined();
    expect(hub!.dependents).toBe(3); // x, y, leaf
    expect(hub!.defines).toBe(1);
    // Files with zero dependents are dropped from the hub list.
    expect(r.hubFiles.some((h) => h.file === "leaf.ts")).toBe(false);
    // Fan-out counts only in-project referenced symbols.
    const x = r.hubFiles.find((h) => h.file === "x.ts");
    expect(x).toBeUndefined(); // x.ts has 0 dependents → filtered out
  });

  it("counts fan-out as distinct in-project referenced symbols only", () => {
    const rows: AuditRow[] = [
      // consumer references one in-project symbol (`util`) and one external
      // (`lodashThing`, never defined in-project). Fan-out should be 1.
      row("consumer.ts", 0, true, ["consumer"], ["util", "lodashThing"]),
      row("util.ts", 0, true, ["util"], ["consumer"]),
    ];
    const r = computeAudit(rows, PREFIX, 10);
    const consumer = r.hubFiles.find((h) => h.file === "consumer.ts");
    expect(consumer).toBeDefined();
    expect(consumer!.fanOut).toBe(1);
  });

  it("flags non-exported zero-inbound symbols as dead, never exported ones", () => {
    const rows: AuditRow[] = [
      row("a.ts", 5, false, ["unusedPrivate"], []),
      row("a.ts", 20, true, ["unusedPublic"], []), // exported → PUBLIC, not dead
      row("b.ts", 0, false, ["usedPrivate"], []),
      row("c.ts", 0, false, ["caller"], ["usedPrivate"]),
    ];
    const r = computeAudit(rows, PREFIX, 10);
    const deadSyms = r.deadCandidates.map((d) => d.symbol);
    expect(deadSyms).toContain("unusedPrivate");
    expect(deadSyms).not.toContain("unusedPublic"); // exported
    expect(deadSyms).not.toContain("usedPrivate"); // referenced elsewhere
    expect(r.deadTotal).toBe(2); // unusedPrivate + caller (caller has 0 inbound)
  });

  it("reports deadTotal beyond the top cap and respects the cap on each list", () => {
    const rows: AuditRow[] = [];
    for (let i = 0; i < 25; i++) {
      rows.push(row(`dead${i}.ts`, 0, false, [`dead${i}`], []));
    }
    const r = computeAudit(rows, PREFIX, 10);
    expect(r.deadCandidates.length).toBe(10);
    expect(r.deadTotal).toBe(25);
  });

  it("reports scanned chunk and distinct-file counts", () => {
    const rows: AuditRow[] = [
      row("a.ts", 0, false, ["a"], []),
      row("a.ts", 10, false, ["a2"], []),
      row("b.ts", 0, false, ["b"], []),
    ];
    const r = computeAudit(rows, PREFIX, 10);
    expect(r.scannedChunks).toBe(3);
    expect(r.scannedFiles).toBe(2);
  });
});
