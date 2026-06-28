import { exec } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { Command } from "commander";

const shell =
  process.env.SHELL || (process.platform === "win32" ? "cmd.exe" : "/bin/sh");
const execAsync = promisify(exec);

const AGENTS_PATH = path.join(os.homedir(), ".codex", "AGENTS.md");
const SKILL_START = "<!-- gmax:start -->";
const SKILL_END = "<!-- gmax:end -->";

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
      "description: Semantic code search. Use alongside grep - grep for exact strings, gmax for concepts.",
      "---",
      "",
      'Use `gmax "query" --agent` for semantic search.',
    ].join("\n");
  }
}

function writeSkillToAgents(skill: string): void {
  fs.mkdirSync(path.dirname(AGENTS_PATH), { recursive: true });

  const block = `${SKILL_START}\n${skill.trim()}\n${SKILL_END}`;

  if (!fs.existsSync(AGENTS_PATH)) {
    fs.writeFileSync(AGENTS_PATH, block);
    return;
  }

  const content = fs.readFileSync(AGENTS_PATH, "utf-8");

  // Check if file has any gmax content (markers or legacy)
  if (content.includes("gmax")) {
    // Remove all gmax content and rewrite with just our block
    const markerRe = new RegExp(
      `\n?${SKILL_START}[\\s\\S]*?${SKILL_END}\n?`,
      "g",
    );
    const cleaned = content.replace(markerRe, "");
    // Remove legacy content (everything between --- blocks mentioning gmax)
    const withoutLegacy = cleaned
      .replace(/---[\s\S]*?(?:gmax|--compact)[\s\S]*?(?=\n<!-- |$)/, "")
      .trim();
    fs.writeFileSync(
      AGENTS_PATH,
      withoutLegacy ? `${withoutLegacy}\n\n${block}` : block,
    );
  } else {
    fs.writeFileSync(AGENTS_PATH, `${content.trim()}\n\n${block}`);
  }
}

async function installPlugin() {
  try {
    // 1. Register MCP tool. Codex requires the stdio command after `--`:
    //   codex mcp add [OPTIONS] <NAME> -- <COMMAND>...
    // Without the separator the launch command is misparsed. AGENTS.md is only
    // written after this resolves, so a failed registration leaves it untouched.
    await execAsync("codex mcp add gmax -- gmax mcp", {
      shell,
      env: process.env,
    });
    console.log("✅ gmax MCP tool registered with Codex");

    // 2. Write SKILL to AGENTS.md (idempotent)
    const skill = loadSkill();
    writeSkillToAgents(skill);
    console.log("✅ gmax skill instructions written to", AGENTS_PATH);
  } catch (error) {
    console.error(`❌ Error installing Codex plugin: ${error}`);
    process.exit(1);
  }
}

async function uninstallPlugin() {
  try {
    await execAsync("codex mcp remove gmax", { shell, env: process.env });
    console.log("✅ gmax MCP tool removed");
  } catch {
    /* ignore if not found */
  }

  if (fs.existsSync(AGENTS_PATH)) {
    let content = fs.readFileSync(AGENTS_PATH, "utf-8");
    // Remove marked block
    const markerRe = new RegExp(
      `\n?${SKILL_START}[\\s\\S]*?${SKILL_END}\n?`,
      "g",
    );
    if (markerRe.test(content)) {
      content = content.replace(markerRe, "").trim();
      fs.writeFileSync(AGENTS_PATH, content || "");
      console.log("✅ gmax instructions removed from AGENTS.md");
    }
  }
}

export const installCodex = new Command("install-codex")
  .description("Install gmax for Codex")
  .action(installPlugin);

export const uninstallCodex = new Command("uninstall-codex")
  .description("Uninstall gmax from Codex")
  .action(uninstallPlugin);
