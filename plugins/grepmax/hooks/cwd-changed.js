const { execFileSync } = require("node:child_process");
const {
  acquireSessionLease,
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

  if (!registeredRootFor(newCwd)) return;

  try {
    execFileSync("gmax", ["watch", "--daemon", "-b"], {
      timeout: 5000,
      stdio: "ignore",
    });
  } catch {
    try {
      execFileSync("gmax", ["watch", "-b"], { timeout: 5000, stdio: "ignore" });
    } catch {}
  }
  await acquireSessionLease(input, newCwd);
}

main();
