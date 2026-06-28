const fs = require("node:fs");
const _path = require("node:path");
const { execFileSync } = require("node:child_process");

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
    // If no stdin arrives within 1s, proceed with empty input
    setTimeout(() => resolve({}), 1000);
  });
}

function isProjectRegistered(dir) {
  try {
    const projectsPath = _path.join(
      require("node:os").homedir(),
      ".gmax",
      "projects.json",
    );
    if (!fs.existsSync(projectsPath)) return false;
    const projects = JSON.parse(fs.readFileSync(projectsPath, "utf-8"));
    return projects.some((p) => dir.startsWith(p.root));
  } catch {
    return false;
  }
}

async function main() {
  const input = await readStdin();
  const newCwd = input.new_cwd || process.cwd();

  if (!isProjectRegistered(newCwd)) return;

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
}

main();
