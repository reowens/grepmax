const fs = require("node:fs");
const _path = require("node:path");
const { execFileSync } = require("node:child_process");

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

function main() {
  // The daemon owns embed-server configuration and lifecycle.
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
