import * as http from "node:http";
import type { Socket } from "node:net";
import { expect, it, vi } from "vitest";

it("avoids a closed idle socket without marking the healthy local backend unavailable", async () => {
  const server = http.createServer((_req, res) => {
    res.end(JSON.stringify({ status: "ok", model: "fixture" }));
  });
  let currentSocket: Socket | undefined;
  let connections = 0;
  server.on("connection", (socket) => {
    currentSocket = socket;
    connections++;
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing port");
  const agent = new http.Agent({ keepAlive: true });
  const closeIdle = () => currentSocket?.destroy();
  const control = () =>
    new Promise<{ ok: boolean; reused: boolean; error?: string }>((resolve) => {
      const req = http.request(
        { hostname: "127.0.0.1", port: address.port, agent },
        (res) => {
          res.resume();
          res.on("end", () => resolve({ ok: true, reused: req.reusedSocket }));
        },
      );
      req.on("error", (error: NodeJS.ErrnoException) =>
        resolve({ ok: false, reused: req.reusedSocket, error: error.code }),
      );
      req.end();
    });
  try {
    // Close the server side after the client pools it, before the next request
    // can receive its FIN. This reproduces the keep-alive boundary race.
    agent.once("free", closeIdle);
    expect(await control()).toMatchObject({ ok: true, reused: false });
    expect(await control()).toMatchObject({
      ok: false,
      reused: true,
      error: "ECONNRESET",
    });
    vi.stubEnv("MLX_EMBED_PORT", String(address.port));
    vi.resetModules();
    const { requestMlxJSON } = await import(
      "../src/lib/workers/embeddings/mlx-client"
    );
    const before = connections;
    http.globalAgent.once("free", closeIdle);
    expect(await requestMlxJSON("/health")).toMatchObject({
      ok: true,
      data: { model: "fixture" },
    });
    expect(await requestMlxJSON("/health")).toMatchObject({
      ok: true,
      data: { model: "fixture" },
    });
    expect(connections - before).toBe(2);
  } finally {
    http.globalAgent.removeListener("free", closeIdle);
    agent.destroy();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    vi.unstubAllEnvs();
  }
});
