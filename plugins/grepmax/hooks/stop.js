try {
  const { execFileSync } = require("node:child_process");
  execFileSync("gmax", ["watch", "stop"], { timeout: 5000, stdio: "ignore" });
} catch {
  // Watcher may not be running or gmax not in PATH — ignore
}
