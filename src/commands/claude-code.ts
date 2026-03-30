import * as fs from "node:fs";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { Command } from "commander";

function runClaudeCommand(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("claude", ["plugin", ...args], {
      env: process.env,
      stdio: "inherit",
    });

    child.on("error", (error) => reject(error));
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`claude exited with code ${code ?? "unknown"}`));
      }
    });
  });
}

/**
 * Resolve the gmax package root directory.
 * Works for both npm global installs (symlinked binary) and dev mode.
 * __dirname at runtime is dist/commands/, so go up two levels.
 */
function getPackageRoot(): string {
  return path.resolve(__dirname, "../..");
}

async function installPlugin() {
  try {
    const packageRoot = getPackageRoot();
    const marketplacePath = path.resolve(packageRoot);

    // Verify the marketplace.json exists at the package root
    const marketplaceJson = path.join(
      marketplacePath,
      ".claude-plugin",
      "marketplace.json",
    );
    if (!fs.existsSync(marketplaceJson)) {
      console.error(
        `❌ Could not find marketplace.json at ${marketplaceJson}`,
      );
      console.error("   Is gmax installed correctly?");
      process.exitCode = 1;
      return;
    }

    console.log(`Installing plugin from ${marketplacePath}`);

    // Remove old GitHub-based marketplace if present (ignore errors)
    try {
      await runClaudeCommand(["marketplace", "remove", "grepmax"]);
    } catch {
      // May not exist — fine
    }

    // Add local package directory as marketplace source
    await runClaudeCommand(["marketplace", "add", marketplacePath]);
    console.log("✔ Marketplace registered (local)");

    // Install the plugin from the local marketplace
    await runClaudeCommand(["install", "grepmax"]);
    console.log("✅ Successfully installed the gmax plugin for Claude Code");

    console.log("\nNext steps:");
    console.log("1. Restart Claude Code if it's running");
    console.log(
      "2. Run `gmax add` in your project to index it",
    );
    console.log(
      "3. Claude will use gmax for semantic code search automatically",
    );
    console.log(
      "\nTo update the plugin after upgrading gmax:");
    console.log(
      "  gmax install-claude-code",
    );
  } catch (error) {
    console.error("❌ Error installing plugin:");
    console.error(error);
    console.error("\nTroubleshooting:");
    console.error(
      "- Ensure you have Claude Code version 2.0.36 or higher installed",
    );
    console.error("- Try running: claude plugin marketplace list");
    process.exitCode = 1;
  }
}

export const installClaudeCode = new Command("install-claude-code")
  .description("Install the Claude Code plugin")
  .action(async () => {
    await installPlugin();
  });
