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
    const binDir = path.dirname(process.argv[1]);
    const candidate = path.join(binDir, "gmax");
    if (fs.existsSync(candidate)) return candidate;
    return "gmax";
  }
}

function buildShimContent(gmaxBin: string) {
  return `
import { tool } from "@opencode-ai/plugin";
import { existsSync, realpathSync, readFileSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { execFileSync } from "node:child_process";

// Resolve gmax binary and SKILL dynamically from the installed package.
// This means npm install -g grepmax@latest automatically updates the SKILL
// without needing to re-run gmax install-opencode.
const _gmax = (() => {
  // Binary: try hardcoded path, fall back to which
  let bin = "${gmaxBin}";
  if (!existsSync(bin)) {
    try {
      bin = execFileSync("which gmax", { encoding: "utf-8" }).trim();
    } catch {
      return { bin: "gmax", skill: "Semantic code search. Run: gmax 'query' --agent" };
    }
  }

  // SKILL: read from package root
  try {
    const root = resolve(dirname(realpathSync(bin)), "..");
    const skillPath = join(root, "plugins", "grepmax", "skills", "grepmax", "SKILL.md");
    return { bin, skill: readFileSync(skillPath, "utf-8") };
  } catch {
    return { bin, skill: "Semantic code search. Run: gmax 'query' --agent" };
  }
})();

export default tool({
  description: _gmax.skill,
  args: {
    argv: tool.schema.array(tool.schema.string())
      .describe("Arguments for gmax, e.g. ['search', 'user auth', '--agent']")
  },
  async execute({ argv }) {
    try {
      // @ts-ignore
      const out = await Bun.spawn([_gmax.bin, ...argv], { stdout: "pipe" }).stdout;
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
  return `import { existsSync, readFileSync, realpathSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, resolve, dirname } from "node:path";
import { homedir } from "node:os";

function resolveGmaxBin() {
  const hardcoded = "${gmaxBin}";
  if (existsSync(hardcoded)) return hardcoded;
  try {
    return execFileSync("which gmax", { encoding: "utf-8" }).trim();
  } catch {
    return null;
  }
}

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

function startDaemon() {
  const bin = resolveGmaxBin();
  if (!bin || !isProjectRegistered()) return;
  try {
    execFileSync(bin, ["watch", "--daemon", "-b"], {
      timeout: 5000,
      stdio: "ignore",
    });
  } catch {}
}

export const GmaxPlugin = async () => {
  startDaemon();

  return {
    "session.created": async () => {
      startDaemon();
    },
  };
};
`;
}

async function install() {
  try {
    // 1. Delete legacy plugin
    if (fs.existsSync(LEGACY_PLUGIN_PATH)) {
      try {
        fs.unlinkSync(LEGACY_PLUGIN_PATH);
        console.log("Deleted legacy plugin at", LEGACY_PLUGIN_PATH);
      } catch {}
    }

    // 2. Resolve absolute path to gmax binary
    const gmaxBin = resolveGmaxBin();
    console.log(`   Resolved gmax binary: ${gmaxBin}`);

    // 3. Create tool shim (reads SKILL dynamically from package root)
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
