const fs = require("node:fs");
const _path = require("node:path");
const http = require("node:http");
const { spawn } = require("node:child_process");

function isMlxRunning() {
  return new Promise((resolve) => {
    const req = http.get(
      { hostname: "127.0.0.1", port: 8100, path: "/health", timeout: 1000 },
      (res) => {
        res.resume();
        resolve(res.statusCode === 200);
      },
    );
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
  });
}

function startMlxServer() {
  const pluginRoot = __dirname.replace(/\/hooks$/, "");
  const gmaxRoot = _path.resolve(pluginRoot, "../..");
  const serverDir = _path.join(gmaxRoot, "mlx-embed-server");

  if (!fs.existsSync(_path.join(serverDir, "server.py"))) return;

  const logPath = "/tmp/mlx-embed-server.log";
  const out = fs.openSync(logPath, "a");

  const child = spawn("uv", ["run", "python", "server.py"], {
    cwd: serverDir,
    detached: true,
    stdio: ["ignore", out, out],
    env: { ...process.env, VIRTUAL_ENV: "", CONDA_DEFAULT_ENV: "" },
  });
  child.unref();
}

async function main() {
  // Start MLX embed server if not running (set GMAX_EMBED_MODE=cpu to skip)
  const embedMode =
    process.env.GMAX_EMBED_MODE || process.env.OSGREP_EMBED_MODE || "auto";
  if (embedMode !== "cpu") {
    const mlxUp = await isMlxRunning();
    if (!mlxUp) {
      startMlxServer();
    }
  }

  // MCP server handles indexing and search directly — no daemon needed
  const response = {
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext:
        'gmax MCP ready; prefer `gmax "<complete question>"` over grep (plain output is agent-friendly).',
    },
  };
  process.stdout.write(JSON.stringify(response));
}

main();
