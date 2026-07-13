import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  httpGet: vi.fn(),
}));

vi.mock("node:http", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:http")>()),
  get: h.httpGet,
}));

import { MlxServerManager } from "../src/lib/daemon/mlx-server-manager";

function respond(statusCode: number, body: string) {
  h.httpGet.mockImplementation(
    (_options: unknown, callback: (response: EventEmitter) => void) => {
      const request = new EventEmitter() as EventEmitter & {
        destroy: ReturnType<typeof vi.fn>;
      };
      request.destroy = vi.fn();
      queueMicrotask(() => {
        const response = new EventEmitter() as EventEmitter & {
          statusCode: number;
        };
        response.statusCode = statusCode;
        callback(response);
        response.emit("data", Buffer.from(body));
        response.emit("end");
      });
      return request;
    },
  );
}

describe("MLX manager health protocol", () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  it("adopts only a valid matching-model response", async () => {
    respond(
      200,
      JSON.stringify({ status: "ok", model: "model-a", owner: "external" }),
    );
    const manager = new MlxServerManager({ getShuttingDown: () => false });

    await manager.ensureMlxServer("model-a");

    expect(manager.getStatus()).toMatchObject({
      state: "adopted-ready",
      model: "model-a",
    });
  });

  it("rejects a valid response for a different model", async () => {
    respond(200, JSON.stringify({ status: "ok", model: "model-b" }));
    const manager = new MlxServerManager({ getShuttingDown: () => false });

    await manager.ensureMlxServer("model-a");

    expect(manager.getStatus()).toMatchObject({
      state: "failed",
      error: expect.stringContaining("model-b"),
    });
  });

  it("rejects malformed HTTP 200 health responses", async () => {
    respond(200, JSON.stringify({ status: "ok" }));
    const manager = new MlxServerManager({
      getShuttingDown: () => false,
      getPortPid: () => 777,
    });

    await manager.ensureMlxServer("model-a");

    expect(manager.getStatus()).toMatchObject({
      state: "failed",
      error: expect.stringContaining("unrecognized PID 777"),
    });
  });
});
