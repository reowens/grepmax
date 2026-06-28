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

// Inline fallback so SessionStart context is never empty if the installed
// gmax package can't be resolved (e.g. gmax not yet on PATH). The canonical
// copy lives in src/lib/help/agent-cheatsheet.ts; getSessionStartHint() prefers
// it and only uses this if the require fails. Keep the two in sync.
const FALLBACK_SESSION_START_HINT = `gmax ready. Add --agent to any command for compact output (~89% fewer tokens).

Find:
  gmax "topic"                       semantic search
  gmax similar <symbol>              similar code

Understand:
  gmax peek <symbol>                 signature + callers + callees + tests
  gmax extract <symbol>              full body + tests
  gmax trace <symbol>                call graph (--inbound = callers + snippets)
  gmax test <symbol>                 tests for symbol
  gmax impact <symbol>               blast radius
  gmax related <file>                file deps + dependents

Survey:
  gmax project                       codebase overview (langs, structure, key symbols)
  gmax skeleton <file>               file structure (file path, NOT a directory)
  gmax context "topic-or-path" --budget 4000 topic summary or deterministic file/dir context
  gmax log <path-or-symbol>          git commits (replaces recent/diff)
  gmax status                        indexed projects

Scope flags: --root <name|path>, --in <subpath>, --exclude <subpath>.
Roles in results: [DEFI] [ORCH] [IMPL] [DOCS].
Recovery: "not added yet" → gmax add; stale → gmax index; broken → gmax doctor --fix.`;

// Load the canonical cheatsheet from the installed gmax package (single source
// of truth shared with `gmax help-agent`). Tries the npm-resolved package root
// first, then the dev checkout, then the inline fallback above.
function getSessionStartHint() {
  const roots = [];
  try {
    const gmaxPath = execFileSync("which", ["gmax"], {
      encoding: "utf-8",
    }).trim();
    if (gmaxPath) {
      const realPath = fs.realpathSync(gmaxPath);
      roots.push(_path.resolve(_path.dirname(realPath), ".."));
    }
  } catch {}
  // dev mode — plugin lives at <repo>/plugins/grepmax/hooks
  roots.push(_path.resolve(__dirname, "../../.."));

  for (const root of roots) {
    try {
      const mod = require(
        _path.join(root, "dist", "lib", "help", "agent-cheatsheet.js"),
      );
      if (mod && typeof mod.SESSION_START_HINT === "string") {
        return mod.SESSION_START_HINT;
      }
    } catch {}
  }
  return FALLBACK_SESSION_START_HINT;
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
      HF_TOKEN_PATH:
        process.env.HF_TOKEN_PATH ||
        _path.join(
          require("node:os").homedir(),
          ".cache",
          "huggingface",
          "token",
        ),
    },
  });
  child.unref();
}

// --- Crash counter (Item 14) ---
const CRASH_FILE = _path.join(
  require("node:os").homedir(),
  ".gmax",
  "mlx-embed-crashes.json",
);
const MAX_CRASHES = 3;
const CRASH_WINDOW_MS = 10 * 60 * 1000; // 10 minutes

function readCrashCount() {
  try {
    const data = JSON.parse(fs.readFileSync(CRASH_FILE, "utf-8"));
    if (
      data.lastCrash &&
      Date.now() - new Date(data.lastCrash).getTime() > CRASH_WINDOW_MS
    ) {
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
  try {
    fs.unlinkSync(CRASH_FILE);
  } catch {}
}

function isProjectRegistered() {
  try {
    const projectsPath = _path.join(
      require("node:os").homedir(),
      ".gmax",
      "projects.json",
    );
    const projects = JSON.parse(
      require("node:fs").readFileSync(projectsPath, "utf-8"),
    );
    const cwd = process.cwd();
    return projects.some((p) => cwd.startsWith(p.root));
  } catch {
    return false;
  }
}

function startWatcher() {
  if (!isProjectRegistered()) return;
  try {
    execFileSync("gmax", ["watch", "--daemon", "-b"], {
      timeout: 5000,
      stdio: "ignore",
    });
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
        startPythonServer(
          serverDir,
          "server.py",
          "mlx-embed-server",
          "gmax-embed",
        );

        // Fire-and-forget health verification (Item 13)
        (async () => {
          const maxAttempts = 5;
          const delayMs = 2000;
          for (let i = 0; i < maxAttempts; i++) {
            await new Promise((r) => setTimeout(r, delayMs));
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
    if (
      process.env.GMAX_SUMMARIZER === "1" &&
      serverDir &&
      !(await isServerRunning(8101))
    ) {
      startPythonServer(
        serverDir,
        "summarizer.py",
        "mlx-summarizer",
        "gmax-summarizer",
      );
    }
  }

  // Start a file watcher for the current project (30-min idle timeout)
  startWatcher();

  const response = {
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: getSessionStartHint(),
    },
  };
  process.stdout.write(JSON.stringify(response));
}

main();
