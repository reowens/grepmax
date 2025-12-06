import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";

const PLUGIN_ROOT =
  process.env.DROID_PLUGIN_ROOT ||
  path.resolve(__dirname, "../../dist/plugins/osgrep");
const PLUGIN_HOOKS_DIR = path.join(PLUGIN_ROOT, "hooks");
const PLUGIN_SKILL_PATH = path.join(PLUGIN_ROOT, "skills", "osgrep", "SKILL.md");

type HookCommand = {
  type: "command";
  command: string;
  timeout: number;
};

type HookEntry = {
  matcher?: string | null;
  hooks: HookCommand[];
};

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
      `Factory Droid directory not found at ${root}. Start Factory Droid once to initialize it, then re-run the install.`,
    );
  }
  return root;
}

function writeFileIfChanged(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const already = fs.existsSync(filePath)
    ? fs.readFileSync(filePath, "utf-8")
    : undefined;
  if (already !== content) {
    fs.writeFileSync(filePath, content);
  }
}

function readPluginAsset(assetPath: string): string {
  if (!fs.existsSync(assetPath)) {
    throw new Error(`Plugin asset missing: ${assetPath}`);
  }
  return fs.readFileSync(assetPath, "utf-8");
}

function parseJsonWithComments(content: string): Record<string, unknown> {
  const stripped = content
    .split("\n")
    .map((line) => line.replace(/^\s*\/\/.*$/, ""))
    .join("\n");
  const parsed: unknown = JSON.parse(stripped);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Factory Droid settings must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

function loadSettings(settingsPath: string): Settings {
  if (!fs.existsSync(settingsPath)) {
    return {};
  }
  const raw = fs.readFileSync(settingsPath, "utf-8");
  const parsed = parseJsonWithComments(raw);
  return parsed as Settings;
}

function saveSettings(
  settingsPath: string,
  settings: Record<string, unknown>,
): void {
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
}

function isHooksConfig(value: unknown): value is HooksConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  return Object.values(value).every((entry) => Array.isArray(entry));
}

function mergeHooks(
  existingHooks: HooksConfig | undefined,
  newHooks: HooksConfig,
): HooksConfig {
  const merged: HooksConfig = existingHooks
    ? (JSON.parse(JSON.stringify(existingHooks)) as HooksConfig)
    : {};
  for (const [event, entries] of Object.entries(newHooks)) {
    const current: HookEntry[] = Array.isArray(merged[event])
      ? merged[event]
      : [];
    for (const entry of entries) {
      const command = entry?.hooks?.[0]?.command;
      const matcher = entry?.matcher ?? null;
      const duplicate = current.some(
        (item) =>
          (item?.matcher ?? null) === matcher &&
          item?.hooks?.[0]?.command === command &&
          item?.hooks?.[0]?.type === entry?.hooks?.[0]?.type,
      );
      if (!duplicate) {
        current.push(entry);
      }
    }
    merged[event] = current;
  }
  return merged;
}

async function installPlugin() {
  const root = resolveDroidRoot();
  const hooksDir = path.join(root, "hooks", "osgrep");
  const skillsDir = path.join(root, "skills", "osgrep");
  const settingsPath = path.join(root, "settings.json");

  const startHook = readPluginAsset(path.join(PLUGIN_HOOKS_DIR, "start.js"));
  const stopHook = readPluginAsset(path.join(PLUGIN_HOOKS_DIR, "stop.js"));
  const skillContent = readPluginAsset(PLUGIN_SKILL_PATH);

  const startJs = path.join(hooksDir, "osgrep_start.js");
  const stopJs = path.join(hooksDir, "osgrep_stop.js");
  writeFileIfChanged(startJs, startHook);
  writeFileIfChanged(stopJs, stopHook);

  const hookConfig: HooksConfig = {
    SessionStart: [
      {
        matcher: "startup|resume",
        hooks: [
          {
            type: "command",
            command: `node "${startJs}"`,
            timeout: 10,
          },
        ],
      },
    ],
    SessionEnd: [
      {
        hooks: [
          {
            type: "command",
            command: `node "${stopJs}"`,
            timeout: 10,
          },
        ],
      },
    ],
  };
  writeFileIfChanged(
    path.join(skillsDir, "SKILL.md"),
    skillContent.trimStart(),
  );

  const settings = loadSettings(settingsPath);
  settings.enableHooks = true;
  settings.allowBackgroundProcesses = true;
  settings.hooks = mergeHooks(
    isHooksConfig(settings.hooks) ? settings.hooks : undefined,
    hookConfig,
  );
  saveSettings(settingsPath, settings as Record<string, unknown>);

  console.log(
    `Installed the osgrep hooks and skill for Factory Droid in ${root}`,
  );
}

async function uninstallPlugin() {
  const root = resolveDroidRoot();
  const hooksDir = path.join(root, "hooks", "osgrep");
  const skillsDir = path.join(root, "skills", "osgrep");
  const settingsPath = path.join(root, "settings.json");

  if (fs.existsSync(hooksDir)) {
    fs.rmSync(hooksDir, { recursive: true, force: true });
    console.log("Removed osgrep hooks from Factory Droid");
  } else {
    console.log("No osgrep hooks found for Factory Droid");
  }

  if (fs.existsSync(skillsDir)) {
    fs.rmSync(skillsDir, { recursive: true, force: true });
    console.log("Removed osgrep skill from Factory Droid");
  } else {
    console.log("No osgrep skill found for Factory Droid");
  }

  if (fs.existsSync(settingsPath)) {
    try {
      const settings = loadSettings(settingsPath);
      const hooks = isHooksConfig(settings.hooks) ? settings.hooks : undefined;
      if (hooks) {
        for (const event of Object.keys(hooks)) {
          const filtered = hooks[event].filter(
            (entry) =>
              entry?.hooks?.[0]?.command !==
              `node "${path.join(hooksDir, "osgrep_start.js")}"` &&
              entry?.hooks?.[0]?.command !==
              `node "${path.join(hooksDir, "osgrep_stop.js")}"`,
          );
          if (filtered.length === 0) {
            delete hooks[event];
          } else {
            hooks[event] = filtered;
          }
        }
        if (Object.keys(hooks).length === 0) {
          delete settings.hooks;
        }
        saveSettings(settingsPath, settings as Record<string, unknown>);
      }
    } catch (error) {
      console.warn(
        `Failed to update Factory Droid settings during uninstall: ${error}`,
      );
    }
  }
}

export const installDroid = new Command("install-droid")
  .description("Install the osgrep hooks and skill for Factory Droid")
  .action(async () => {
    await installPlugin();
  });

export const uninstallDroid = new Command("uninstall-droid")
  .description("Uninstall the osgrep hooks and skill for Factory Droid")
  .action(async () => {
    await uninstallPlugin();
  });