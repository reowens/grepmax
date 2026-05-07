const fs = require("node:fs");
const _path = require("node:path");
const http = require("node:http");
const { spawn, execFileSync } = require("node:child_process");

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

function findMlxServerDir() {
  // Try to find mlx-embed-server relative to the gmax binary (npm install location)
  try {
    const gmaxPath = execFileSync("which gmax", {
      encoding: "utf-8",
    }).trim();
    // gmax binary is a symlink in .bin/ → resolve to package root
    const realPath = fs.realpathSync(gmaxPath);
    const pkgRoot = _path.resolve(_path.dirname(realPath), "..");
    const serverDir = _path.join(pkgRoot, "mlx-embed-server");
    if (fs.existsSync(_path.join(serverDir, "server.py"))) return serverDir;
  } catch {}

  // Fallback: dev mode — relative to plugin root
  const pluginRoot = __dirname.replace(/\/hooks$/, "");
  const devRoot = _path.resolve(pluginRoot, "../..");
  const devDir = _path.join(devRoot, "mlx-embed-server");
  if (fs.existsSync(_path.join(devDir, "server.py"))) return devDir;

  return null;
}

function startPythonServer(serverDir, scriptName, logName, processName) {
  if (!serverDir) return;

  const logDir = _path.join(require("node:os").homedir(), ".gmax", "logs");
  fs.mkdirSync(logDir, { recursive: true });
  const logPath = _path.join(logDir, `${logName}.log`);

  // Rotate if > 5MB (same threshold as watch.ts)
  try {
    const stat = fs.statSync(logPath);
    if (stat.size > 5 * 1024 * 1024) {
      fs.renameSync(logPath, `${logPath}.prev`);
    }
  } catch {}

  const out = fs.openSync(logPath, "a");

  const child = spawn("uv", ["run", "python", scriptName], {
    cwd: serverDir,
    detached: true,
    stdio: ["ignore", out, out],
    env: {
      ...process.env,
      VIRTUAL_ENV: "",
      CONDA_DEFAULT_ENV: "",
      GMAX_PROCESS_NAME: processName || logName,
      HF_TOKEN_PATH: process.env.HF_TOKEN_PATH || _path.join(require("node:os").homedir(), ".cache", "huggingface", "token"),
    },
  });
  child.unref();
}

// --- Crash counter (Item 14) ---
const CRASH_FILE = _path.join(require("node:os").homedir(), ".gmax", "mlx-embed-crashes.json");
const MAX_CRASHES = 3;
const CRASH_WINDOW_MS = 10 * 60 * 1000; // 10 minutes

function readCrashCount() {
  try {
    const data = JSON.parse(fs.readFileSync(CRASH_FILE, "utf-8"));
    if (data.lastCrash && Date.now() - new Date(data.lastCrash).getTime() > CRASH_WINDOW_MS) {
      return { count: 0, lastCrash: null }; // Window expired, reset
    }
    return { count: data.count || 0, lastCrash: data.lastCrash };
  } catch {
    return { count: 0, lastCrash: null };
  }
}

function writeCrashCount(count, lastCrash) {
  try {
    fs.writeFileSync(CRASH_FILE, JSON.stringify({ count, lastCrash }));
  } catch {}
}

function resetCrashCount() {
  try { fs.unlinkSync(CRASH_FILE); } catch {}
}

function isProjectRegistered() {
  try {
    const projectsPath = _path.join(
      require("node:os").homedir(),
      ".gmax",
      "projects.json",
    );
    const projects = JSON.parse(require("node:fs").readFileSync(projectsPath, "utf-8"));
    const cwd = process.cwd();
    return projects.some((p) => cwd.startsWith(p.root));
  } catch {
    return false;
  }
}

function startWatcher() {
  if (!isProjectRegistered()) return;
  try {
    execFileSync("gmax", ["watch", "--daemon", "-b"], { timeout: 5000, stdio: "ignore" });
  } catch {
    // Fallback to per-project mode (older gmax without --daemon)
    try {
      execFileSync("gmax", ["watch", "-b"], { timeout: 5000, stdio: "ignore" });
    } catch {
      // Watcher may already be running or gmax not in PATH — ignore
    }
  }
}

async function main() {
  const embedMode = process.env.GMAX_EMBED_MODE || "auto";

  if (embedMode !== "cpu") {
    const serverDir = findMlxServerDir();

    // Start MLX embed server (port 8100)
    const embedRunning = await isServerRunning(8100);
    if (serverDir && !embedRunning) {
      const crashes = readCrashCount();
      if (crashes.count < MAX_CRASHES) {
        startPythonServer(serverDir, "server.py", "mlx-embed-server", "gmax-embed");

        // Fire-and-forget health verification (Item 13)
        (async () => {
          const maxAttempts = 5;
          const delayMs = 2000;
          for (let i = 0; i < maxAttempts; i++) {
            await new Promise(r => setTimeout(r, delayMs));
            if (await isServerRunning(8100)) {
              resetCrashCount();
              return;
            }
          }
          // Server didn't start after 10s — record crash
          const c = readCrashCount();
          writeCrashCount(c.count + 1, new Date().toISOString());
        })();
      }
    } else if (embedRunning) {
      resetCrashCount();
    }

    // Start LLM summarizer server (port 8101) — opt-in only
    if (process.env.GMAX_SUMMARIZER === "1" && serverDir && !(await isServerRunning(8101))) {
      startPythonServer(serverDir, "summarizer.py", "mlx-summarizer", "gmax-summarizer");
    }
  }

  // Start a file watcher for the current project (30-min idle timeout)
  startWatcher();

  const response = {
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext:
        'gmax ready. Use Bash(gmax "query" --agent) for search (one line per result, 89% fewer tokens). Bash(gmax extract <symbol>) for full function body. Bash(gmax peek <symbol>) for quick overview (sig+callers+callees). Bash(gmax trace <symbol>) for call graphs. Bash(gmax skeleton <path>) for structure. Bash(gmax diff [ref]) for git changes. Bash(gmax test <symbol>) for test coverage. Bash(gmax impact <symbol>) for blast radius. Bash(gmax similar <symbol>) for similar code. Bash(gmax context "topic" --budget 4000) for topic summary. Bash(gmax status) to check indexed projects. Role tags in results: [DEFI]=definition, [ORCH]=orchestration, [IMPL]=implementation, [DOCS]=docs. --agent flag works on search, trace, symbols, related, recent, status, project, extract, peek, diff, test, impact, similar. If search says "not added yet", run Bash(gmax add). If results look stale, run Bash(gmax index) to repair.',
    },
  };
  process.stdout.write(JSON.stringify(response));
}

main();
