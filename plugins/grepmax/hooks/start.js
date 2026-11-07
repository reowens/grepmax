const {
  ensureSessionLease,
  isAutostartDisabled,
  readHookInput,
  registeredRootFor,
} = require("./watch-lease");
const { getRepoStatus, formatRepoContext } = require("./repo-status");

async function main() {
  const input = await readHookInput();
  const cwd = input.cwd || process.cwd();
  // Preserve existing ownership. Discovery never acquires a lease or starts
  // anything, and a watch lease does not advertise an MCP tool. Both steps
  // are bounded, so they run side by side.
  const leasing = registeredRootFor(cwd)
    ? ensureSessionLease(input, cwd, { allowStart: true })
    : null;
  const [leased, status] = await Promise.all([leasing, getRepoStatus(cwd)]);
  let context = formatRepoContext(status);
  if (leasing && !leased && input.session_id && !isAutostartDisabled())
    context +=
      "\nGmax has not confirmed this session's watch lease yet (daemon offline, starting or slow to answer); later activity retries it.";
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: context,
    },
  }));
}

main();
