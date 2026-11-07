// Session watch leases for the hooks.
//
// Claude's CLI integration takes a lease at startup, renews it during activity,
// and releases it at SessionEnd. Other MCP clients own separate leases. A hook
// cannot import from dist, so this speaks the one-line Unix socket protocol.
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");

const GMAX_DIR = path.join(os.homedir(), ".gmax");
const SOCKET = path.join(GMAX_DIR, "daemon.sock");

// Activity refreshes this TTL; idle sessions do not watch forever.
const SESSION_LEASE_TTL_MS = 4 * 60 * 60 * 1000;
const SESSION_RENEW_INTERVAL_MS = SESSION_LEASE_TTL_MS / 4;
// The daemon records a lease as soon as the `watch` line arrives, but answers
// only after the project's watcher is up, which takes seconds for a large repo
// that is not watched yet. Hooks stop waiting after this; activity confirms it.
const LEASE_REPLY_MS = 400;

function socketIdentity() {
  try {
    const stat = fs.statSync(SOCKET);
    return `${stat.dev}:${stat.ino}:${stat.ctimeMs}`;
  } catch {
    return null;
  }
}

async function withSessionLeaseState(
  holder,
  root,
  action,
  deadline = Date.now() + 5000,
) {
  let file;
  let lock;
  let owner;
  try {
    const key = require("node:crypto")
      .createHash("sha256")
      .update(JSON.stringify([holder, root]))
      .digest("hex");
    const dir = path.join(GMAX_DIR, "hook-watch-leases");
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    file = path.join(dir, `${key}.json`);
    lock = path.join(dir, `${key}.lock`);
    owner = path.join(lock, String(process.pid));
    fs.mkdirSync(lock, { mode: 0o700 });
  } catch (error) {
    if (!lock || error.code !== "EEXIST") return action(null);
    // Only reclaim a dead hook's lock; live hooks finish within the IPC budget.
    try {
      const owners = fs.readdirSync(lock);
      if (owners.length === 0) {
        if (Date.now() - fs.statSync(lock).mtimeMs > 30_000) fs.rmdirSync(lock);
      } else if (owners.length === 1 && /^\d+$/.test(owners[0])) {
        try {
          process.kill(Number(owners[0]), 0);
        } catch (err) {
          if (err.code === "ESRCH") {
            fs.unlinkSync(path.join(lock, owners[0]));
            fs.rmdirSync(lock);
          }
        }
      }
    } catch {}
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 25));
    return withSessionLeaseState(holder, root, action, deadline);
  }
  try {
    fs.writeFileSync(owner, "", { flag: "wx", mode: 0o600 });
    return await action(file);
  } catch {
    return false;
  } finally {
    try {
      fs.unlinkSync(owner);
      fs.rmdirSync(lock);
    } catch {}
  }
}

function leaseRenewedRecently(file, daemon) {
  if (!file || !daemon) return false;
  try {
    const state = JSON.parse(fs.readFileSync(file, "utf8"));
    const age = Date.now() - state.renewedAt;
    return (
      state.daemon === daemon &&
      Number.isFinite(state.renewedAt) &&
      age >= 0 &&
      age < SESSION_RENEW_INTERVAL_MS
    );
  } catch {
    return false;
  }
}

function forgetSessionLease(file) {
  if (!file) return;
  try {
    fs.unlinkSync(file);
  } catch {}
}

function markerPresentOrUnknown(file) {
  try {
    fs.lstatSync(file);
    return true;
  } catch (error) {
    return error.code !== "ENOENT";
  }
}

function isAutostartDisabled() {
  if (
    process.env.GMAX_NO_AUTOSTART === "1" ||
    process.env.GMAX_GEMMA_PROFILE === "1"
  )
    return true;
  if (process.env.GMAX_HOME) {
    try {
      if (
        JSON.parse(
          fs.readFileSync(
            path.join(process.env.GMAX_HOME, "config.json"),
            "utf8",
          ),
        ).modelTier === "gemma2"
      )
        return true;
    } catch {}
  }
  return (
    markerPresentOrUnknown(path.join(GMAX_DIR, "autostart-disabled")) ||
    markerPresentOrUnknown(path.join(GMAX_DIR, "safety-stop.json"))
  );
}

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
        absent: err.code === "ENOENT" || err.code === "ECONNREFUSED",
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

async function acquireSessionLease(input, dir, deadlineMs = LEASE_REPLY_MS) {
  const holder = sessionHolder(input);
  const root = registeredRootFor(dir);
  if (!holder || !root) return false;
  const resp = await sendDaemonLine(
    { cmd: "watch", root, holder, ttlMs: SESSION_LEASE_TTL_MS },
    deadlineMs,
  );
  return resp !== null;
}

/** Reuse a lease-capable daemon; start one only after a definite absent socket. */
async function ensureSessionLease(
  input,
  dir,
  { allowStart = false, throttle = false } = {},
) {
  const holder = sessionHolder(input);
  const root = registeredRootFor(dir);
  if (isAutostartDisabled() || !holder || !root) return false;
  return withSessionLeaseState(holder, root, async (file) => {
    const daemon = socketIdentity();
    if (throttle && leaseRenewedRecently(file, daemon)) return true;
    forgetSessionLease(file);
    const renewedAt = Date.now();
    const ok = await ensureDaemonLease(input, dir, allowStart);
    const currentDaemon = socketIdentity();
    if (ok && file && currentDaemon && (!daemon || daemon === currentDaemon)) {
      try {
        fs.writeFileSync(
          file,
          JSON.stringify({ daemon: currentDaemon, renewedAt }),
          { mode: 0o600 },
        );
      } catch {}
    }
    return ok;
  });
}

async function ensureDaemonLease(input, dir, allowStart) {
  const started = Date.now();
  const ping = await sendOnce({ cmd: "ping" }, 500);
  if (ping.ok) {
    if (!ping.resp.capabilities?.watchLeases) return false;
    return acquireSessionLease(
      input,
      dir,
      Math.max(100, LEASE_REPLY_MS - (Date.now() - started)),
    );
  }
  // Busy, initializing, denied and timed-out sockets belong to an existing
  // daemon. Never start a per-project writer or replace that process here.
  if (!allowStart || !ping.absent) return false;
  try {
    const child = spawn("gmax", ["watch", "--daemon", "-b"], {
      detached: true,
      stdio: "ignore",
      cwd: dir,
      // Another session can win the race after the absent-socket probe. The
      // launcher must reuse that peer, even if its package version differs.
      env: { ...process.env, GMAX_DAEMON_START_ONLY: "1" },
    });
    await new Promise((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    child.unref();
  } catch {
    return false;
  }
  // A cold daemon takes seconds to answer. Later activity takes the lease once
  // it does, instead of this hook waiting or opening another watcher.
  return false;
}

async function releaseSessionLeases(input, dir) {
  const holder = sessionHolder(input);
  const root = registeredRootFor(dir);
  if (!holder || !root) return false;
  return withSessionLeaseState(holder, root, async (file) => {
    forgetSessionLease(file);
    return releaseDaemonLease(root, holder);
  });
}

async function releaseDaemonLease(root, holder) {
  // Only release against a live daemon that understands leases: an older one
  // reads `unwatch` as "stop watching for everyone".
  const ping = await sendDaemonLine({ cmd: "ping" }, 1000);
  if (!ping?.capabilities?.watchLeases) return false;
  const resp = await sendDaemonLine({ cmd: "unwatch", root, holder }, 1000);
  return resp !== null;
}

module.exports = {
  acquireSessionLease,
  ensureSessionLease,
  isAutostartDisabled,
  readHookInput,
  registeredRootFor,
  releaseSessionLeases,
};
