import { exec } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { Command } from "commander";
import { codexAgentsPath } from "../lib/utils/codex-home";

const shell =
  process.env.SHELL || (process.platform === "win32" ? "cmd.exe" : "/bin/sh");
const execAsync = promisify(exec);

const SKILL_START = "<!-- gmax:start -->";
const SKILL_END = "<!-- gmax:end -->";

function ownedSkillBlocks(): RegExp {
  // A new start marker cannot terminate an earlier incomplete block.
  return new RegExp(
    `${SKILL_START}(?:(?!${SKILL_START})[\\s\\S])*?${SKILL_END}`,
    "g",
  );
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
      "description: Semantic code search. Use alongside grep - grep for exact strings, gmax for concepts.",
      "---",
      "",
      'Use `gmax "query" --agent` for semantic search.',
    ].join("\n");
  }
}

function writeSkillToAgents(skill: string): void {
  const AGENTS_PATH = codexAgentsPath();
  fs.mkdirSync(path.dirname(AGENTS_PATH), { recursive: true });

  const block = `${SKILL_START}\n${skill.trim()}\n${SKILL_END}`;

  if (!fs.existsSync(AGENTS_PATH)) {
    fs.writeFileSync(AGENTS_PATH, block);
    return;
  }

  const content = fs.readFileSync(AGENTS_PATH, "utf-8");

  // Only complete marker pairs establish ownership. Unmarked prose, legacy
  // instructions, and incomplete markers belong to the user and stay intact.
  const markerRe = ownedSkillBlocks();
  let replaced = false;
  const updated = content.replace(markerRe, () => {
    if (replaced) return "";
    replaced = true;
    return block;
  });
  const separator = content.endsWith("\n\n")
    ? ""
    : content.endsWith("\n")
      ? "\n"
      : "\n\n";
  fs.writeFileSync(
    AGENTS_PATH,
    replaced ? updated : `${content}${separator}${block}`,
  );
}

async function installPlugin() {
  try {
    const inventory = await execAsync("codex mcp list --json", {
      shell,
      env: process.env,
    });
    const servers: unknown = JSON.parse(inventory.stdout);
    if (
      !Array.isArray(servers) ||
      servers.some((server) => !server || typeof server.name !== "string")
    )
      throw new Error(
        "Unexpected Codex MCP inventory; configuration preserved",
      );
    const existing = servers.find((server) => server?.name === "gmax");
    if (
      existing &&
      (existing.transport?.type !== "stdio" ||
        path.basename(String(existing.transport.command)) !== "gmax" ||
        JSON.stringify(existing.transport.args) !== JSON.stringify(["mcp"]))
    )
      throw new Error(
        "Existing gmax MCP launch differs; review it before replacing",
      );
    // 1. Register MCP tool. Codex requires the stdio command after `--`:
    //   codex mcp add [OPTIONS] <NAME> -- <COMMAND>...
    // Without the separator the launch command is misparsed. AGENTS.md is only
    // written after this resolves, so a failed registration leaves it untouched.
    if (!existing) {
      await execAsync("codex mcp add gmax -- gmax mcp", {
        shell,
        env: process.env,
      });
    }
    console.log("✅ gmax MCP registration ready (existing options preserved)");

    // 2. Write SKILL to AGENTS.md (idempotent)
    const skill = loadSkill();
    writeSkillToAgents(skill);
    console.log("✅ gmax skill instructions written to", codexAgentsPath());
  } catch (error) {
    console.error(`❌ Error installing Codex plugin: ${error}`);
    process.exit(1);
  }
}

async function uninstallPlugin() {
  const AGENTS_PATH = codexAgentsPath();
  try {
    await execAsync("codex mcp remove gmax", { shell, env: process.env });
    console.log("✅ gmax MCP tool removed");
  } catch {
    /* ignore if not found */
  }

  if (fs.existsSync(AGENTS_PATH)) {
    let content = fs.readFileSync(AGENTS_PATH, "utf-8");
    // Remove marked block
    const markerRe = ownedSkillBlocks();
    if (markerRe.test(content)) {
      content = content.replace(ownedSkillBlocks(), "");
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
