// Skip expensive jobs only when the complete Git diff proves Markdown-only changes.
// Missing history, malformed events and manual dispatch all run the full checks.
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");

function scope(eventName, event) {
  if (eventName === "workflow_dispatch") {
    return { runChecks: true, reason: "manual dispatch" };
  }
  const base = eventName === "push" ? event.before
    : eventName === "pull_request" ? event.pull_request?.base?.sha : null;
  if (!/^[0-9a-f]{40}$/i.test(base ?? "") || /^0+$/.test(base)) {
    return { runChecks: true, reason: "no proven comparison base" };
  }
  const git = args => spawnSync("git", args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  if (git(["cat-file", "-e", `${base}^{commit}`]).status !== 0 &&
      git(["fetch", "--no-tags", "--depth=1", "origin", base]).status !== 0) {
    return { runChecks: true, reason: "comparison history unavailable" };
  }
  // Disabling rename detection keeps the old source path when it moves into docs.
  const diff = git(["diff", "--name-only", "--no-renames", "-z", base, "HEAD", "--"]);
  if (diff.status !== 0 || typeof diff.stdout !== "string") {
    return { runChecks: true, reason: "comparison failed" };
  }
  const files = diff.stdout.split("\0").filter(Boolean);
  const documentation = file =>
    (file.startsWith("docs/") && file.endsWith(".md")) || /^[^/]+\.md$/.test(file);
  const docsOnly = files.length > 0 && files.every(documentation);
  return {
    runChecks: !docsOnly,
    reason: docsOnly ? "documentation-only diff" : "source, configuration or unclassified changes",
    changedFiles: files.length,
  };
}

if (require.main === module) {
  let result;
  try {
    const event = JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
    result = scope(process.env.GITHUB_EVENT_NAME, event);
  } catch {
    result = { runChecks: true, reason: "change classification unavailable" };
  }
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `run_checks=${result.runChecks}\n`);
  console.log(JSON.stringify(result));
}

module.exports = { scope };
