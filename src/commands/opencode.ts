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
allowed-tools: "Bash(gmax:*), Read"
---

## What gmax does

Finds code by meaning. When you'd ask a colleague "where do we handle auth?", use gmax.

- grep/ripgrep: exact string match, fast
- gmax: concept match, finds code you couldn't grep for

## Primary command

gmax "where do we validate user permissions"


Returns ~10 results with code snippets (15+ lines each). Usually enough to understand what's happening.

## Output explained

ORCHESTRATION src/auth/handler.ts:45
Defines: handleAuth | Calls: validate, checkRole, respond | Score: .94

export async function handleAuth(req: Request) {
  const token = req.headers.get("Authorization");
  const claims = await validateToken(token);
  if (!claims) return unauthorized();
  const allowed = await checkRole(claims.role, req.path);
  ...

- **ORCHESTRATION** = contains logic, coordinates other code
- **DEFINITION** = types, interfaces, classes
- **Score** = relevance (1 = best match)
- **Calls** = what this code calls (helps you trace flow)

## When to Read more

The snippet often has enough context. But if you need more:

# gmax found src/auth/handler.ts:45-90 as ORCH
Read src/auth/handler.ts:45-120


Read the specific line range, not the whole file.

## Other commands

# Trace call graph (who calls X, what X calls)
gmax trace handleAuth

# Skeleton of a huge file (to find which ranges to read)
gmax skeleton src/giant-2000-line-file.ts

# Just file paths when you only need locations
gmax "authentication" --compact


## Workflow: architecture questions

# 1. Find entry points
gmax "where do requests enter the server"
# Review the ORCH results - code is shown

# 2. If you need deeper context on a specific function
Read src/server/handler.ts:45-120

# 3. Trace to understand call flow
gmax trace handleRequest

## Tips

- More words = better results. "auth" is vague. "where does the server validate JWT tokens" is specific.
- ORCH results contain the logic - prioritize these
- Don't read entire files. Use the line ranges gmax gives you.
- If results seem off, rephrase your query like you'd ask a teammate

## If Index is Building

If you see "Indexing" or "Syncing": STOP. Tell the user the index is building. Ask if they want to wait or proceed with partial results.

\`;

const GMAX_BIN = "${gmaxBin}";

export default tool({
  description: SKILL,
  args: {
    argv: tool.schema.array(tool.schema.string())
      .describe("Arguments for gmax, e.g. ['search', 'user auth']")
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

PLEASE READ THE "Indexing" WARNING IN MY SKILL DESCRIPTION.\`;
      }
      return text.trim();
    } catch (err) {
       return \`Error running gmax: \${err}\`;
    }
  },
})`;
}

async function install() {
  try {
    // 1. Delete legacy plugin
    if (fs.existsSync(PLUGIN_PATH)) {
      try {
        fs.unlinkSync(PLUGIN_PATH);
        console.log("Deleted legacy plugin at", PLUGIN_PATH);
      } catch (e) {
        console.warn("mnt: Failed to delete legacy plugin:", e);
      }
    }

    // 2. Resolve absolute path to gmax binary
    const gmaxBin = resolveGmaxBin();
    console.log(`   Resolved gmax binary: ${gmaxBin}`);

    // 3. Create tool shim
    fs.mkdirSync(path.dirname(TOOL_PATH), { recursive: true });
    fs.writeFileSync(TOOL_PATH, buildShimContent(gmaxBin));
    console.log("✅ Created tool shim at", TOOL_PATH);

    // 4. Register MCP
    if (!fs.existsSync(CONFIG_PATH)) {
      fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
      fs.writeFileSync(CONFIG_PATH, JSON.stringify({}, null, 2));
    }

    const config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8") || "{}");
    if (!config.$schema) config.$schema = "https://opencode.ai/config.json";
    if (!config.mcp) config.mcp = {};

    config.mcp.gmax = {
      type: "local",
      command: [gmaxBin, "mcp"],
      enabled: true,
    };

    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
    console.log("✅ Registered MCP server in", CONFIG_PATH);
  } catch (err) {
    console.error("❌ Installation failed:", err);
  }
}

async function uninstall() {
  try {
    // 1. Remove shim
    if (fs.existsSync(TOOL_PATH)) {
      fs.unlinkSync(TOOL_PATH);
      console.log("✅ Removed tool shim.");
    }

    // 2. Unregister MCP
    if (fs.existsSync(CONFIG_PATH)) {
      const config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8") || "{}");
      if (config.mcp?.gmax) {
        delete config.mcp.gmax;
        fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
        console.log("✅ Unregistered MCP server.");
      }
    }

    // Cleanup plugin just in case
    if (fs.existsSync(PLUGIN_PATH)) {
      fs.unlinkSync(PLUGIN_PATH);
      console.log("✅ Cleaned up plugin file.");
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
