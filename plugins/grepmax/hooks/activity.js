const { ensureSessionLease, readHookInput } = require("./watch-lease");

// Bounded renewal on turns and Bash activity keeps long CLI sessions watched.
// No detached timer, global watcher or additional MCP process is needed.
async function main() {
  const input = await readHookInput();
  await ensureSessionLease(input, input.cwd || process.cwd(), {
    allowStart: true,
  });
}

main();
