import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("node:http", async (original) => ({
  ...(await original<typeof import("node:http")>()),
  request: h.request,
}));

import { requestMlxJSON } from "../src/lib/workers/embeddings/mlx-client";

function response(status = 200, raw = "{}", event = "end") {
  const req = new EventEmitter() as EventEmitter & {
    end: ReturnType<typeof vi.fn>;
    destroy: ReturnType<typeof vi.fn>;
  };
  req.destroy = vi.fn();
  req.end = vi.fn(() =>
    queueMicrotask(() => {
      const res = Object.assign(new EventEmitter(), { statusCode: status });
      h.request.mock.calls[h.request.mock.calls.length - 1]?.[1](res);
      res.emit("data", Buffer.from(raw));
      if (event) res.emit(event);
    }),
  );
  h.request.mockReturnValue(req);
  return req;
}

afterEach(() => {
  vi.useRealTimers();
  h.request.mockReset();
});

describe("MLX HTTP diagnostics", () => {
  it.each([
    [503, "busy", false],
    [429, "rate limited", false],
    [400, "bad input", true],
    [200, "not JSON", true],
    [200, '{"vectors":[],"model":"test","dim":2}', true],
  ])(
    "classifies embedding response %s (%s) for retry policy",
    async (status, raw, deterministic) => {
      vi.resetModules();
      const { mlxEmbed } = await import(
        "../src/lib/workers/embeddings/mlx-client"
      );
      h.request.mockImplementation((options, callback) => {
        const req = new EventEmitter() as EventEmitter & {
          end: () => void;
          destroy: () => void;
        };
        req.destroy = vi.fn();
        req.end = () =>
          queueMicrotask(() => {
            const health = options.path === "/health";
            const res = Object.assign(new EventEmitter(), {
              statusCode: health ? 200 : status,
            });
            callback(res);
            res.emit("data", Buffer.from(health ? '{"model":"test"}' : raw));
            res.emit("end");
          });
        return req;
      });
      const pending = mlxEmbed(["text"], {
        mode: "gpu",
        expectedModel: "test",
        expectedDim: 2,
      });
      if (deterministic)
        await expect(pending).rejects.toThrow("protocol failure");
      else await expect(pending).resolves.toBeNull();
    },
  );
  it("retains HTTP status and bounded response detail", async () => {
    response(503, "busy".repeat(300));
    const result = await requestMlxJSON("/embed", { texts: ["text"] });
    expect(result).toMatchObject({ ok: false, category: "http", status: 503 });
    expect(result.detail).toHaveLength(512);
    expect(result.ms).toBeGreaterThanOrEqual(0);
  });
  it("distinguishes malformed JSON from an HTTP error", async () => {
    response(200, "not json");
    expect(await requestMlxJSON("/embed", {})).toMatchObject({
      category: "protocol",
      status: 200,
      detail: "invalid JSON",
    });
  });
  it("reports transport resets", async () => {
    const req = response();
    req.end.mockImplementation(() =>
      queueMicrotask(() => req.emit("error", new Error("ECONNRESET"))),
    );
    expect(await requestMlxJSON("/embed", {})).toMatchObject({
      category: "transport",
      detail: "ECONNRESET",
    });
  });
  it("bounds a stalled response with a hard deadline", async () => {
    vi.useFakeTimers();
    const req = response(200, "{", "");
    const pending = requestMlxJSON("/embed", {});
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await pending).toMatchObject({ category: "timeout" });
    expect(req.destroy).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("settles an aborted body without waiting out the deadline", async () => {
    response(200, "{", "aborted");
    expect(await requestMlxJSON("/embed", {})).toMatchObject({
      category: "transport",
      detail: "response aborted",
    });
  });
  it("rejects oversized responses without parsing them", async () => {
    const req = response(200, "x".repeat(16 * 1024 * 1024 + 1));
    expect(await requestMlxJSON("/embed", {})).toMatchObject({
      category: "protocol",
      detail: "response exceeds 16MiB",
    });
    expect(req.destroy).toHaveBeenCalledOnce();
  });
});
