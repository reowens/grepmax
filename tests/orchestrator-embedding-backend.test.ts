import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveEmbeddingGeneration } from "../src/lib/index/embedding-generation";

const mocks = vi.hoisted(() => ({
  mlxEmbed: vi.fn(),
  mlxExisting: vi.fn(),
  mlxReady: true,
  graniteReady: true,
  quarantine: null as string | null,
  graniteRunBatch: vi.fn(),
}));

vi.mock("../src/lib/utils/autostart", () => ({
  daemonStartDeniedReason: () => mocks.quarantine,
}));
vi.mock("../src/lib/workers/embeddings/mlx-client", () => ({
  mlxEmbed: mocks.mlxEmbed,
  mlxEmbedExisting: mocks.mlxExisting,
  isMlxExistingReady: () => mocks.mlxReady,
}));

vi.mock("../src/lib/workers/embeddings/granite", () => ({
  GraniteModel: class {
    runBatch = mocks.graniteRunBatch;
    isReady() {
      return mocks.graniteReady;
    }
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
    mocks.mlxExisting.mockReset();
    mocks.quarantine = null;
    mocks.mlxReady = true;
    mocks.graniteReady = true;
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
  it.each(["cpu", "gpu"] as const)(
    "restricted cold %s query refuses before ensureReady or encoding",
    async (mode) => {
      const orchestrator = new WorkerOrchestrator(
        resolveEmbeddingGeneration({ modelTier: "small" }),
        mode,
      );
      mocks.mlxReady = false;
      mocks.graniteReady = false;
      const setup = vi.spyOn(orchestrator as any, "ensureReady");
      await expect(
        orchestrator.encodeQuery(
          "PRIVATE_QUERY",
          true,
          resolveEmbeddingGeneration({ modelTier: "small" }).fingerprint,
        ),
      ).rejects.toThrow("embedding_unavailable");
      expect(setup).not.toHaveBeenCalled();
      expect(mocks.mlxEmbed).not.toHaveBeenCalled();
      expect(mocks.mlxExisting).not.toHaveBeenCalled();
      expect(mocks.graniteRunBatch).not.toHaveBeenCalled();
    },
  );
  it("restricted GPU failure cannot fall back to ONNX or normal MLX", async () => {
    const orchestrator = new WorkerOrchestrator(
      resolveEmbeddingGeneration({ modelTier: "small" }),
      "gpu",
    );
    mocks.mlxExisting.mockRejectedValue(new Error("embedding_unavailable"));
    const setup = vi.spyOn(orchestrator as any, "ensureReady");
    await expect(
      orchestrator.encodeQuery(
        "PRIVATE_QUERY",
        true,
        resolveEmbeddingGeneration({ modelTier: "small" }).fingerprint,
      ),
    ).rejects.toThrow("embedding_unavailable");
    expect(setup).not.toHaveBeenCalled();
    expect(mocks.graniteRunBatch).not.toHaveBeenCalled();
    expect(mocks.mlxEmbed).not.toHaveBeenCalled();
  });
  it("restricted CPU uses warm Granite only and skips initialization", async () => {
    const orchestrator = new WorkerOrchestrator(
      resolveEmbeddingGeneration({ modelTier: "small" }),
      "cpu",
    );
    const setup = vi.spyOn(orchestrator as any, "ensureReady");
    await expect(
      orchestrator.encodeQuery(
        "query",
        true,
        resolveEmbeddingGeneration({ modelTier: "small" }).fingerprint,
      ),
    ).resolves.toMatchObject({
      dense: expect.any(Array),
      colbert: [],
      colbertDim: 0,
    });
    expect(setup).not.toHaveBeenCalled();
    expect(mocks.graniteRunBatch).toHaveBeenCalledWith(["query"], true);
    expect(mocks.mlxEmbed).not.toHaveBeenCalled();
  });
  it("restricted execution rejects mismatched generation or a newly applied hold before inference", async () => {
    const generation = resolveEmbeddingGeneration({ modelTier: "small" }),
      orchestrator = new WorkerOrchestrator(generation, "cpu");
    await expect(
      orchestrator.encodeQuery("query", true, "wrong"),
    ).rejects.toThrow("embedding_mismatch");
    mocks.quarantine = "concurrent hold";
    await expect(
      orchestrator.encodeQuery("query", true, generation.fingerprint),
    ).rejects.toThrow("host_pressure");
    expect(mocks.graniteRunBatch).not.toHaveBeenCalled();
    expect(mocks.mlxEmbed).not.toHaveBeenCalled();
    expect(mocks.mlxExisting).not.toHaveBeenCalled();
  });
});
