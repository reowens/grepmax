const { readFileSync } = require("node:fs");
const _path = require("node:path");

function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => {
      try {
        resolve(JSON.parse(data));
      } catch {
        resolve({});
      }
    });
    setTimeout(() => resolve({}), 1000);
  });
}

function isProjectRegistered() {
  try {
    const projectsPath = _path.join(
      require("node:os").homedir(),
      ".gmax",
      "projects.json",
    );
    const projects = JSON.parse(readFileSync(projectsPath, "utf-8"));
    const cwd = process.cwd();
    return projects.some((p) => cwd.startsWith(p.root));
  } catch {
    return false;
  }
}

// Agents that already know about gmax or can't use Bash
const SKIP_AGENT_TYPES = [
  "grepmax:semantic-explore",
  "statusline-setup",
];

async function main() {
  const input = await readStdin();
  const agentType = input.agent_type || "";

  // Don't inject into our own agent or agents that can't use gmax
  if (SKIP_AGENT_TYPES.some((t) => agentType.includes(t))) return;

  // Only inject if the current project is indexed (no point otherwise)
  if (!isProjectRegistered()) return;

  const response = {
    hookSpecificOutput: {
      hookEventName: "SubagentStart",
      additionalContext:
        'gmax semantic search is available. Use Bash(gmax "query" --agent) for concept search, Bash(gmax peek <symbol>) for overview, Bash(gmax extract <symbol>) for full body, Bash(gmax trace <symbol>) for call graph.',
    },
  };
  process.stdout.write(JSON.stringify(response));
}

main();
