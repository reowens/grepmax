import { spawnSync } from "node:child_process";
import * as path from "node:path";
import { expect, it } from "vitest";

it("avoids a closed idle socket without marking the healthy local backend unavailable", () => {
  // Use native Node I/O so runner interception cannot turn the stale-socket
  // control into a successful new connection. The child owns only an ephemeral
  // loopback server and imports the actual client with no backend/model startup.
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      path.join(__dirname, "fixtures/mlx-http-connection.cjs"),
    ],
    { encoding: "utf8", timeout: 10000 },
  );
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain(
    "PASS_NATIVE_IDLE_SOCKET_CONTROL_AND_MLX_CLIENT",
  );
});
