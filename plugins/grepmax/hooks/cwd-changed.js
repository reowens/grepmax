const {
  ensureSessionLease,
  readHookInput,
  registeredRootFor,
  releaseSessionLeases,
} = require("./watch-lease");

// Keep the daemon watching the project this session is in now, and let go of
// the one it left. See watch-lease.js.
async function main() {
  const input = await readHookInput();
  const newCwd = input.new_cwd || input.cwd || process.cwd();
  const oldCwd = input.old_cwd;

  if (oldCwd) {
    const oldRoot = registeredRootFor(oldCwd);
    if (oldRoot && oldRoot !== registeredRootFor(newCwd)) {
      await releaseSessionLeases(input, oldCwd);
    }
  }

  await ensureSessionLease(input, newCwd, { allowStart: true });
}

main();
