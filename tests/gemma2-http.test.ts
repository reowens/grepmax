import { EventEmitter } from "node:events";
import { afterEach, expect, it, vi } from "vitest";
import {
  GEMMA2_CONTRACT_DIGEST as contract,
  GEMMA2_MODEL as model,
} from "../src/lib/workers/embeddings/gemma2";

const h = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("node:http", async (original) => ({
  ...(await original<typeof import("node:http")>()),
  request: h.request,
}));
const vectors = [[1, ...Array(767).fill(0)]];
function transport(health: object, post: object) {
  h.request.mockImplementation((options, callback) => {
    const req = Object.assign(new EventEmitter(), {
      destroy: vi.fn(),
      end: vi.fn(),
    });
    req.end.mockImplementation(() =>
      queueMicrotask(() => {
        const res = Object.assign(new EventEmitter(), { statusCode: 200 });
        callback(res);
        res.emit(
          "data",
          Buffer.from(
            JSON.stringify(options.path === "/health" ? health : post),
          ),
        );
        res.emit("end");
      }),
    );
    return req;
  });
}
afterEach(() => {
  vi.useRealTimers();
  h.request.mockReset();
});
it("requires contract identity before POST and does not treat a same-name server as ready", async () => {
  vi.resetModules();
  vi.useFakeTimers();
  transport({ model }, { model, contract, dim: 768, vectors });
  const { mlxEmbed } = await import("../src/lib/workers/embeddings/mlx-client");
  const pending = mlxEmbed(["task: code retrieval | query: handler"], {
    mode: "gpu",
    expectedModel: model,
    expectedDim: 768,
  });
  await vi.advanceTimersByTimeAsync(3000);
  await expect(pending).resolves.toBeNull();
  expect(h.request.mock.calls.every(([o]) => o.path === "/health")).toBe(true);
});
it.each([
  { model, dim: 768, vectors },
  { model, contract: "wrong", dim: 768, vectors },
  { model, contract, dim: 768, vectors: [Array(768).fill(0)] },
])(
  "rejects a response with a missing/wrong contract or normalization",
  async (post) => {
    vi.resetModules();
    transport({ model, contract }, post);
    const { mlxEmbed, isMlxExistingReady } = await import(
      "../src/lib/workers/embeddings/mlx-client"
    );
    await expect(
      mlxEmbed(["query"], {
        mode: "gpu",
        expectedModel: model,
        expectedDim: 768,
      }),
    ).rejects.toThrow(/protocol failure/);
    expect(isMlxExistingReady(model)).toBe(false);
  },
);
it("sends and verifies the contract on ordinary and existing-only requests", async () => {
  vi.resetModules();
  transport({ model, contract }, { model, contract, dim: 768, vectors });
  const { mlxEmbed, mlxEmbedExisting } = await import(
    "../src/lib/workers/embeddings/mlx-client"
  );
  const options = {
    mode: "gpu" as const,
    expectedModel: model,
    expectedDim: 768,
  };
  expect((await mlxEmbed(["query"], options))?.[0][0]).toBe(1);
  expect((await mlxEmbedExisting(["query"], options))[0][0]).toBe(1);
  for (const [, req] of h.request.mock.results.map((r, i) => [
    h.request.mock.calls[i],
    r.value,
  ]) as any[]) {
    if (req.end.mock.calls[0][0])
      expect(JSON.parse(req.end.mock.calls[0][0]).expected_contract).toBe(
        contract,
      );
  }
});
