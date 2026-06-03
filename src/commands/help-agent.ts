import { Command } from "commander";
import { AGENT_CHEATSHEET } from "../lib/help/agent-cheatsheet";

export const helpAgent = new Command("help-agent")
  .description(
    "Print the agent command cheatsheet (re-summon the SessionStart hint on demand)",
  )
  .addHelpText(
    "after",
    `
The same survey injected at SessionStart. Useful when a long session has
compacted away the original hint and you need to re-discover the commands.`,
  )
  .action(() => {
    process.stdout.write(`${AGENT_CHEATSHEET}\n`);
  });
