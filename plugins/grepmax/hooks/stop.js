// Releases this session's watch lease. It never stops the daemon.
//
// This hook used to run `gmax watch stop` on every Claude SessionEnd. With
// multiple concurrent Claude sessions sharing one daemon, that meant *any*
// session ending killed the daemon for every *other* session — silently
// breaking their search/index and forcing repeated daemon restarts.
//
// Now it only drops the lease this session took at SessionStart. The daemon
// unwatches the project once no other session (or MCP server) holds it, and its
// own idle timeout handles shutdown when nothing is using it.
const { readHookInput, releaseSessionLeases } = require("./watch-lease");

async function main() {
  const input = await readHookInput();
  await releaseSessionLeases(input, input.cwd || process.cwd());
}

main();
