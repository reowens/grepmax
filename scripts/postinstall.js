#!/usr/bin/env node
/**
 * Postinstall: sync plugin files (SKILL.md, hooks, plugin.json) to
 * the Claude Code plugin cache if it exists. This ensures `npm update -g grepmax`
 * automatically updates the skill instructions without needing `gmax install-claude-code`.
 */
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const pluginCacheBase = path.join(os.homedir(), ".claude", "plugins", "cache", "grepmax", "grepmax");
const sourcePlugin = path.join(__dirname, "..", "plugins", "grepmax");

if (!fs.existsSync(pluginCacheBase) || !fs.existsSync(sourcePlugin)) {
  // Plugin not installed via Claude Code — skip silently
  process.exit(0);
}

// Find installed version directories
let entries;
try {
  entries = fs.readdirSync(pluginCacheBase, { withFileTypes: true });
} catch {
  process.exit(0);
}

const versionDirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
if (versionDirs.length === 0) process.exit(0);

// Sync files to each installed version
function copyRecursive(src, dest) {
  if (!fs.existsSync(src)) return;
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src)) {
      copyRecursive(path.join(src, entry), path.join(dest, entry));
    }
  } else {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
  }
}

for (const ver of versionDirs) {
  const destDir = path.join(pluginCacheBase, ver);
  try {
    // Sync skills
    copyRecursive(
      path.join(sourcePlugin, "skills"),
      path.join(destDir, "skills"),
    );
    // Sync hooks
    copyRecursive(
      path.join(sourcePlugin, "hooks"),
      path.join(destDir, "hooks"),
    );
    // Sync hooks.json
    const hooksJson = path.join(sourcePlugin, "hooks.json");
    if (fs.existsSync(hooksJson)) {
      fs.copyFileSync(hooksJson, path.join(destDir, "hooks.json"));
    }
  } catch {
    // Best-effort — don't fail the install
  }
}

// Sync OpenCode: re-run installer if tool shim or plugin exists
const ocToolPath = path.join(os.homedir(), ".config", "opencode", "tool", "gmax.ts");
const ocPluginPath = path.join(os.homedir(), ".config", "opencode", "plugins", "gmax.ts");
if (fs.existsSync(ocToolPath) || fs.existsSync(ocPluginPath)) {
  try {
    const { execSync: exec } = require("node:child_process");
    exec("gmax install-opencode", { stdio: "ignore", timeout: 10000 });
  } catch {
    // Best-effort — don't fail the install
  }
}
