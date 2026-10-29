const { ensureSessionLease, readHookInput, registeredRootFor } = require("./watch-lease");
const { getRepoStatus, formatRepoContext } = require("./repo-status");

async function main() {
  const input = await readHookInput();
  const cwd = input.cwd || process.cwd();
  // Preserve existing ownership. Discovery never acquires a lease or starts
  // anything, and a watch lease does not advertise an MCP tool.
  if (registeredRootFor(cwd))
    await ensureSessionLease(input, cwd, { allowStart: true });
  const status = await getRepoStatus(cwd);
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: formatRepoContext(status),
    },
  }));
}

main();
