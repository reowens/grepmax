import { inner } from "numkong";
import { expect, it } from "vitest";
import { preparePackedMaxSim } from "../src/lib/workers/colbert-packed";

function reference(query: Float32Array[], document: Float32Array[]): number {
  return query.reduce((sum, q) => {
    let best = -Infinity;
    for (const row of document) best = Math.max(best, inner(q, row));
    return sum + best;
  }, 0);
}

function rows(count: number, phase = 0): Float32Array[] {
  return Array.from({ length: count }, (_, i) =>
    Float32Array.from({ length: 48 }, (_, d) => Math.sin(i * 48 + d + phase)),
  );
}

it.each([
  [4, 8],
  [8, 127],
  [32, 512],
  [128, 512],
])(
  "preserves exact pairwise scores for %i query and %i document tokens",
  (queries, tokens) => {
    const query = rows(queries);
    const document = rows(tokens, 17);
    expect(preparePackedMaxSim(query)!(document)).toBe(
      reference(query, document),
    );
  },
);

it("reuses scratch buffers across alternating document lengths without retaining rows", () => {
  const query = rows(32);
  const score = preparePackedMaxSim(query)!;
  for (const count of [512, 8, 128, 16, 511, 8]) {
    const document = rows(count, count);
    expect(score(document)).toBe(reference(query, document));
  }
});

it("keeps negative best scores and exact duplicate winners", () => {
  const query = Array.from({ length: 8 }, () => new Float32Array(48).fill(1));
  const document = Array.from({ length: 16 }, (_, i) =>
    new Float32Array(48).fill(i < 2 ? -1 : -2),
  );
  expect(preparePackedMaxSim(query)!(document)).toBe(-384);
  for (const row of document) row.fill(-1);
  expect(preparePackedMaxSim(query)!(document)).toBe(-384);
});

it("refines close contenders using the original dot kernel", () => {
  const query = rows(8);
  const first = new Float32Array(48).fill(1);
  const adjacent = new Float32Array(first);
  const bits = new Uint32Array(adjacent.buffer);
  bits[17]++;
  const document = [first, adjacent, ...rows(14, 103)];
  expect(preparePackedMaxSim(query)!(document)).toBe(
    reference(query, document),
  );
});

it("handles zero vectors and wide finite scales without changing scores", () => {
  for (const exponent of [-100, -30, 0, 30, 100]) {
    const query = rows(8).map((row) => row.map((v) => v * 2 ** exponent));
    const document = rows(32, 3).map((row) =>
      row.map((v) => v * 2 ** -exponent),
    );
    query[0].fill(0);
    expect(preparePackedMaxSim(query)!(document)).toBe(
      reference(query, document),
    );
  }
});

it("respects typed view offsets and leaves query and document storage unchanged", () => {
  const backing = Float32Array.from({ length: 48 * 20 + 2 }, (_, i) =>
    Math.sin(i),
  );
  const before = new Float32Array(backing);
  const query = Array.from({ length: 4 }, (_, i) =>
    backing.subarray(1 + i * 48, 1 + (i + 1) * 48),
  );
  const document = Array.from({ length: 16 }, (_, i) =>
    backing.subarray(1 + (i + 4) * 48, 1 + (i + 5) * 48),
  );
  expect(preparePackedMaxSim(query)!(document)).toBe(
    reference(query, document),
  );
  expect(backing).toEqual(before);
});

it("declines unsupported shapes before passing them to native kernels", () => {
  expect(preparePackedMaxSim([])).toBeUndefined();
  expect(preparePackedMaxSim(rows(129))).toBeUndefined();
  expect(preparePackedMaxSim([new Float32Array(47)])).toBeUndefined();
  const score = preparePackedMaxSim(rows(4))!;
  expect(score([])).toBeUndefined();
  expect(score(rows(7))).toBeUndefined();
  expect(score(rows(513))).toBeUndefined();
  const ragged = rows(8);
  ragged[3] = new Float32Array(47);
  expect(score(ragged)).toBeUndefined();
});

it.each([NaN, Infinity, -Infinity])(
  "declines non-finite inputs (%s)",
  (value) => {
    const query = rows(4);
    query[0][0] = value;
    expect(preparePackedMaxSim(query)).toBeUndefined();
    const document = rows(8);
    document[0][0] = value;
    expect(preparePackedMaxSim(rows(4))!(document)).toBeUndefined();
  },
);
