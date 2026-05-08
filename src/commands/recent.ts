import { Command } from "commander";

export const recent = new Command("recent")
  .description("[deprecated] Use 'gmax log' instead")
  .allowUnknownOption(true)
  .allowExcessArguments(true)
  .action(() => {
    console.error(
      "gmax recent is deprecated; use 'gmax log <path-or-symbol>' instead",
    );
    process.exitCode = 1;
  });
