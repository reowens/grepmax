import { EventEmitter } from "node:events";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  calls: [] as string[],
  fail: false,
  mismatch: false,
  model: "fixture/embed",
}));
vi.mock("node:http", () => ({
  request: (options: any, callback: any) => {
    h.calls.push(options.path);
    const request: any = new EventEmitter();
    request.destroy = vi.fn();
    request.end = () =>
      queueMicrotask(() => {
        const response: any = new EventEmitter();
        response.statusCode = h.fail ? 503 : 200;
        callback(response);
        response.emit(
          "data",
          Buffer.from(
            JSON.stringify(
              options.path === "/health"
                ? { model: h.model }
                : {
                    model: h.mismatch ? "wrong/model" : h.model,
                    dim: 2,
                    vectors: [[1, 0]],
                  },
            ),
          ),
        );
        response.emit("end");
      });
    return request;
  },
}));
beforeEach(() => {
  vi.resetModules();
  h.calls = [];
  h.fail = false;
  h.mismatch = false;
  vi.useFakeTimers({ toFake: ["Date"] });
});
afterEach(() => vi.useRealTimers());
const options = {
  mode: "gpu" as const,
  expectedModel: h.model,
  expectedDim: 2,
};
it("restricted cold MLX refuses before any HTTP request or readiness poll", async () => {
  const { mlxEmbedExisting } = await import(
    "../src/lib/workers/embeddings/mlx-client"
  );
  await expect(mlxEmbedExisting(["query"], options)).rejects.toThrow(
    "embedding_unavailable",
  );
  expect(h.calls).toEqual([]);
});
it("restricted warm MLX performs one embed, with no health poll, retry or normal fallback", async () => {
  const { mlxEmbed, mlxEmbedExisting, isMlxExistingReady } = await import(
    "../src/lib/workers/embeddings/mlx-client"
  );
  await mlxEmbed(["external warmup fixture"], options);
  expect(isMlxExistingReady(h.model)).toBe(true);
  h.calls = [];
  expect(await mlxEmbedExisting(["query"], options)).toHaveLength(1);
  expect(h.calls).toEqual(["/embed"]);
  h.fail = true;
  h.calls = [];
  await expect(mlxEmbedExisting(["query"], options)).rejects.toThrow(
    "embedding_unavailable",
  );
  expect(h.calls).toEqual(["/embed"]);
  h.calls = [];
  await expect(mlxEmbedExisting(["later"], options)).rejects.toThrow(
    "embedding_unavailable",
  );
  expect(h.calls).toEqual([]);
});
it("restricted idle readiness validates each response without reloading or polling, including clock rollback", async () => {
  const { mlxEmbed, mlxEmbedExisting } = await import(
    "../src/lib/workers/embeddings/mlx-client"
  );
  await mlxEmbed(["external warmup fixture"], options);
  h.calls = [];
  await expect(
    mlxEmbedExisting(["query"], { ...options, expectedModel: "other" }),
  ).rejects.toThrow("embedding_unavailable");
  expect(h.calls).toEqual([]);
  vi.setSystemTime(Date.now() + 30001);
  expect(await mlxEmbedExisting(["after idle"], options)).toHaveLength(1);
  vi.setSystemTime(Date.now() - 60001);
  expect(await mlxEmbedExisting(["clock rollback"], options)).toHaveLength(1);
  expect(h.calls).toEqual(["/embed", "/embed"]);
  h.mismatch = true;
  await expect(mlxEmbedExisting(["replaced backend"], options)).rejects.toThrow(
    "embedding_unavailable",
  );
  expect(h.calls).toEqual(["/embed", "/embed", "/embed"]);
  h.calls = [];
  await expect(mlxEmbedExisting(["revoked"], options)).rejects.toThrow(
    "embedding_unavailable",
  );
  expect(h.calls).toEqual([]);
});
it("restricted response must still match the selected model and dimensions", async () => {
  const { mlxEmbed, mlxEmbedExisting } = await import(
    "../src/lib/workers/embeddings/mlx-client"
  );
  await mlxEmbed(["external warmup fixture"], options);
  h.calls = [];
  h.mismatch = true;
  await expect(mlxEmbedExisting(["query"], options)).rejects.toThrow(
    "embedding_unavailable",
  );
  expect(h.calls).toEqual(["/embed"]);
});
