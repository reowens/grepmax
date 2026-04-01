import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Command } from "commander";
import { gracefulExit } from "../lib/utils/exit";

interface Client {
  name: string;
  id: string;
  detect: () => boolean;
  install: () => Promise<void>;
  uninstall: () => Promise<void>;
  isInstalled: () => boolean;
}

function commandExists(cmd: string): boolean {
  try {
    execSync(`which ${cmd}`, { encoding: "utf-8", stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

function getClients(): Client[] {
  return [
    {
      name: "Claude Code",
      id: "claude",
      detect: () => commandExists("claude"),
      isInstalled: () =>
        fs.existsSync(
          path.join(
            os.homedir(),
            ".claude",
            "plugins",
            "cache",
            "grepmax",
            "grepmax",
          ),
        ),
      install: async () => {
        const { installClaudeCode } = await import("./claude-code");
        await installClaudeCode.parseAsync(["node", "gmax"]);
      },
      uninstall: async () => {
        const cacheBase = path.join(
          os.homedir(),
          ".claude",
          "plugins",
          "cache",
          "grepmax",
        );
        if (fs.existsSync(cacheBase)) {
          fs.rmSync(cacheBase, { recursive: true, force: true });
        }
        try {
          const { spawn } = await import("node:child_process");
          await new Promise<void>((resolve) => {
            const child = spawn(
              "claude",
              ["plugin", "marketplace", "remove", "grepmax"],
              { stdio: "ignore" },
            );
            child.on("exit", () => resolve());
            child.on("error", () => resolve());
          });
        } catch {}
        console.log("✅ Removed Claude Code plugin.");
      },
    },
    {
      name: "OpenCode",
      id: "opencode",
      detect: () => commandExists("opencode"),
      isInstalled: () =>
        fs.existsSync(
          path.join(os.homedir(), ".config", "opencode", "tool", "gmax.ts"),
        ),
      install: async () => {
        const { installOpencode } = await import("./opencode");
        await installOpencode.parseAsync(["node", "gmax"]);
      },
      uninstall: async () => {
        const { uninstallOpencode } = await import("./opencode");
        await uninstallOpencode.parseAsync(["node", "gmax"]);
      },
    },
    {
      name: "Codex",
      id: "codex",
      detect: () => commandExists("codex"),
      isInstalled: () => {
        const p = path.join(os.homedir(), ".codex", "AGENTS.md");
        try {
          return fs.existsSync(p) && fs.readFileSync(p, "utf-8").includes("name: gmax");
        } catch {
          return false;
        }
      },
      install: async () => {
        const { installCodex } = await import("./codex");
        await installCodex.parseAsync(["node", "gmax"]);
      },
      uninstall: async () => {
        const { uninstallCodex } = await import("./codex");
        await uninstallCodex.parseAsync(["node", "gmax"]);
      },
    },
    {
      name: "Factory Droid",
      id: "droid",
      detect: () =>
        fs.existsSync(path.join(os.homedir(), ".factory")) &&
        commandExists("droid"),
      isInstalled: () =>
        fs.existsSync(
          path.join(os.homedir(), ".factory", "skills", "gmax", "SKILL.md"),
        ),
      install: async () => {
        const { installDroid } = await import("./droid");
        await installDroid.parseAsync(["node", "gmax"]);
      },
      uninstall: async () => {
        const { uninstallDroid } = await import("./droid");
        await uninstallDroid.parseAsync(["node", "gmax"]);
      },
    },
  ];
}

// --- Subcommands ---

const addCmd = new Command("add")
  .description("Install or update gmax plugins")
  .argument("[client]", "Client to install (claude, opencode, codex, droid, all)")
  .action(async (clientArg?: string) => {
    const clients = getClients();
    const onlyId = clientArg && clientArg !== "all" ? clientArg : undefined;

    if (onlyId) {
      const client = clients.find((c) => c.id === onlyId);
      if (!client) {
        console.error(`Unknown client: ${onlyId}`);
        console.error(`Available: ${clients.map((c) => c.id).join(", ")}`);
        await gracefulExit(1);
        return;
      }
      if (!client.detect()) {
        console.error(`${client.name} not found on this system`);
        await gracefulExit(1);
        return;
      }
      await client.install();
      await gracefulExit();
      return;
    }

    // Install all detected
    console.log("gmax plugin add — detecting clients...\n");
    let installed = 0;
    for (const client of clients) {
      if (!client.detect()) {
        console.log(`  skip  ${client.name} — not found`);
        continue;
      }
      try {
        await client.install();
        installed++;
      } catch (err) {
        console.error(
          `  FAIL  ${client.name} — ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    if (installed === 0) {
      console.log(
        "\nNo supported clients found. Install one of: claude, opencode, codex, droid",
      );
    } else {
      console.log(`\n${installed} plugin(s) installed.`);
    }
    await gracefulExit();
  });

const removeCmd = new Command("remove")
  .description("Remove gmax plugins")
  .argument("[client]", "Client to remove (claude, opencode, codex, droid, all)")
  .action(async (clientArg?: string) => {
    const clients = getClients();

    if (clientArg && clientArg !== "all") {
      const client = clients.find((c) => c.id === clientArg);
      if (!client) {
        console.error(`Unknown client: ${clientArg}`);
        console.error(`Available: ${clients.map((c) => c.id).join(", ")}`);
        await gracefulExit(1);
        return;
      }
      try {
        await client.uninstall();
      } catch (err) {
        console.error(
          `Failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      await gracefulExit();
      return;
    }

    const installedClients = clients.filter((c) => c.isInstalled());
    if (installedClients.length === 0) {
      console.log("No gmax plugins currently installed.");
      await gracefulExit();
      return;
    }

    // No arg or "all": remove all installed
    for (const client of installedClients) {
      try {
        await client.uninstall();
      } catch (err) {
        console.error(
          `  FAIL  ${client.name} — ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    console.log(`\n${installedClients.length} plugin(s) removed.`);
    await gracefulExit();
  });

// --- Status (default action for bare `gmax plugin`) ---

async function statusAction() {
  const clients = getClients();
  console.log("gmax plugins\n");
  for (const client of clients) {
    const detected = client.detect();
    const installed = client.isInstalled();
    let status: string;
    if (installed) status = "✅ installed";
    else if (detected) status = "—  not installed";
    else status = "—  not found";
    console.log(`  ${client.name.padEnd(16)} ${status}`);
  }
  console.log("\nCommands:");
  console.log("  gmax plugin add               Install all detected clients");
  console.log("  gmax plugin add <client>      Install a specific client");
  console.log("  gmax plugin remove            Remove all installed plugins");
  console.log("  gmax plugin remove <client>   Remove a specific plugin");
  await gracefulExit();
}

export const plugin = new Command("plugin")
  .description("Manage gmax plugins for AI coding clients")
  .action(statusAction)
  .addCommand(addCmd)
  .addCommand(removeCmd);
