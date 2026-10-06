import * as os from "node:os";
import * as path from "node:path";

export function codexAgentsPath(): string {
  const home = process.env.CODEX_HOME
    ? path.resolve(process.env.CODEX_HOME)
    : path.join(os.homedir(), ".codex");
  return path.join(home, "AGENTS.md");
}
