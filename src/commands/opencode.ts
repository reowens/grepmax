import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";

const TOOL_PATH = path.join(
  os.homedir(),
  ".config",
  "opencode",
  "tool",
  "gmax.ts",
);
const PLUGIN_PATH = path.join(
  os.homedir(),
  ".config",
  "opencode",
  "plugins",
  "gmax.ts",
);
const LEGACY_PLUGIN_PATH = path.join(
  os.homedir(),
  ".config",
  "opencode",
  "plugin",
  "gmax.ts",
);
const CONFIG_PATH = path.join(
  os.homedir(),
  ".config",
  "opencode",
  "opencode.json",
);

function resolveGmaxBin(): string {
  try {
    return execSync("which gmax", { encoding: "utf-8" }).trim();
  } catch {
    // Fall back to the path of the current process entry point
    const binDir = path.dirname(process.argv[1]);
    const candidate = path.join(binDir, "gmax");
    if (fs.existsSync(candidate)) return candidate;
    return "gmax";
  }
}

function buildShimContent(gmaxBin: string) {
  return `
import { tool } from "@opencode-ai/plugin";

const SKILL = \`
---
name: gmax
description: Semantic code search. Use alongside grep - grep for exact strings, gmax for concepts.
---

## When to use what

- **Know the exact string/symbol?** → grep/ripgrep (fastest)
- **Know the file already?** → Read tool directly
- **Searching by concept/behavior?** → gmax "query" --agent (semantic search)
- **Need full function body?** → gmax extract <symbol> (complete source)
- **Quick symbol overview?** → gmax peek <symbol> (signature + callers + callees)
- **Need file structure?** → gmax skeleton <path>
- **Need call flow?** → gmax trace <symbol>

## Primary command

Use --agent for compact, token-efficient output (one line per result):

gmax "where do we handle authentication" --agent
gmax "database connection pooling" --role ORCHESTRATION --agent -m 5
gmax "error handling" --lang ts --exclude tests/ --agent

Output: file:line symbol [ROLE] — signature_hint

All search flags: --agent -m <n> --per-file <n> --root <dir> --file <name> --exclude <prefix> --lang <ext> --role <role> --symbol --imports --name <regex> -C <n> --skeleton --explain --context-for-llm --budget <tokens>

## Commands

### Core
gmax "query" --agent              # semantic search (compact output)
gmax extract <symbol>             # full function body with line numbers
gmax peek <symbol>                # signature + callers + callees
gmax trace <symbol> -d 2          # call graph (multi-hop)
gmax skeleton <path>              # file structure (signatures only)
gmax symbols --agent              # list all indexed symbols

### Analysis
gmax diff [ref] --agent           # search scoped to git changes
gmax test <symbol> --agent        # find tests via reverse call graph
gmax impact <symbol> --agent      # dependents + affected tests
gmax similar <symbol> --agent     # vector-to-vector similarity
gmax context "topic" --budget 4k  # token-budgeted topic summary

### Project
gmax project --agent              # languages, structure, key symbols
gmax related <file> --agent       # dependencies + dependents
gmax recent --agent               # recently modified files
gmax status --agent               # all indexed projects

### Management
gmax add                          # add + index current directory
gmax index                        # reindex current project
gmax doctor --fix                 # health check + auto-repair

## Tips

- Be specific. "auth" is vague. "where does the server validate JWT tokens" is specific.
- Use --role ORCHESTRATION to skip type definitions and find actual logic.
- Use --symbol when the query is a function/class name — gets search + trace in one shot.
- Don't search for exact strings — use grep for that. gmax finds concepts.
- If search returns nothing, run: gmax add
\`;

const GMAX_BIN = "${gmaxBin}";

export default tool({
  description: SKILL,
  args: {
    argv: tool.schema.array(tool.schema.string())
      .describe("Arguments for gmax, e.g. ['search', 'user auth', '--agent']")
  },
  async execute({ argv }) {
    try {
      // @ts-ignore
      const out = await Bun.spawn([GMAX_BIN, ...argv], { stdout: "pipe" }).stdout;
      const text = await new Response(out).text();
      if (text.includes("Indexing") || text.includes("Building") || text.includes("Syncing")) {
        return \`WARN: The index is currently updating.

Output so far:
\${text.trim()}

Please wait for indexing to complete before searching.\`;
      }
      return text.trim();
    } catch (err) {
       return \`Error running gmax: \${err}\`;
    }
  },
})`;
}

function buildPluginContent(gmaxBin: string) {
  return `import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const GMAX_BIN = "${gmaxBin}";

function isProjectRegistered() {
  try {
    const projectsPath = join(homedir(), ".gmax", "projects.json");
    const projects = JSON.parse(readFileSync(projectsPath, "utf-8"));
    const cwd = process.cwd();
    return projects.some((p) => cwd.startsWith(p.root));
  } catch {
    return false;
  }
}

export const GmaxPlugin = async () => {
  // Start daemon on session creation if project is indexed
  if (isProjectRegistered()) {
    try {
      execFileSync(GMAX_BIN, ["watch", "--daemon", "-b"], {
        timeout: 5000,
        stdio: "ignore",
      });
    } catch {}
  }

  return {
    "session.created": async () => {
      if (!isProjectRegistered()) return;
      try {
        execFileSync(GMAX_BIN, ["watch", "--daemon", "-b"], {
          timeout: 5000,
          stdio: "ignore",
        });
      } catch {}
    },
  };
};
`;
}

async function install() {
  try {
    // 1. Delete legacy plugin
    for (const legacy of [LEGACY_PLUGIN_PATH]) {
      if (fs.existsSync(legacy)) {
        try {
          fs.unlinkSync(legacy);
          console.log("Deleted legacy plugin at", legacy);
        } catch {}
      }
    }

    // 2. Resolve absolute path to gmax binary
    const gmaxBin = resolveGmaxBin();
    console.log(`   Resolved gmax binary: ${gmaxBin}`);

    // 3. Create tool shim
    fs.mkdirSync(path.dirname(TOOL_PATH), { recursive: true });
    fs.writeFileSync(TOOL_PATH, buildShimContent(gmaxBin));
    console.log("✅ Created tool shim at", TOOL_PATH);

    // 4. Create plugin for daemon startup
    fs.mkdirSync(path.dirname(PLUGIN_PATH), { recursive: true });
    fs.writeFileSync(PLUGIN_PATH, buildPluginContent(gmaxBin));
    console.log("✅ Created plugin at", PLUGIN_PATH);

    // 5. Clean up stale MCP registration if present
    if (fs.existsSync(CONFIG_PATH)) {
      try {
        const config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8") || "{}");
        if (config.mcp?.gmax) {
          delete config.mcp.gmax;
          fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
          console.log("✅ Removed stale MCP registration from", CONFIG_PATH);
        }
      } catch {}
    }
  } catch (err) {
    console.error("❌ Installation failed:", err);
  }
}

async function uninstall() {
  try {
    // 1. Remove tool shim
    if (fs.existsSync(TOOL_PATH)) {
      fs.unlinkSync(TOOL_PATH);
      console.log("✅ Removed tool shim.");
    }

    // 2. Remove plugin
    if (fs.existsSync(PLUGIN_PATH)) {
      fs.unlinkSync(PLUGIN_PATH);
      console.log("✅ Removed plugin.");
    }

    // 3. Clean up legacy paths
    if (fs.existsSync(LEGACY_PLUGIN_PATH)) {
      fs.unlinkSync(LEGACY_PLUGIN_PATH);
      console.log("✅ Cleaned up legacy plugin.");
    }

    // 4. Clean up MCP registration if present
    if (fs.existsSync(CONFIG_PATH)) {
      const config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8") || "{}");
      if (config.mcp?.gmax) {
        delete config.mcp.gmax;
        fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
        console.log("✅ Removed MCP registration.");
      }
    }
  } catch (err) {
    console.error("❌ Uninstall failed:", err);
  }
}

export const installOpencode = new Command("install-opencode")
  .description("Install gmax as an OpenCode plugin (Daemon + Tool)")
  .action(install);

export const uninstallOpencode = new Command("uninstall-opencode")
  .description("Remove the gmax OpenCode plugin")
  .action(uninstall);
