const http = require("node:http");
const assert = require("node:assert/strict");
const path = require("node:path");
const server = http.createServer((_req, res) => {
  res.end(JSON.stringify({ status: "ok", model: "fixture" }));
});
let socket;
let connections = 0;
server.on("connection", (current) => {
  socket = current;
  connections++;
});
const agent = new http.Agent({ keepAlive: true });
(async () => {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const control = (closePeer = false) =>
    new Promise((resolve) => {
      const req = http.request(
        { hostname: "127.0.0.1", port, agent },
        (res) => {
          res.resume();
          res.on("end", () => resolve({ ok: true, reused: req.reusedSocket }));
        },
      );
      req.on("socket", () => {
        if (closePeer) socket.destroy();
      });
      req.on("error", (error) =>
        resolve({ ok: false, reused: req.reusedSocket, error: error.code }),
      );
      req.end();
    });
  // Wait for pooling, then close the peer as the reused socket is assigned,
  // before its request is written. The boundary is explicit rather than timed.
  const pooled = new Promise((resolve) => agent.once("free", resolve));
  assert.deepEqual(await control(), { ok: true, reused: false });
  await pooled;
  assert.deepEqual(await control(true), {
    ok: false,
    reused: true,
    error: "ECONNRESET",
  });
  process.env.MLX_EMBED_PORT = String(port);
  require("tsx/cjs");
  const { requestMlxJSON } = require(
    path.join(__dirname, "../../src/lib/workers/embeddings/mlx-client.ts"),
  );
  const before = connections;
  const first = await requestMlxJSON("/health");
  const second = await requestMlxJSON("/health");
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(first.data.model, "fixture");
  assert.equal(second.data.model, "fixture");
  assert.equal(connections - before, 2);
  console.log("PASS_NATIVE_IDLE_SOCKET_CONTROL_AND_MLX_CLIENT");
})()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    agent.destroy();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
