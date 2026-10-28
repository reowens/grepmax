import { expect, it, vi } from "vitest";
import type { VectorDB } from "../src/lib/store/vector-db";
import type { WorkerPool } from "../src/lib/workers/pool";

const mocks = vi.hoisted(() => ({
  get: vi.fn(() => {
    throw Error("live pool forbidden");
  }),
}));
vi.mock("../src/lib/workers/pool", () => ({ getWorkerPool: mocks.get }));

import { Searcher } from "../src/lib/search/searcher";

it("accepts a narrow embedding dependency without constructing the live pool", async () => {
  const encodeQuery = vi
    .fn()
    .mockRejectedValue(new Error("owned synthetic runtime failure"));
  const dependencies: Pick<WorkerPool, "encodeQuery" | "rerank"> = {
    encodeQuery,
    rerank: vi.fn(),
  };
  const searcher = new Searcher({} as VectorDB, dependencies);
  await expect(searcher.search("synthetic")).rejects.toThrow(
    "owned synthetic runtime failure",
  );
  expect(encodeQuery).toHaveBeenCalledWith("synthetic", undefined);
  expect(mocks.get).not.toHaveBeenCalled();
});
it("checks cancellation before invoking the supplied embedding runtime", async () => {
  const encodeQuery = vi.fn();
  const searcher = new Searcher({} as VectorDB, {
    encodeQuery,
    rerank: vi.fn(),
  });
  await expect(
    searcher.search(
      "synthetic",
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      AbortSignal.abort(),
    ),
  ).rejects.toThrow("Aborted");
  expect(encodeQuery).not.toHaveBeenCalled();
});
