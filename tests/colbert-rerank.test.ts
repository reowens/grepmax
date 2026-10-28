import { inner } from "numkong";
import { expect, it, vi } from "vitest";
import { resolveEmbeddingGeneration } from "../src/lib/index/embedding-generation";
import {
  rerankColbert,
  WorkerOrchestrator,
} from "../src/lib/workers/orchestrator";

const modelId = "synthetic/no-rerank-skiplist";

it("preserves exact decoded 48d scores across packed and pairwise document shapes", () => {
  const query = Array.from({ length: 32 }, (_, i) =>
    Array.from({ length: 48 }, (_, d) => Math.sin(i * 48 + d) / 8),
  );
  const docs = [512, 32, 8, 7, 0, 16, 128].map((tokens, i) => ({
    colbert: Int8Array.from(
      { length: tokens * 48 + (i % 2) },
      (_, d) => ((d * 13 + i * 11) % 255) - 127,
    ),
    scale: 0.5 + i / 8,
  }));
  const original = structuredClone({ query, docs });
  const qRows = query.map((row) => new Float32Array(row));
  const expected = docs.map((doc) => {
    const rows = Array.from(
      { length: Math.floor(doc.colbert.length / 48) },
      (_, i) =>
        Float32Array.from(
          { length: 48 },
          (_, d) => (doc.colbert[i * 48 + d] * doc.scale) / 127,
        ),
    );
    return rows.length === 0
      ? 0
      : qRows.reduce(
          (sum, q) => sum + Math.max(...rows.map((row) => inner(q, row))),
          0,
        );
  });
  expect(rerankColbert({ query, docs, colbertDim: 48 }, modelId)).toEqual(
    expected,
  );
  expect({ query, docs }).toEqual(original);
});

it("reuses decoding buffers without retaining a previous document's tokens or scale", () => {
  const input = {
    query: [
      [1, 0],
      [0, 1],
    ],
    colbertDim: 2,
    docs: [
      { colbert: new Int8Array([4, 1, 1, 4]), scale: 127 },
      { colbert: new Int8Array([-1, -2]), scale: 254 },
      { colbert: new Int8Array([5, -5, 0, 5, -3, -2]), scale: 127 },
    ],
  };
  const before = structuredClone(input);
  expect(rerankColbert(input, modelId)).toEqual([8, -6, 10]);
  expect(input).toEqual(before);
});

it("preserves signed byte view offsets and ignores incomplete trailing tokens", () => {
  const bytes = new Uint8Array([99, 4, 255, 127, 99]);
  expect(
    rerankColbert(
      {
        query: [[1, 1]],
        colbertDim: 2,
        docs: [{ colbert: bytes.subarray(1, 4), scale: 127 }],
      },
      modelId,
    ),
  ).toEqual([3]);
});

it("returns zero for empty queries and documents with no complete tokens", () => {
  expect(
    rerankColbert(
      {
        query: [],
        colbertDim: 48,
        docs: [{ colbert: new Int8Array([1, 2]), scale: 1 }],
      },
      modelId,
    ),
  ).toEqual([0]);
  expect(
    rerankColbert(
      {
        query: [[1, 2]],
        colbertDim: 2,
        docs: [
          { colbert: [], scale: 1 },
          { colbert: [1], scale: 1 },
        ],
      },
      modelId,
    ),
  ).toEqual([0, 0]);
});

it("reranks on a cold worker without initializing models or parsers", async () => {
  const worker = new WorkerOrchestrator(
    resolveEmbeddingGeneration({ modelTier: "small" }),
    "cpu",
  );
  const ready = vi
    .spyOn(worker as any, "ensureReady")
    .mockRejectedValue(new Error("Model load forbidden"));
  try {
    expect(
      await worker.rerank({
        query: [[1, 0]],
        colbertDim: 2,
        docs: [{ colbert: [2, 1], scale: 127 }],
      }),
    ).toEqual([2]);
    expect(ready).not.toHaveBeenCalled();
  } finally {
    ready.mockRestore();
  }
});
