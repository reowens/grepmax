import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";

const TOOL_PATH = path.join(
  os.homedir(),
  ".config",
  "opencode",
  "tool",
  "osgrep.ts",
);
const PLUGIN_PATH = path.join(
  os.homedir(),
  ".config",
  "opencode",
  "plugin",
  "osgrep.ts",
);
const CONFIG_PATH = path.join(
  os.homedir(),
  ".config",
  "opencode",
  "opencode.json",
);

const SHIM_CONTENT = `
import { tool } from "@opencode-ai/plugin";

const SKILL = \`
---
name: osgrep
description: Semantic code search for AI agents. Finds code by concept, compresses files to skeletons, and traces call graphs. Saves 80-95% tokens vs reading full files.
allowed-tools: "Bash(osgrep:*), Read"
license: Apache-2.0
---

## Why Use osgrep?

**Problem:** Reading full files burns tokens. A 500-line file costs ~2000 tokens.
**Solution:** osgrep lets you understand code structure in ~100 tokens, then read only what you need.

## Core Commands

osgrep "where does authentication happen"     # Search by concept
osgrep skeleton src/services/auth.ts          # Get structure (~90% smaller)
osgrep trace AuthService                      # See callers/callees
osgrep symbols                                # List key symbols in codebase

## The Right Tool for Each Question

| Question Type | Command | Why |
|--------------|---------|-----|
| "Where is X?" | osgrep "X" | Semantic search finds concepts |
| "What's in this file?" | osgrep skeleton file.ts | See structure without reading everything |
| "Who calls X?" | osgrep trace X | Map dependencies |
| "What are the main classes?" | osgrep symbols | Get vocabulary of codebase |
| "Show me the implementation" | Read file.ts:42-80 | After you know WHERE |

## Recommended Workflow

### For "Find something specific"
osgrep "JWT token validation and expiration"
# → src/auth/jwt.ts:45  validateToken  ORCH  H
Read src/auth/jwt.ts:45-90

### For "Understand how X works"
# 1. Find the entry point
osgrep "request handling middleware"

# 2. Get structure without reading everything
osgrep skeleton src/middleware/auth.ts

# 3. Trace what it calls
osgrep trace authMiddleware

# 4. Read ONLY the specific function you need
Read src/middleware/auth.ts:23-45

### For "Explore architecture"
# 1. Get the vocabulary
osgrep symbols

# 2. Skeleton the top-referenced classes
osgrep skeleton src/services/UserService.ts

# 3. Trace key orchestrators
osgrep trace handleRequest

# 4. Now you understand the structure - read specifics as needed

## Query Tips

Be specific. Semantic search needs context.

# ❌ Too vague
osgrep "auth"

# ✅ Specific
osgrep "where does the code validate JWT tokens and check expiration"

More words = better matches. Think of it like asking a colleague.

## Understanding Output

### Search Results
# path              lines    score  role  conf  defined
# src/auth/jwt.ts   45-89    .94    ORCH  H     validateToken

- ORCH = Orchestration (complex, calls many things) - often what you want
- DEF = Definition (class, interface, type)
- IMPL = Implementation (simpler functions)
- H/M/L = Confidence level

### Skeleton Output
# Shows signatures without implementation
# Summary shows: calls made, complexity, role
# ~100 tokens vs ~2000 for full file

## Command Reference

### osgrep [query] [path]
Semantic search. Default command.
- -m N - Max results (default: 10)
- --compact - TSV output

### osgrep skeleton <target>
Compress code to signatures + summaries.
- Target: file path, symbol name, or search query
- --limit N - Max files for query mode

### osgrep trace <symbol>
Show call graph for a symbol.
- Who calls this? (callers)
- What does this call? (callees)

### osgrep symbols [filter]
List defined symbols sorted by reference count.
- No args: top 20 symbols
- With filter: matching symbols only

## ⚠️ Indexing State

If output shows "Indexing", "Building", or "Syncing":
1. STOP - Results will be incomplete
2. INFORM the user the index is building
3. ASK if they want to wait or proceed with partial results

\`;

export default tool({
  description: SKILL,
  args: {
    argv: tool.schema.array(tool.schema.string())
      .describe("Arguments for osgrep, e.g. ['search', 'user auth']")
  },
  async execute({ argv }) {
    // Use the plugin context's shell ($) for safe execution if available, 
    // or Bun's $ if running in that environment (which OpenCode does).
    // The previous mgrep example used Bun.$. 
    // But here we are writing a file that OpenCode runs. 
    // If OpenCode uses Bun, we can use Bun.$. 
    // The user's prompt example used Bun.$.
    
    // We'll rely on global Bun object or simply child_process since we are in a shim.
    // However, the mgrep example shows: const out = await Bun.$\`mgrep \${argv}\`.text()
    // Let's stick to that if possible, but safely.
    // If Bun is not available, we might break. But OpenCode seems to be Bun-based.
    
    // safe join if argv is array? 
    // Actually the user provided: const out = await Bun.$\`osgrep \${argv}\`.text()
    
    // We must ensure 'osgrep' is in PATH or use absolute path? 
    // The mgrep example relied on 'mgrep' being in PATH.
    
    try {
      // @ts-ignore
      const out = await Bun.spawn(["osgrep", ...argv], { stdout: "pipe" }).stdout;
      const text = await new Response(out).text();
      // Simple guard for indexing message
      if (text.includes("Indexing") || text.includes("Building") || text.includes("Syncing")) {
         return \`WARN: The index is currently updating. 
         
         Output so far:
         \${text.trim()}
         
         PLEASE READ THE "Indexing" WARNING IN MY SKILL DESCRIPTION.\`;
      }
      return text.trim();
    } catch (err) {
       return \`Error running osgrep: \${err}\`;
    }
  },
})`;

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

    // 2. Create tool shim
    fs.mkdirSync(path.dirname(TOOL_PATH), { recursive: true });
    fs.writeFileSync(TOOL_PATH, SHIM_CONTENT);
    console.log("✅ Created tool shim at", TOOL_PATH);

    // 3. Register MCP
    if (!fs.existsSync(CONFIG_PATH)) {
      fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
      fs.writeFileSync(CONFIG_PATH, JSON.stringify({}, null, 2));
    }

    const config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8") || "{}");
    if (!config.$schema) config.$schema = "https://opencode.ai/config.json";
    if (!config.mcp) config.mcp = {};

    config.mcp.osgrep = {
      type: "local",
      command: ["osgrep", "mcp"],
      enabled: true,
    };

    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
    console.log("✅ Registered MCP server in", CONFIG_PATH);
    console.log(
      "   Command: check proper path if 'osgrep' is not in PATH of OpenCode.",
    );
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
      if (config.mcp?.osgrep) {
        delete config.mcp.osgrep;
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
  .description("Install osgrep as an OpenCode plugin (Daemon + Tool)")
  .action(install);

export const uninstallOpencode = new Command("uninstall-opencode")
  .description("Remove the osgrep OpenCode plugin")
  .action(uninstall);
