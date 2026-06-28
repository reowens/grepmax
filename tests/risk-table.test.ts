import { describe, expect, it } from "vitest";
import {
  type RiskInput,
  computeRiskTable,
  formatRiskTable,
} from "../src/lib/review/risk";

/**
 * Phase 8 — diff-aware risk preamble. The scoring + ordering is the contract;
 * keep it pure and explainable. (Gathering is git/graph I/O, exercised live.)
 */

const mk = (over: Partial<RiskInput>): RiskInput => ({
  symbol: "fn",
  file: "src/fn.ts",
  line: 1,
  callerCount: 0,
  hasTests: true,
  churn: 0,
  ...over,
});

describe("computeRiskTable", () => {
  it("ranks higher blast radius first", () => {
    const rows = computeRiskTable([
      mk({ symbol: "small", callerCount: 1 }),
      mk({ symbol: "big", callerCount: 20 }),
      mk({ symbol: "mid", callerCount: 5 }),
    ]);
    expect(rows.map((r) => r.symbol)).toEqual(["big", "mid", "small"]);
  });

  it("penalizes untested symbols — an untested change outranks a tested one of equal blast radius", () => {
    const rows = computeRiskTable([
      mk({ symbol: "tested", callerCount: 5, hasTests: true }),
      mk({ symbol: "untested", callerCount: 5, hasTests: false }),
    ]);
    expect(rows[0].symbol).toBe("untested");
    // untested doubles the score of an otherwise-identical symbol
    expect(rows[0].score).toBeCloseTo(rows[1].score * 2, 5);
  });

  it("factors churn in on a log scale (nudges, doesn't swamp blast radius)", () => {
    const churny = computeRiskTable([mk({ callerCount: 2, churn: 100 })])[0];
    const fresh = computeRiskTable([mk({ callerCount: 2, churn: 0 })])[0];
    expect(churny.score).toBeGreaterThan(fresh.score);
    // a high-churn low-blast symbol still ranks below a high-blast one
    const rows = computeRiskTable([
      mk({ symbol: "churny", callerCount: 2, churn: 500 }),
      mk({ symbol: "central", callerCount: 50, churn: 0 }),
    ]);
    expect(rows[0].symbol).toBe("central");
  });

  it("scores a zero-caller symbol without dividing by zero, lowest of the set", () => {
    const rows = computeRiskTable([
      mk({ symbol: "leaf", callerCount: 0 }),
      mk({ symbol: "used", callerCount: 3 }),
    ]);
    expect(rows.map((r) => r.symbol)).toEqual(["used", "leaf"]);
    expect(rows[1].score).toBeGreaterThan(0);
  });
});

describe("formatRiskTable", () => {
  const rows = computeRiskTable([
    mk({
      symbol: "BeyondError",
      file: "src/errors.ts",
      line: 10,
      callerCount: 12,
      hasTests: false,
      churn: 8,
    }),
  ]);

  it("emits a machine-readable TSV line per symbol in agent mode", () => {
    const out = formatRiskTable(rows, { agent: true });
    expect(out).toContain("risk\t");
    expect(out).toContain("\tBeyondError\t");
    expect(out).toContain("src/errors.ts:10");
    expect(out).toContain("callers=12");
    expect(out).toContain("tests=n");
    expect(out).toContain("churn=8");
  });

  it("flags untested high-blast symbols in human mode", () => {
    const out = formatRiskTable(rows, { agent: false });
    expect(out).toContain("BeyondError");
    expect(out).toContain("no tests");
    expect(out).toContain("⚠ untested");
  });

  it("handles the empty case", () => {
    expect(formatRiskTable([], { agent: true })).toBe("(no changed symbols)");
    expect(formatRiskTable([], { agent: false })).toBe(
      "No changed symbols to rank.",
    );
  });
});
