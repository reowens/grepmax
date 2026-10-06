import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";
import { Command } from "commander";

const execFileAsync = promisify(execFile);

async function runClaudeCommand(
  args: string[],
  options: { quiet?: boolean; cwd?: string } = {},
): Promise<string> {
  const { stdout, stderr } = await execFileAsync(
    "claude",
    ["plugin", ...args],
    {
      env: process.env,
      encoding: "utf8",
      timeout: 60_000,
      maxBuffer: 2 * 1024 * 1024,
      cwd: options.cwd,
    },
  );
  if (!options.quiet) {
    process.stdout.write(stdout);
    process.stderr.write(stderr);
  }
  return stdout;
}

function parseList(raw: string, label: string): Record<string, unknown>[] {
  const parsed: unknown = JSON.parse(raw);
  const key = label === "marketplace list" ? "name" : "id";
  if (
    !Array.isArray(parsed) ||
    parsed.some(
      (entry) =>
        !entry ||
        typeof entry !== "object" ||
        typeof entry[key] !== "string" ||
        !entry[key],
    )
  )
    throw new Error(
      `Unexpected Claude ${label} response; configuration preserved`,
    );
  return parsed as Record<string, unknown>[];
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
      console.error(`❌ Could not find marketplace.json at ${marketplaceJson}`);
      console.error("   Is gmax installed correctly?");
      process.exitCode = 1;
      return;
    }

    console.log(`Installing plugin from ${marketplacePath}`);

    // Query the CLI so account selection and CLAUDE_CONFIG_DIR match the client.
    // A failed/invalid inventory must never trigger a destructive reinstall.
    const marketplaces = parseList(
      await runClaudeCommand(["marketplace", "list", "--json"], {
        quiet: true,
      }),
      "marketplace list",
    );
    const installed = parseList(
      await runClaudeCommand(["list", "--json"], { quiet: true }),
      "plugin list",
    ).filter((entry) => entry.id === "grepmax@grepmax");
    const updates = installed.filter((entry) => entry.scope !== "managed");
    // Validate every target before even refreshing the source.
    for (const entry of updates) {
      if (!["user", "project", "local"].includes(String(entry.scope)))
        throw new Error(
          "Unknown gmax installation scope; configuration preserved",
        );
      if (
        entry.scope !== "user" &&
        (typeof entry.projectPath !== "string" ||
          !fs.existsSync(entry.projectPath))
      )
        throw new Error(
          "Missing gmax installation project; configuration preserved",
        );
    }
    if (installed.length > 0 && updates.length === 0) {
      console.log(
        "gmax is managed by your administrator; installation preserved.",
      );
      return;
    }
    if (marketplaces.some((entry) => entry.name === "grepmax")) {
      // Retain the user's chosen source, including GitHub or another npm prefix.
      // Retargeting by removing a marketplace also deletes plugin-owned state.
      await runClaudeCommand(["marketplace", "update", "grepmax"]);
      console.log("✔ Marketplace refreshed (existing source preserved)");
    } else {
      await runClaudeCommand(["marketplace", "add", marketplacePath]);
      console.log("✔ Marketplace registered (local)");
    }
    if (updates.length === 0) {
      await runClaudeCommand(["install", "grepmax@grepmax", "--scope", "user"]);
    } else {
      for (const entry of updates) {
        await runClaudeCommand(
          ["update", "grepmax@grepmax", "--scope", String(entry.scope)],
          {
            cwd: entry.scope === "user" ? undefined : String(entry.projectPath),
          },
        );
      }
    }
    console.log("✅ Successfully refreshed the gmax plugin for Claude Code");

    console.log("\nNext steps:");
    console.log("1. Restart Claude Code if it's running");
    console.log("2. Run `gmax add` in your project to index it");
    console.log(
      "3. Claude will use gmax for semantic code search automatically",
    );
    console.log("\nTo update the plugin after upgrading gmax:");
    console.log("  gmax install-claude-code");
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
