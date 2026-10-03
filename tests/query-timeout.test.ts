import { describe, expect, it, vi } from "vitest";
import {
  QueryTimeoutError,
  streamQueryRows,
  withQueryTimeout,
} from "../src/lib/utils/query-timeout";

describe("withQueryTimeout", () => {
  it("resolves with the promise value when it settles in time", async () => {
    await expect(
      withQueryTimeout(Promise.resolve(42), "fast query", 1000),
    ).resolves.toBe(42);
  });

  it("propagates the promise rejection when it settles in time", async () => {
    await expect(
      withQueryTimeout(Promise.reject(new Error("boom")), "failing", 1000),
    ).rejects.toThrow("boom");
  });

  it("rejects with QueryTimeoutError when the promise never settles", async () => {
    const never = new Promise<void>(() => {});
    const err = await withQueryTimeout(never, "hung LIKE scan", 20).catch(
      (e) => e,
    );
    expect(err).toBeInstanceOf(QueryTimeoutError);
    expect(err.message).toContain("hung LIKE scan");
    expect(err.message).toContain("20ms");
  });

  it("does not keep the process alive after the promise resolves", async () => {
    // The timer must be cleared on settle; a leaked referenced timer would
    // delay process exit by the full timeout in every CLI command.
    const before = Date.now();
    await withQueryTimeout(Promise.resolve("ok"), "quick", 60_000);
    expect(Date.now() - before).toBeLessThan(1000);
  });
});

describe("streamQueryRows", () => {
  it("passes native bounds and closes the iterator on early termination", async () => {
    const closed = vi.fn();
    const execute = vi.fn(async function* () {
      try {
        yield { toArray: () => [{ path: "a" }, { path: "b" }] };
        throw new Error("consumer should have stopped");
      } finally {
        closed();
      }
    });
    for await (const row of streamQueryRows({ execute }, "bounded", 500)) {
      expect(row.path).toBe("a");
      break;
    }
    await Promise.resolve();
    expect(execute).toHaveBeenCalledWith({
      timeoutMs: 500,
      maxBatchLength: 512,
    });
    expect(closed).toHaveBeenCalledOnce();
  });

  it("enforces an overall deadline when a batch never arrives", async () => {
    const close = vi.fn(async () => ({
      done: true as const,
      value: undefined,
    }));
    const execute = () => ({
      next: () => new Promise<never>(() => {}),
      return: close,
    });
    await expect(
      (async () => {
        for await (const _row of streamQueryRows(
          { execute },
          "stuck stream",
          20,
        )) {
        }
      })(),
    ).rejects.toBeInstanceOf(QueryTimeoutError);
    expect(close).toHaveBeenCalledOnce();
  });
});
