// Session watch leases for the hooks.
//
// The daemon only watches projects that some session holds a lease on (see
// src/lib/daemon/watch-leases.ts). The MCP server holds the long-lived one; the
// hooks take a session lease so a project is watched from the first moment of a
// session, and drop it at SessionEnd. A hook cannot import from dist, so this
// speaks the daemon's one-line JSON protocol directly.
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");

const GMAX_DIR = path.join(os.homedir(), ".gmax");
const SOCKET = path.join(GMAX_DIR, "daemon.sock");

// Long enough to cover a session without an MCP server; SessionEnd releases it
// early, and the daemon caps any lease at 12h.
const SESSION_LEASE_TTL_MS = 4 * 60 * 60 * 1000;

function readHookInput(timeoutMs = 1000) {
  return new Promise((resolve) => {
    let data = "";
    const done = () => {
      // An open stdin would otherwise keep the hook alive until its timeout.
      process.stdin.destroy();
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        resolve({});
      }
    };
    const timer = setTimeout(done, timeoutMs);
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => {
      clearTimeout(timer);
      done();
    });
    process.stdin.on("error", () => {
      clearTimeout(timer);
      done();
    });
  });
}

function isWithin(root, dir) {
  const rel = path.relative(root, dir);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** The most specific registered project containing `dir`, or null. */
function registeredRootFor(dir) {
  try {
    const projects = JSON.parse(
      fs.readFileSync(path.join(GMAX_DIR, "projects.json"), "utf-8"),
    );
    const resolved = path.resolve(dir);
    const matches = projects
      .filter((p) => p && typeof p.root === "string")
      .filter((p) => isWithin(path.resolve(p.root), resolved))
      .sort((a, b) => b.root.length - a.root.length);
    return matches.length > 0 ? matches[0].root : null;
  } catch {
    return null;
  }
}

function sendOnce(cmd, timeoutMs) {
  return new Promise((resolve) => {
    const socket = net.connect(SOCKET);
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(result);
    };
    const timer = setTimeout(
      () => finish({ ok: false, retry: false }),
      timeoutMs,
    );
    let buf = "";
    socket.on("connect", () => socket.write(`${JSON.stringify(cmd)}\n`));
    socket.on("data", (chunk) => {
      buf += chunk;
      const newline = buf.indexOf("\n");
      if (newline === -1) return;
      let resp = {};
      try {
        resp = JSON.parse(buf.slice(0, newline));
      } catch {}
      finish({
        ok: resp.ok === true,
        resp,
        // A daemon the hook just spawned answers before its stores are open.
        retry: resp.error === "daemon initializing",
      });
    });
    socket.on("error", (err) =>
      finish({
        ok: false,
        retry: err.code === "ENOENT" || err.code === "ECONNREFUSED",
      }),
    );
  });
}

/**
 * Send one command, retrying while the daemon is still coming up (the hook may
 * have just spawned it). Never throws — a hook must not fail the session.
 */
async function sendDaemonLine(cmd, deadlineMs = 3000) {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return null;
    const result = await sendOnce(cmd, Math.min(remaining, 2000));
    if (result.ok) return result.resp;
    if (!result.retry) return null;
    await new Promise((r) => setTimeout(r, 200));
  }
}

function sessionHolder(input) {
  const id =
    input && typeof input.session_id === "string" ? input.session_id : "";
  return id ? `session:${id}` : null;
}

async function acquireSessionLease(input, dir) {
  const holder = sessionHolder(input);
  const root = registeredRootFor(dir);
  if (!holder || !root) return false;
  const resp = await sendDaemonLine({
    cmd: "watch",
    root,
    holder,
    ttlMs: SESSION_LEASE_TTL_MS,
  });
  return resp !== null;
}

async function releaseSessionLeases(input, dir) {
  const holder = sessionHolder(input);
  const root = registeredRootFor(dir);
  if (!holder || !root) return false;
  // Only release against a live daemon that understands leases: an older one
  // reads `unwatch` as "stop watching for everyone".
  const ping = await sendDaemonLine({ cmd: "ping" }, 1000);
  if (!ping?.capabilities?.watchLeases) return false;
  const resp = await sendDaemonLine({ cmd: "unwatch", root, holder }, 1000);
  return resp !== null;
}

module.exports = {
  acquireSessionLease,
  readHookInput,
  registeredRootFor,
  releaseSessionLeases,
};
