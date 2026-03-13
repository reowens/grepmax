const fs = require("node:fs");
const os = require("node:os");
const _path = require("node:path");
const http = require("node:http");
const { spawn } = require("node:child_process");

function readPayload() {
  try {
    const raw = fs.readFileSync(0, "utf-8");
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function isServerRunning(cwd) {
  // Read the global server registry (matches how osgrep serve registers)
  const registryPath = _path.join(os.homedir(), ".osgrep", "servers.json");
  try {
    const servers = JSON.parse(fs.readFileSync(registryPath, "utf-8"));
    const match = servers.find((s) => s.projectRoot === cwd);
    if (match && typeof match.pid === "number") {
      process.kill(match.pid, 0); // throws if not running
      return true;
    }
  } catch {}
  return false;
}

function isMlxRunning() {
  return new Promise((resolve) => {
    const req = http.get(
      { hostname: "127.0.0.1", port: 8100, path: "/health", timeout: 1000 },
      (res) => {
        res.resume();
        resolve(res.statusCode === 200);
      }
    );
    req.on("error", () => resolve(false));
    req.on("timeout", () => { req.destroy(); resolve(false); });
  });
}

function startMlxServer() {
  // Find the mlx-embed-server directory relative to plugin root
  const pluginRoot = __dirname.replace(/\/hooks$/, "");
  const osgrepRoot = _path.resolve(pluginRoot, "../..");
  const serverDir = _path.join(osgrepRoot, "mlx-embed-server");

  if (!fs.existsSync(_path.join(serverDir, "server.py"))) return;

  const logPath = "/tmp/mlx-embed-server.log";
  const out = fs.openSync(logPath, "a");

  const child = spawn("uv", ["run", "python", "server.py"], {
    cwd: serverDir,
    detached: true,
    stdio: ["ignore", out, out],
  });
  child.unref();
}

async function main() {
  const payload = readPayload();
  const cwd = payload.cwd || process.cwd();

  // Check if osgrep serve is running (read-only — MCP server owns daemon lifecycle)
  const daemonUp = isServerRunning(cwd);

  // Start MLX embed server if not running (set OSGREP_EMBED_MODE=cpu to skip)
  const embedMode = process.env.OSGREP_EMBED_MODE || "auto";
  if (embedMode !== "cpu") {
    const mlxUp = await isMlxRunning();
    if (!mlxUp) {
      startMlxServer();
    }
  }

  const status = daemonUp ? "running" : "starting via MCP";
  const response = {
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext:
        `osgrep serve ${status}; prefer \`osgrep "<complete question>"\` over grep (plain output is agent-friendly).`,
    },
  };
  process.stdout.write(JSON.stringify(response));
}

main();
