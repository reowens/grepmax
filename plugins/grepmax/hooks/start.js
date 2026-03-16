const fs = require("node:fs");
const _path = require("node:path");
const http = require("node:http");
const { spawn } = require("node:child_process");

function isServerRunning(port) {
  return new Promise((resolve) => {
    const req = http.get(
      { hostname: "127.0.0.1", port, path: "/health", timeout: 1000 },
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

function startPythonServer(scriptName, logName) {
  const pluginRoot = __dirname.replace(/\/hooks$/, "");
  const gmaxRoot = _path.resolve(pluginRoot, "../..");
  const serverDir = _path.join(gmaxRoot, "mlx-embed-server");

  if (!fs.existsSync(_path.join(serverDir, scriptName))) return;

  const logPath = `/tmp/${logName}.log`;
  const out = fs.openSync(logPath, "a");

  const child = spawn("uv", ["run", "python", scriptName], {
    cwd: serverDir,
    detached: true,
    stdio: ["ignore", out, out],
    env: { ...process.env, VIRTUAL_ENV: "", CONDA_DEFAULT_ENV: "" },
  });
  child.unref();
}

async function main() {
  const embedMode =
    process.env.GMAX_EMBED_MODE || process.env.OSGREP_EMBED_MODE || "auto";

  if (embedMode !== "cpu") {
    // Start MLX embed server (port 8100)
    if (!(await isServerRunning(8100))) {
      startPythonServer("server.py", "mlx-embed-server");
    }

    // Start LLM summarizer server (port 8101)
    if (!(await isServerRunning(8101))) {
      startPythonServer("summarizer.py", "mlx-summarizer");
    }
  }

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
