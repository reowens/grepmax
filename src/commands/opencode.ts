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
description: Semantic code search. Finds code by concept, compresses files to skeletons. Use instead of grep/ripgrep/reading whole files.
allowed-tools: "Bash(osgrep:*), Read"
---

## When to Use osgrep

USE osgrep for:
- "Explain the architecture" 
- "How does X work?"
- "Find where Y happens"
- "What are the main components?"

DON'T use for:
- You already know the exact file and line
- Simple string search in one file

## Commands

osgrep "how requests flow from client to server"   # Semantic search
osgrep "auth" --skeleton                           # Search + compress results
osgrep skeleton src/server.ts                      # Compress specific file  
osgrep trace handleRequest                         # Who calls / what calls
osgrep symbols                                     # List main symbols

## Workflow: Architecture Questions

Query: "Explain client-server architecture, identify key files, show request flow"

# 1. Find entry points
osgrep "where do client requests enter the server"

# 2. Get structure of key files (80-95% smaller than reading)
osgrep skeleton src/server/handler.ts
osgrep skeleton src/client/api.ts

# 3. Trace the flow
osgrep trace handleRequest

# 4. Read specific code ONLY if needed
Read src/server/handler.ts:45-60

## Workflow: Find Specific Code

Query: "Where is JWT validation?"

osgrep "JWT token validation and expiration checking"
# -> src/auth/jwt.ts:45  validateToken  ORCH

Read src/auth/jwt.ts:45-80

## Output Guide

### Search Results (--compact)
# path                lines   score  role  defined
# src/auth/jwt.ts     45-89   .94    ORCH  validateToken

- ORCH = orchestrates other code (usually what you want)
- DEF = definition (class, type)

### Skeleton Output
# Shows signatures, hides bodies
# Summary: what it calls, complexity, role
# ~85 tokens vs ~800 for full file

## Query Tips

# Bad - too vague
osgrep "auth"

# Good - specific intent  
osgrep "where does the server validate JWT tokens before processing requests"

More words = better results. Describe what you're looking for like you'd ask a colleague.

## If Index is Building

If you see "Indexing" or "Syncing": STOP. Tell the user the index is building. Ask if they want to wait or proceed with partial results.

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
