import { describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/graph/impact", () => ({
  findTests: vi.fn(),
}));

import { findTests } from "../src/lib/graph/impact";
import {
  fetchTestsForFooter,
  renderTestsFooterAgent,
  renderTestsFooterHuman,
} from "../src/lib/utils/tests-footer";

const fakeDb = { close: vi.fn(async () => {}) } as any;

describe("tests-footer", () => {
  describe("renderTestsFooterAgent", () => {
    it("emits one t: line per test in TSV form", () => {
      const lines = renderTestsFooterAgent(
        [
          { file: "/proj/tests/a.test.ts", symbol: "testA", line: 9, hops: 0 },
          { file: "/proj/tests/b.test.ts", symbol: "testB", line: 19, hops: 1 },
        ],
        "/proj",
      );
      expect(lines).toEqual([
        "t: tests/a.test.ts:10\ttestA\tdirect",
        "t: tests/b.test.ts:20\ttestB\t1-hop",
      ]);
    });

    it("labels hops=-1 as via-import", () => {
      const lines = renderTestsFooterAgent(
        [{ file: "/proj/tests/c.test.ts", symbol: "(ref)", line: 0, hops: -1 }],
        "/proj",
      );
      expect(lines[0]).toContain("via-import");
    });

    it("caps shown tests and emits a more line", () => {
      const tests = Array.from({ length: 8 }, (_, i) => ({
        file: `/proj/tests/${i}.test.ts`,
        symbol: `t${i}`,
        line: i,
        hops: 0,
      }));
      const lines = renderTestsFooterAgent(tests, "/proj");
      expect(lines).toHaveLength(6);
      expect(lines[5]).toBe("t: ... 3 more");
    });
  });

  describe("renderTestsFooterHuman", () => {
    it("emits a tests (N): header and indented lines", () => {
      const lines = renderTestsFooterHuman(
        [
          { file: "/proj/tests/a.test.ts", symbol: "testA", line: 9, hops: 0 },
        ],
        "/proj",
      );
      expect(lines[0]).toBe("");
      expect(lines[1]).toBe("tests (1):");
      expect(lines[2]).toContain("testA");
      expect(lines[2]).toContain("tests/a.test.ts:10");
      expect(lines[2]).toContain("(direct)");
    });

    it("uses 'via import' for hops=-1", () => {
      const lines = renderTestsFooterHuman(
        [{ file: "/proj/tests/c.test.ts", symbol: "(ref)", line: 0, hops: -1 }],
        "/proj",
      );
      expect(lines[2]).toContain("(via import)");
    });
  });

  describe("fetchTestsForFooter", () => {
    it("returns hits when findTests resolves", async () => {
      vi.mocked(findTests).mockResolvedValueOnce([
        { file: "/proj/tests/a.test.ts", symbol: "testA", line: 9, hops: 0 },
      ]);
      const result = await fetchTestsForFooter("foo", fakeDb, "/proj/", undefined);
      expect(result).toHaveLength(1);
    });

    it("returns null when findTests exceeds the timeout", async () => {
      vi.mocked(findTests).mockImplementationOnce(
        () => new Promise((resolve) => setTimeout(() => resolve([]), 5000)),
      );
      const start = Date.now();
      const result = await fetchTestsForFooter("foo", fakeDb, "/proj/", undefined);
      const elapsed = Date.now() - start;
      expect(result).toBeNull();
      expect(elapsed).toBeLessThan(2000);
    });
  });
});
