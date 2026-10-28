import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { inner } from "numkong";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createMaxSimScorer, maxSim } from "../src/lib/workers/colbert-math";

const modelId = "synthetic/maxsim";
let root: string;

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "gmax-maxsim-"));
  const model = path.join(root, "models", modelId);
  fs.mkdirSync(model, { recursive: true });
  fs.writeFileSync(path.join(model, "skiplist.json"), "[0,7]");
  vi.stubEnv("GMAX_PROJECT_ROOT", root);
});

afterAll(() => {
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("MaxSim scoring", () => {
  it("sums each query token's best document match for arrays and typed views", () => {
    const query = [
      [1, 0],
      [0, 1],
    ];
    const docs = [
      [0.5, 0.25],
      [-1, 0.75],
    ];
    expect(maxSim(query, docs, undefined, modelId)).toBe(1.25);
    const backing = new Float32Array([99, 0.5, 0.25, -1, 0.75, 99]);
    expect(
      maxSim(
        query.map((row) => new Float32Array(row)),
        [backing.subarray(1, 3), backing.subarray(3, 5)],
        undefined,
        modelId,
      ),
    ).toBe(1.25);
    expect(Array.from(backing)).toEqual([99, 0.5, 0.25, -1, 0.75, 99]);
  });

  it("retains negative best matches instead of clamping them to zero", () => {
    expect(
      maxSim(
        [
          [1, 0],
          [0, 1],
        ],
        [
          [-2, -3],
          [-1, -4],
        ],
        undefined,
        modelId,
      ),
    ).toBe(-4);
  });

  it("excludes skiplisted document tokens for every query token", () => {
    expect(
      maxSim(
        [
          [1, 0],
          [0, 1],
        ],
        [
          [10, 10],
          [0.5, 0.25],
          [20, 20],
        ],
        [7, 2, 0],
        modelId,
      ),
    ).toBe(0.75);
  });

  it("returns zero when every document token is excluded", () => {
    expect(
      maxSim(
        [[1, 2]],
        [
          [10, 20],
          [30, 40],
        ],
        [0, 7],
        modelId,
      ),
    ).toBe(0);
  });

  it("ignores token IDs unless their count matches the document", () => {
    expect(maxSim([[1]], [[2], [4]], [7], modelId)).toBe(4);
  });

  it("uses only shared dimensions for ragged query and document rows", () => {
    expect(maxSim([[1, 2], [3]], [[2], [1, 4, 99]], undefined, modelId)).toBe(
      15,
    );
  });

  it("handles empty matrices and empty token rows", () => {
    expect(maxSim([], [[1]], undefined, modelId)).toBe(0);
    expect(maxSim([[1]], [], undefined, modelId)).toBe(0);
    expect(maxSim([[], [1]], [[], [2]], undefined, modelId)).toBe(2);
  });

  it("matches an independent scalar reference on 48d inputs", () => {
    const query = Array.from({ length: 32 }, (_, i) =>
      Float32Array.from({ length: 48 }, (_, d) => Math.sin(i * 48 + d) / 8),
    );
    const docs = Array.from({ length: 128 }, (_, i) =>
      Float32Array.from({ length: 48 }, (_, d) => Math.cos(i * 48 + d) / 8),
    );
    const tokenIds = docs.map((_, i) => i % 17);
    const expected = query.reduce(
      (total, q) =>
        total +
        Math.max(
          ...docs
            .filter((_, i) => ![0, 7].includes(tokenIds[i]))
            .map((doc) => q.reduce((dot, value, d) => dot + value * doc[d], 0)),
        ),
      0,
    );
    expect(maxSim(query, docs, tokenIds, modelId)).toBeCloseTo(expected, 5);
  });

  it("keeps skiplist and ID-count semantics while reusing a packed query", () => {
    const query = Array.from({ length: 8 }, (_, i) =>
      Float32Array.from({ length: 48 }, (_, d) => Math.sin(i * 48 + d)),
    );
    const score = createMaxSimScorer(query, modelId);
    for (const count of [128, 8, 512, 3, 0, 32]) {
      const docs = Array.from({ length: count }, (_, i) =>
        Float32Array.from({ length: 48 }, (_, d) => Math.cos(i * 48 + d)),
      );
      const ids = docs.map((_, i) => i % 17);
      for (const tokenIds of [ids, [7], ids.map(() => 7)]) {
        const eligible = docs.filter(
          (_, i) =>
            tokenIds.length !== docs.length || ![0, 7].includes(tokenIds[i]),
        );
        const expected =
          eligible.length === 0
            ? 0
            : query.reduce(
                (sum, q) => sum + Math.max(...eligible.map((d) => inner(q, d))),
                0,
              );
        expect(score(docs, tokenIds)).toBe(expected);
      }
    }
  });

  it("retains pairwise handling of non-finite 48d inputs", () => {
    const query = Array.from({ length: 8 }, () => new Float32Array(48).fill(1));
    const docs = Array.from({ length: 16 }, () => new Float32Array(48).fill(1));
    docs[0][0] = NaN;
    expect(maxSim(query, docs, undefined, modelId)).toBe(384);
    query[0][0] = NaN;
    expect(maxSim(query, docs, undefined, modelId)).toBe(336);
  });
});
