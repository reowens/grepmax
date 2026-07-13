import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveEmbeddingGeneration } from "../src/lib/index/embedding-generation";

const mocks = vi.hoisted(() => ({
  mlxEmbed: vi.fn(),
  graniteRunBatch: vi.fn(),
}));

vi.mock("../src/lib/workers/embeddings/mlx-client", () => ({
  mlxEmbed: mocks.mlxEmbed,
}));

vi.mock("../src/lib/workers/embeddings/granite", () => ({
  GraniteModel: class {
    runBatch = mocks.graniteRunBatch;
  },
}));

vi.mock("../src/lib/workers/embeddings/colbert", () => ({
  ColbertModel: class {
    isReady() {
      return true;
    }

    async runBatch(_texts: string[], dense: Float32Array[]) {
      return dense.map((vector) => ({
        dense: vector,
        colbert: new Int8Array(),
        scale: 1,
      }));
    }
  },
}));

import { WorkerOrchestrator } from "../src/lib/workers/orchestrator";

describe("WorkerOrchestrator dense backend selection", () => {
  beforeEach(() => {
    mocks.mlxEmbed.mockReset();
    mocks.graniteRunBatch.mockReset();
    mocks.graniteRunBatch.mockImplementation(async (texts: string[]) =>
      texts.map(() => new Float32Array(384)),
    );
  });

  it("does not fall back to fixed ONNX for a custom MLX generation", async () => {
    const generation = resolveEmbeddingGeneration({
      modelTier: "small",
      mlxModel: "custom/mlx",
    });
    const orchestrator = new WorkerOrchestrator(generation, "gpu");
    mocks.mlxEmbed.mockResolvedValue(null);

    await expect((orchestrator as any).computeHybrid(["text"])).rejects.toThrow(
      /fallback is disabled/i,
    );
    expect(mocks.graniteRunBatch).not.toHaveBeenCalled();
  });

  it("does not switch from MLX to ONNX between batches", async () => {
    const generation = resolveEmbeddingGeneration({ modelTier: "small" });
    const orchestrator = new WorkerOrchestrator(generation, "gpu");
    mocks.mlxEmbed
      .mockResolvedValueOnce(
        Array.from({ length: 16 }, () => new Float32Array(384)),
      )
      .mockResolvedValueOnce(null);

    await expect(
      (orchestrator as any).computeHybrid(Array(17).fill("text")),
    ).rejects.toThrow(/became unavailable/i);
    expect(mocks.graniteRunBatch).not.toHaveBeenCalled();
  });

  it("stays on ONNX after compatible fallback is selected", async () => {
    const generation = resolveEmbeddingGeneration({ modelTier: "small" });
    const orchestrator = new WorkerOrchestrator(generation, "gpu");
    mocks.mlxEmbed.mockResolvedValue(null);

    await (orchestrator as any).computeHybrid(Array(17).fill("text"));

    expect(mocks.mlxEmbed).toHaveBeenCalledTimes(1);
    expect(mocks.graniteRunBatch).toHaveBeenCalledTimes(2);
  });
});
