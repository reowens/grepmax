const { readHookInput } = require("./watch-lease");
const { getRepoStatus, formatRepoContext } = require("./repo-status");

const SKIP_AGENT_TYPES = ["grepmax:semantic-explore", "statusline-setup"];

async function main() {
  const input = await readHookInput();
  const agentType = input.agent_type || "";
  if (SKIP_AGENT_TYPES.some((type) => agentType.includes(type))) return;
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "SubagentStart",
      additionalContext: formatRepoContext(await getRepoStatus(input.cwd || process.cwd())),
    },
  }));
}

main();
