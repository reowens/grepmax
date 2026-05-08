import { Command } from "commander";

export const diff = new Command("diff")
  .description("[deprecated] Use 'gmax log' instead")
  .argument("[ref]", "(ignored — diff is deprecated)")
  .allowUnknownOption(true)
  .allowExcessArguments(true)
  .action(() => {
    console.error(
      "gmax diff is deprecated; use 'gmax log <path-or-symbol>' instead",
    );
    process.exitCode = 1;
  });
