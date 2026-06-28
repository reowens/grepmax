import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";

// --- Config Utils ---

type HookCommand = { type: "command"; command: string; timeout: number };
type HookEntry = { matcher?: string | null; hooks: HookCommand[] };
type HooksConfig = Record<string, HookEntry[]>;
type Settings = {
  hooks?: HooksConfig;
  enableHooks?: boolean;
  allowBackgroundProcesses?: boolean;
} & Record<string, unknown>;

function resolveDroidRoot(): string {
  const root = path.join(os.homedir(), ".factory");
  if (!fs.existsSync(root)) {
    throw new Error(
      `Factory Droid directory not found at ${root}. Run Factory Droid once to initialize.`,
    );
  }
  return root;
}

function resolveGmaxBin(): string {
  try {
    return execSync("which gmax", { encoding: "utf-8", stdio: "pipe" }).trim();
  } catch {
    const binDir = path.dirname(process.argv[1]);
    const candidate = path.join(binDir, "gmax");
    if (fs.existsSync(candidate)) return candidate;
    return "gmax";
  }
}

function getPackageRoot(): string {
  return path.resolve(__dirname, "../..");
}

function loadSkill(): string {
  const skillPath = path.join(
    getPackageRoot(),
    "plugins",
    "grepmax",
    "skills",
    "grepmax",
    "SKILL.md",
  );
  try {
    return fs.readFileSync(skillPath, "utf-8");
  } catch {
    return [
      "---",
      "name: gmax",
      "description: Semantic code search.",
      "---",
      "",
      'Use `gmax "query" --agent` for semantic search.',
    ].join("\n");
  }
}

function writeFileIfChanged(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const already = fs.existsSync(filePath)
    ? fs.readFileSync(filePath, "utf-8")
    : undefined;
  if (already !== content) fs.writeFileSync(filePath, content);
}

function parseJsonWithComments(content: string): Record<string, unknown> {
  const stripped = content
    .split("\n")
    .map((line) => line.replace(/^\s*\/\/.*$/, ""))
    .join("\n");
  // An empty / whitespace-only file is a legitimate "no settings yet" -> {}.
  // Anything else that fails to parse is a real, user-owned file we must NOT
  // silently coerce to {} (that would clobber it on the next save) — let the
  // caller decide.
  if (stripped.trim() === "") return {};
  return JSON.parse(stripped);
}

function loadSettings(settingsPath: string): Settings {
  if (!fs.existsSync(settingsPath)) return {};
  const raw = fs.readFileSync(settingsPath, "utf-8");
  try {
    return parseJsonWithComments(raw) as Settings;
  } catch (err) {
    throw new Error(
      `Refusing to touch ${settingsPath}: it contains invalid JSON ` +
        `(${(err as Error).message}). Fix or remove the file, then re-run.`,
    );
  }
}

/** True when a hook entry was installed by gmax — its command points at our
 *  hooks dir. Used to remove only gmax entries on uninstall. */
function isGmaxHookEntry(entry: HookEntry, hooksDir: string): boolean {
  return entry.hooks?.some((h) => h.command?.includes(hooksDir)) ?? false;
}

/** Strip gmax hook entries from settings.hooks in place, preserving unrelated
 *  user hooks. Returns true if anything was removed. */
function removeGmaxHooks(settings: Settings, hooksDir: string): boolean {
  if (!settings.hooks) return false;
  let changed = false;
  for (const [event, entries] of Object.entries(settings.hooks)) {
    const kept = entries.filter((e) => !isGmaxHookEntry(e, hooksDir));
    if (kept.length !== entries.length) changed = true;
    if (kept.length > 0) settings.hooks[event] = kept;
    else delete settings.hooks[event];
  }
  if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
  return changed;
}

function saveSettings(
  settingsPath: string,
  settings: Record<string, unknown>,
): void {
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
}

function mergeHooks(
  existing: HooksConfig | undefined,
  incoming: HooksConfig,
): HooksConfig {
  const merged = existing ? JSON.parse(JSON.stringify(existing)) : {};
  for (const [event, entries] of Object.entries(incoming)) {
    const current = merged[event] || [];
    for (const entry of entries) {
      const cmd = entry.hooks[0].command;
      if (!current.some((c: any) => c.hooks[0].command === cmd)) {
        current.push(entry);
      }
    }
    merged[event] = current;
  }
  return merged;
}

// --- Installer ---

async function installPlugin() {
  const root = resolveDroidRoot();
  const settingsPath = path.join(root, "settings.json");

  // Validate/parse settings BEFORE writing anything. A malformed, user-owned
  // settings.json aborts the install here — otherwise we'd either clobber it
  // with {} or leave half-written hook scripts behind on the failure path.
  const settings = loadSettings(settingsPath);

  const gmaxBin = resolveGmaxBin();
  const hooksDir = path.join(root, "hooks", "gmax");
  const skillsDir = path.join(root, "skills", "gmax");

  // 1. Install hook scripts (start/stop daemon)
  const startScript = `
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");

const BIN = "${gmaxBin}";

function resolveGmax() {
  if (fs.existsSync(BIN)) return BIN;
  try {
    return require("child_process").execSync("which gmax", { encoding: "utf-8" }).trim();
  } catch { return null; }
}

function isProjectRegistered() {
  try {
    const projectsPath = path.join(os.homedir(), ".gmax", "projects.json");
    const projects = JSON.parse(fs.readFileSync(projectsPath, "utf-8"));
    const cwd = process.cwd();
    return projects.some((p) => cwd.startsWith(p.root));
  } catch { return false; }
}

const bin = resolveGmax();
if (bin && isProjectRegistered()) {
  try { execFileSync(bin, ["watch", "--daemon", "-b"], { timeout: 5000, stdio: "ignore" }); } catch {}
}
`.trim();

  const stopScript = `
const { execFileSync } = require("child_process");
try { execFileSync("gmax", ["watch", "stop", "--all"], { stdio: "ignore", timeout: 5000 }); } catch {}
`.trim();

  const startJsPath = path.join(hooksDir, "gmax_start.js");
  const stopJsPath = path.join(hooksDir, "gmax_stop.js");

  writeFileIfChanged(startJsPath, startScript);
  writeFileIfChanged(stopJsPath, stopScript);

  // 2. Install SKILL (read from package root)
  const skill = loadSkill();
  writeFileIfChanged(path.join(skillsDir, "SKILL.md"), skill.trim());

  // 3. Configure settings
  const hookConfig: HooksConfig = {
    SessionStart: [
      {
        matcher: "startup|resume",
        hooks: [
          { type: "command", command: `node "${startJsPath}"`, timeout: 10 },
        ],
      },
    ],
    SessionEnd: [
      {
        hooks: [
          { type: "command", command: `node "${stopJsPath}"`, timeout: 10 },
        ],
      },
    ],
  };

  settings.enableHooks = true;
  settings.allowBackgroundProcesses = true;
  settings.hooks = mergeHooks(settings.hooks as HooksConfig, hookConfig);
  saveSettings(settingsPath, settings);

  console.log("✅ gmax installed for Factory Droid (Hooks + Skill)");
}

async function uninstallPlugin() {
  const root = resolveDroidRoot();
  const hooksDir = path.join(root, "hooks", "gmax");
  const skillsDir = path.join(root, "skills", "gmax");
  const settingsPath = path.join(root, "settings.json");

  if (fs.existsSync(hooksDir))
    fs.rmSync(hooksDir, { recursive: true, force: true });
  if (fs.existsSync(skillsDir))
    fs.rmSync(skillsDir, { recursive: true, force: true });

  // Remove only gmax hook entries from settings.json, preserving unrelated user
  // hooks. enableHooks/allowBackgroundProcesses are left alone — other hooks may
  // depend on them.
  if (fs.existsSync(settingsPath)) {
    try {
      const settings = loadSettings(settingsPath);
      if (removeGmaxHooks(settings, hooksDir)) {
        saveSettings(settingsPath, settings);
        console.log("✅ Removed gmax hooks from settings.json");
      }
    } catch (err) {
      // Don't clobber an invalid settings file on uninstall either.
      console.warn(`⚠️  Skipped settings cleanup: ${(err as Error).message}`);
    }
  }

  console.log("✅ gmax removed from Factory Droid");
}

export const installDroid = new Command("install-droid")
  .description("Install gmax for Factory Droid")
  .action(installPlugin);

export const uninstallDroid = new Command("uninstall-droid")
  .description("Uninstall gmax from Factory Droid")
  .action(uninstallPlugin);
