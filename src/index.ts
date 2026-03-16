#!/usr/bin/env node
import * as fs from "node:fs";
import * as path from "node:path";
import { program } from "commander";
import { installClaudeCode } from "./commands/claude-code";
import { installCodex } from "./commands/codex";
import { doctor } from "./commands/doctor";
import { installDroid, uninstallDroid } from "./commands/droid";
import { index } from "./commands/index";
import { list } from "./commands/list";
import { mcp } from "./commands/mcp";
import { installOpencode, uninstallOpencode } from "./commands/opencode";
import { search } from "./commands/search";
import { serve } from "./commands/serve";
import { setup } from "./commands/setup";
import { skeleton } from "./commands/skeleton";
import { symbols } from "./commands/symbols";
import { trace } from "./commands/trace";
import { watch } from "./commands/watch";

program
  .version(
    JSON.parse(
      fs.readFileSync(path.join(__dirname, "../package.json"), {
        encoding: "utf-8",
      }),
    ).version,
  )
  .option(
    "--store <string>",
    "The store to use (auto-detected if not specified)",
    process.env.GMAX_STORE || undefined,
  );

// Detect legacy per-project .gmax/ or .osgrep/ directories
const legacyProjectData = [".gmax", ".osgrep"]
  .map((d) => path.join(process.cwd(), d))
  .find((d) => fs.existsSync(path.join(d, "lancedb")));
if (legacyProjectData) {
  console.log(`⚠️  Legacy per-project index detected at ${legacyProjectData}`);
  console.log("   gmax now uses a centralized index at ~/.gmax/lancedb/.");
  console.log("   Run 'gmax index' to re-index into the centralized store.");
}

program.addCommand(search, { isDefault: true });
program.addCommand(index);
program.addCommand(list);
program.addCommand(skeleton);
program.addCommand(symbols);
program.addCommand(trace);
program.addCommand(setup);
program.addCommand(serve);
program.addCommand(watch);
program.addCommand(mcp);
program.addCommand(installClaudeCode);
program.addCommand(installCodex);
program.addCommand(installDroid);
program.addCommand(uninstallDroid);
program.addCommand(installOpencode);
program.addCommand(uninstallOpencode);
program.addCommand(doctor);

program.parse();
