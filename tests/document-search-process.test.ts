import { EventEmitter } from "node:events";
import { expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  encode: vi.fn(),
  send: vi.fn(),
  debug: vi.fn(),
  exit: vi.fn(),
}));
vi.mock("node:process", () => {
  const process: any = new EventEmitter();
  process.env = {};
  process.memoryUsage = () => ({ rss: 100 });
  process.send = h.send;
  process.exit = h.exit;
  return { default: process };
});
vi.mock("../src/lib/utils/logger", () => ({
  debug: h.debug,
  installTimestampedOutput: vi.fn(),
  LOG_TIMESTAMPS_ENV: "GMAX_LOG_TIMESTAMPS",
}));
vi.mock("../src/lib/workers/worker", () => ({
  default: vi.fn(),
  encodeQuery: h.encode,
  isExistingQueryReady: () => true,
  rerank: vi.fn(),
}));

import process from "node:process";
import "../src/lib/workers/process-child";

it("restricted child forwards execution policy and returns warm readiness without changing the query", async () => {
  h.encode.mockResolvedValueOnce({ dense: [1], colbert: [], colbertDim: 0 });
  const payload = {
    text: "PRIVATE_QUERY_CANARY",
    existingOnly: true,
    generation: "fixture-fingerprint",
  };
  process.emit("message", { id: 1, method: "encodeQuery", payload });
  await vi.waitFor(() =>
    expect(h.send).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 1,
        queryReady: true,
        result: { dense: [1], colbert: [], colbertDim: 0 },
      }),
    ),
  );
  expect(h.encode).toHaveBeenCalledWith(payload);
  expect(JSON.stringify(h.debug.mock.calls)).not.toContain(
    "PRIVATE_QUERY_CANARY",
  );
});
it.each([undefined, "host_pressure", "embedding_mismatch"])(
  "restricted child redacts arbitrary errors while preserving safe code %s",
  async (code) => {
    h.encode.mockRejectedValueOnce(
      Object.assign(new Error("PRIVATE_QUERY_CANARY"), { code }),
    );
    const id = h.send.mock.calls.length + 10;
    process.emit("message", {
      id,
      method: "encodeQuery",
      payload: {
        text: "PRIVATE_QUERY_CANARY",
        existingOnly: true,
        generation: "fixture",
      },
    });
    await vi.waitFor(() =>
      expect(h.send).toHaveBeenCalledWith(
        expect.objectContaining({
          id,
          error: code ?? "embedding_unavailable",
          code: code ?? "embedding_unavailable",
        }),
      ),
    );
    expect(JSON.stringify(h.send.mock.calls)).not.toContain(
      "PRIVATE_QUERY_CANARY",
    );
    expect(JSON.stringify(h.debug.mock.calls)).not.toContain(
      "PRIVATE_QUERY_CANARY",
    );
  },
);
it("a fatal error during restricted inference cannot retain query text in diagnostics", async () => {
  let finish: any;
  h.encode.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    process.emit("message", {
      id: 100,
      method: "encodeQuery",
      payload: {
        text: "PRIVATE_QUERY_CANARY",
        existingOnly: true,
        generation: "fixture",
      },
    });
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    process.emit("uncaughtException", new Error("PRIVATE_QUERY_CANARY"));
    expect(JSON.stringify(error.mock.calls)).not.toContain(
      "PRIVATE_QUERY_CANARY",
    );
    expect(h.exit).toHaveBeenCalledOnce();
    finish({ dense: [1], colbert: [], colbertDim: 0 });
    await vi.waitFor(() =>
      expect(h.send).toHaveBeenCalledWith(expect.objectContaining({ id: 100 })),
    );
  } finally {
    error.mockRestore();
  }
});
