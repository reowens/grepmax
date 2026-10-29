// Shared by packaged hooks, the lightweight CLI path and the MCP adapter.
// Built-ins only: discovery must never open a store, take a watch lease or start
// a daemon/model. Registry counts are cached evidence, not a freshness check.
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");

const PRIMARY_HOME = path.join(os.homedir(), ".gmax");
const MAX_METADATA_BYTES = 1024 * 1024;

function readJson(file) {
  const fd = fs.openSync(file, "r");
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_METADATA_BYTES)
      throw new Error("metadata unavailable");
    const buffer = Buffer.alloc(MAX_METADATA_BYTES + 1);
    const size = fs.readSync(fd, buffer, 0, buffer.length, 0);
    if (size > MAX_METADATA_BYTES) throw new Error("metadata too large");
    return JSON.parse(buffer.toString("utf8", 0, size));
  } finally {
    fs.closeSync(fd);
  }
}

function canonical(dir) {
  try { return fs.realpathSync(dir); } catch { return path.resolve(dir); }
}

function within(root, dir) {
  const rel = path.relative(root, dir);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

function repoRootFor(dir) {
  for (let current = dir; ; current = path.dirname(current)) {
    if (fs.existsSync(path.join(current, ".git"))) return current;
    if (current === path.dirname(current)) return dir;
  }
}

function selectedHome(cwd) {
  if (process.env.GMAX_HOME) return path.resolve(process.env.GMAX_HOME);
  let routes;
  try { routes = readJson(path.join(PRIMARY_HOME, "stores.json")); }
  catch (error) { if (error.code === "ENOENT") return PRIMARY_HOME; throw error; }
  if (!routes || !Array.isArray(routes.stores) || routes.stores.some((entry) =>
    !entry || typeof entry.prefix !== "string" || !path.isAbsolute(entry.prefix) ||
    typeof entry.home !== "string" || !path.isAbsolute(entry.home)))
    throw new Error("invalid store routes");
  const matches = routes.stores.filter((entry) => within(canonical(entry.prefix), cwd));
  matches.sort((a, b) => canonical(b.prefix).length - canonical(a.prefix).length);
  return matches.length ? matches[0].home : PRIMARY_HOME;
}

function readRepoStatus(dir = process.cwd()) {
  const cwd = canonical(dir);
  const result = {
    schemaVersion: 1, cwd, repoRoot: repoRootFor(cwd), matchedRoot: null,
    indexState: "unknown", source: "registry", cachedChunks: null,
    storeHome: null, daemon: { state: "unobserved" },
    mcp: "client_catalog_required", cliHint: null,
  };
  try {
    if (!fs.statSync(cwd).isDirectory()) return result;
    const home = selectedHome(cwd);
    result.storeHome = home;
    // A missing secondary store is not evidence that its repo is unregistered.
    if (home !== PRIMARY_HOME && !fs.existsSync(home)) {
      result.indexState = "store_unavailable";
      return result;
    }
    let projects;
    try { projects = readJson(path.join(home, "projects.json")); }
    catch (error) {
      if (error.code !== "ENOENT") throw error;
      result.indexState = "not_registered";
      return result;
    }
    if (!Array.isArray(projects) || projects.some((entry) =>
      !entry || typeof entry.root !== "string" || !path.isAbsolute(entry.root) ||
      (entry.status !== undefined && !["indexed", "pending", "error"].includes(entry.status)) ||
      (entry.chunkCount !== undefined && (!Number.isFinite(entry.chunkCount) || entry.chunkCount < 0))))
      throw new Error("invalid registry");
    const matches = projects.filter((entry) => within(canonical(entry.root), cwd));
    matches.sort((a, b) => canonical(b.root).length - canonical(a.root).length);
    const project = matches[0];
    if (!project) { result.indexState = "not_registered"; return result; }
    result.matchedRoot = project.root;
    result.indexState = project.status ?? "legacy_unknown";
    result.cachedChunks = project.chunkCount ?? null;
    if (result.indexState === "indexed" && result.cachedChunks !== 0)
      result.cliHint = `gmax "<concept>" --root '${project.root.replace(/'/g, "'\\''")}' --agent`;
    return result;
  } catch {
    result.indexState = "metadata_unavailable";
    return result;
  }
}

function probeDaemon(home) {
  return new Promise((resolve) => {
    const socket = net.connect(path.join(home, "daemon.sock"));
    let settled = false;
    let buffer = "";
    const finish = (state) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve({ state });
    };
    const timer = setTimeout(() => finish("unavailable"), 400);
    socket.on("connect", () => socket.write('{"cmd":"ping"}\n'));
    socket.on("data", (chunk) => {
      buffer += chunk;
      if (buffer.length > 16384) return finish("unavailable");
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      try {
        const response = JSON.parse(buffer.slice(0, newline));
        finish(!response.ok ? "unavailable" : response.ready === false ? "initializing" :
          response.service?.mode === "paused" ? "paused" :
          response.ready === true ? "ready" : "legacy_unknown");
      } catch { finish("unavailable"); }
    });
    socket.on("error", (error) => finish(
      ["ENOENT", "ECONNREFUSED"].includes(error.code) ? "offline" :
      ["EACCES", "EPERM"].includes(error.code) ? "denied" : "unavailable"));
    socket.on("end", () => finish("unavailable"));
  });
}

async function getRepoStatus(dir = process.cwd()) {
  const status = readRepoStatus(dir);
  if (status.matchedRoot && status.storeHome === PRIMARY_HOME && !process.env.GMAX_SECONDARY_STORE) {
    try { status.daemon = await probeDaemon(status.storeHome); }
    catch { status.daemon = { state: "unavailable" }; }
  }
  // Secondary stores deliberately have no resident daemon.
  return status;
}

function formatRepoContext(status) {
  const lines = [
    `Gmax current repo: ${JSON.stringify(status.repoRoot)}; index=${status.indexState}; matchedRoot=${JSON.stringify(status.matchedRoot)}; daemon=${status.daemon.state}.`,
  ];
  if (status.indexState === "not_registered")
    lines.push("Gmax is not set up for this repo. Other registered projects do not cover it; do not silently search another project. Adding/indexing requires separate authorization.");
  else if (status.indexState === "indexed")
    lines.push(`Registry reports indexed${status.cachedChunks === null ? "" : ` (${status.cachedChunks} cached chunks)`}; freshness and embedding compatibility are unverified.`);
  else
    lines.push("Current-repo search readiness is unverified. Pending, error, offline and legacy/unknown metadata do not mean the repo is not set up.");
  lines.push("MCP attachment is client-owned: use a Gmax tool only if it is advertised in your actual tool catalog. This hook/CLI hint does not register an MCP server.");
  if (status.daemon.state === "offline" || status.daemon.state === "paused" ||
      status.daemon.state === "initializing")
    lines.push("Daemon state does not establish query readiness. Do not start services or load models as part of discovery/status.");
  if (status.cliHint)
    lines.push(`For permitted semantic discovery, suggest an advertised Gmax semantic_search tool or this CLI command (requires gmax on PATH): ${status.cliHint}. Use rg for literal text/files. Explicit query limits and model/startup restrictions still apply.`);
  return lines.join("\n");
}

async function runStatusCli(args) {
  let cwd = process.cwd();
  let json = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--current" || arg === "--agent") continue;
    if (arg === "--json") { json = true; continue; }
    if (arg === "--cwd" && args[i + 1]) { cwd = args[++i]; continue; }
    process.stderr.write("Usage: gmax status --current [--cwd <directory>] [--json|--agent]\n");
    process.exitCode = 2;
    return;
  }
  const status = await getRepoStatus(cwd);
  process.stdout.write(`${json ? JSON.stringify(status) : formatRepoContext(status)}\n`);
}

module.exports = { readRepoStatus, getRepoStatus, formatRepoContext, runStatusCli };
