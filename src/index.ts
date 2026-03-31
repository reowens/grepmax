#!/usr/bin/env node
import * as fs from "node:fs";
import * as path from "node:path";
import { program } from "commander";
import { add } from "./commands/add";
import { installClaudeCode } from "./commands/claude-code";
import { installCodex } from "./commands/codex";
import { config } from "./commands/config";
import { doctor } from "./commands/doctor";
import { extract } from "./commands/extract";
import { installDroid, uninstallDroid } from "./commands/droid";
import { index } from "./commands/index";
import { list } from "./commands/list";
import { mcp } from "./commands/mcp";
import { peek } from "./commands/peek";
import { project } from "./commands/project";
import { recent } from "./commands/recent";
import { related } from "./commands/related";
import { installOpencode, uninstallOpencode } from "./commands/opencode";
import { remove } from "./commands/remove";
import { search } from "./commands/search";
import { serve } from "./commands/serve";
import { setup } from "./commands/setup";
import { skeleton } from "./commands/skeleton";
import { summarize } from "./commands/summarize";
import { status } from "./commands/status";
import { symbols } from "./commands/symbols";
import { trace } from "./commands/trace";
import { watch } from "./commands/watch";

program
  .name("gmax")
  .description(
    "Semantic code search — finds code by meaning, not just strings",
  )
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

// Core commands
program.addCommand(search, { isDefault: true });
program.addCommand(add);
program.addCommand(remove);
program.addCommand(index);
program.addCommand(status);
program.addCommand(list);
program.addCommand(skeleton);
program.addCommand(symbols);
program.addCommand(trace);
program.addCommand(extract);
program.addCommand(peek);
program.addCommand(project);
program.addCommand(related);
program.addCommand(recent);

// Services
program.addCommand(serve);
program.addCommand(watch);
program.addCommand(mcp);
program.addCommand(summarize);

// Setup & diagnostics
program.addCommand(setup);
program.addCommand(config);
program.addCommand(doctor);

// Plugin installers
program.addCommand(installClaudeCode);
program.addCommand(installCodex);
program.addCommand(installDroid);
(uninstallDroid as any)._hidden = true;
program.addCommand(uninstallDroid);
program.addCommand(installOpencode);
(uninstallOpencode as any)._hidden = true;
program.addCommand(uninstallOpencode);

program.parse();
