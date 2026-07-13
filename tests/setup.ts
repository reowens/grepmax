import { vi } from "vitest";
import { CONFIG } from "../src/config";

// Avoid spinning up heavy embedding workers during tests.
const vectorDim = CONFIG.VECTOR_DIM;
vi.mock("../src/lib/workers/pool", async () => {
  const { resolveEmbeddingGeneration } = await import(
    "../src/lib/index/embedding-generation"
  );
  const generation = resolveEmbeddingGeneration({
    modelTier: "small",
    vectorDim,
  });
  const makeDense = (len: number) => Array(len).fill(0);
  const mockPool = {
    processFile: vi.fn(async (_input: unknown) => []),
    encodeQuery: vi.fn(async () => ({
      dense: makeDense(vectorDim),
      colbert: [],
      colbertDim: CONFIG.COLBERT_DIM,
    })),
    rerank: vi.fn(async (_input: unknown) => []),
    destroy: vi.fn(async () => {}),
    generation,
    embedMode: "cpu" as const,
  };
  class MockWorkerPool {
    processFile = mockPool.processFile;
    encodeQuery = mockPool.encodeQuery;
    rerank = mockPool.rerank;
    destroy = mockPool.destroy;
    getWorkerPids = vi.fn(() => [] as number[]);
    generation: typeof generation;
    embedMode: "cpu" | "gpu";

    constructor(
      requestedGeneration: typeof generation = generation,
      requestedMode: "cpu" | "gpu" = "cpu",
    ) {
      this.generation = requestedGeneration;
      this.embedMode = requestedMode;
    }
  }
  return {
    WorkerPool: MockWorkerPool,
    getWorkerPool: () => mockPool,
    destroyWorkerPool: vi.fn(async () => {}),
    isWorkerPoolInitialized: vi.fn(() => true),
  };
});
