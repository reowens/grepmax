import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";

const PLUGIN_PATH = path.join(
  os.homedir(),
  ".config",
  "opencode",
  "plugin",
  "osgrep.ts",
);

// We embed the entire logic (Daemon management + Tool definition) into this string.
const PLUGIN_CONTENT = `
import { type Plugin, tool } from "@opencode-ai/plugin";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

// --- DAEMON HELPERS (Replicating your start.js/stop.js) ---

function startDaemon(cwd: string) {
  const logPath = "/tmp/osgrep.log";
  const out = fs.openSync(logPath, "a");
  
  // Spawn detached osgrep serve
  const child = spawn("osgrep", ["serve"], {
    cwd,
    detached: true,
    stdio: ["ignore", out, out],
  });
  child.unref();
}

function stopDaemon(cwd: string) {
  const lockPath = path.join(cwd, ".osgrep", "server.json");
  let killed = false;

  if (fs.existsSync(lockPath)) {
    try {
      const data = JSON.parse(fs.readFileSync(lockPath, "utf-8"));
      const pid = data?.pid;
      if (typeof pid === "number") {
        process.kill(pid, "SIGTERM");
        killed = true;
      }
    } catch {}
    try { fs.unlinkSync(lockPath); } catch {}
  }

  if (!killed) {
    // Best-effort fallback
    spawnSync("pkill", ["-f", "osgrep serve"], { stdio: "ignore" });
  }
}

// --- PLUGIN DEFINITION ---

export const OsgrepPlugin: Plugin = async (context) => {
  return {
    // 1. LIFECYCLE HOOKS
    event: async ({ event }) => {
      // OpenCode provides the project directory in the context, but event.cwd might be safer if available
      // Falling back to process.cwd() or context.directory
      const currentDir = context.directory || process.cwd();

      if (event.type === "session.created") {
        try {
          startDaemon(currentDir);
          // Optional: Notify user via toast that daemon is up
          // console.log("osgrep daemon started");
        } catch (err) {
          console.error("Failed to start osgrep daemon", err);
        }
      }

      if (event.type === "session.deleted" || event.type === "session.idle") {
        stopDaemon(currentDir);
      }
    },

    // 2. TOOL DEFINITION
    tool: {
      osgrep: tool({
        description: \`
---
name: osgrep
description: Semantic code search. The indexer (daemon) is ALREADY RUNNING.
allowed-tools: "Bash(osgrep:*), Read"
---
Commands:
- Search: osgrep search "auth logic" (Finds implementation concepts)
- Trace: osgrep trace "AuthService" (Finds callers/callees)
- Symbols: osgrep symbols "Auth"

## ⚠️ CRITICAL: Handling "Indexing" State
If any \`osgrep\` command returns a status indicating **"Indexing"**, **"Building"**, or **"Syncing"**:
1. **STOP** your current train of thought.
2. **INFORM** the user: "The semantic index is currently building. Search results will be incomplete."
3. **ASK**: "Do you want me to proceed with partial results, or wait for indexing to finish?"
   *(Do not assume you should proceed without confirmation).*

   
\`,
        args: {
          argv: tool.schema.array(tool.schema.string())
            .describe("Arguments for osgrep, e.g. ['search', 'user auth']")
        },
        async execute({ argv }) {
          // Use the plugin context's shell ($) for safe execution
          // We use the 'osgrep' command which communicates with the running daemon
          const result = await context.$\`osgrep \${argv}\`.text();
          return result.trim();
        },
      }),
    },
  };
};
`;

async function install() {
  try {
    fs.mkdirSync(path.dirname(PLUGIN_PATH), { recursive: true });
    fs.writeFileSync(PLUGIN_PATH, PLUGIN_CONTENT);
    console.log("✅ osgrep OpenCode plugin installed!");
    console.log(`   Location: ${PLUGIN_PATH}`);
    console.log("   Behavior: Automatically starts 'osgrep serve' on session start.");
  } catch (err) {
    console.error("❌ Installation failed:", err);
  }
}

async function uninstall() {
  try {
    if (fs.existsSync(PLUGIN_PATH)) {
      fs.unlinkSync(PLUGIN_PATH);
      console.log("✅ osgrep OpenCode plugin removed.");
    } else {
      console.log("⚠️  Plugin was not found.");
    }
  } catch (err) {
    console.error("❌ Uninstall failed:", err);
  }
}

export const installOpencode = new Command("install-opencode")
  .description("Install osgrep as an OpenCode plugin (Daemon + Tool)")
  .action(install);

export const uninstallOpencode = new Command("uninstall-opencode")
  .description("Remove the osgrep OpenCode plugin")
  .action(uninstall);