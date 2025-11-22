#!/usr/bin/env node
import * as fs from "node:fs";
import * as path from "node:path";
import { program } from "commander";
import { search } from "./commands/search";
import { watch } from "./commands/watch";
import { index } from "./commands/index";
import { installClaudeCode } from "./install/claude-code";
import { doctor } from "./commands/doctor";

// utility functions moved to ./utils

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
    "The store to use",
    process.env.MXBAI_STORE || "osgrep",
  );

program.addCommand(search, { isDefault: true });
program.addCommand(index);
// watch command is experimental - enable with OSGREP_ENABLE_WATCH=1
if (process.env.OSGREP_ENABLE_WATCH === "1") {
  program.addCommand(watch);
}
program.addCommand(installClaudeCode);
program.addCommand(doctor);

program.parse();
