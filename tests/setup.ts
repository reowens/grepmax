import { vi } from "vitest";
import { CONFIG } from "../src/config";

// Avoid spinning up heavy embedding workers during tests.
const vectorDim = CONFIG.VECTOR_DIM;
vi.mock("../src/lib/utils/host-resource", () => ({
  sampleHostResources: vi.fn(() => null),
}));
// Resource tests explicitly unmock this module and use temporary ledgers plus
// injected probes. Other tests must never sample or reserve the real host.
vi.mock("../src/lib/utils/resource-budget", () => ({
  resourceBudget: {
    check: vi.fn(() => null),
    reserve: vi.fn(() => ({ attach: vi.fn(), release: vi.fn() })),
    registerClient: vi.fn(() => ({ attach: vi.fn(), release: vi.fn() })),
  },
  WORKER_RESOURCE_RESERVE_MB: 1536,
  EMBEDDING_RESOURCE_RESERVE_MB: 1024,
  ResourceAdmissionError: class extends Error {
    critical = false;
  },
}));
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
