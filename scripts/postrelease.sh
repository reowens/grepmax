#!/usr/bin/env bash
set -euo pipefail

# The version hook pushes the release and returns immediately. Publication runs
# separately; do not keep the developer waiting on CI or registry propagation.
# Once the package exists, use --install for one install and normal handover.
VERSION="${npm_package_version:-$(node -p "require('./package.json').version")}"
TAG="v${VERSION}"

case "${1:-}" in
  "")
    echo "==> Pushing main + ${TAG}"
    git push origin main
    git push origin "${TAG}"
    echo "==> ${TAG} pushed; publication runs separately."
    echo "    After publication: bash scripts/postrelease.sh --install"
    exit 0
    ;;
  --install)
    echo "==> Installing published grepmax@${VERSION}"
    # A missing version or failed install is an actionable failure, not a poll loop.
    # Revalidate cached metadata without clearing unrelated npm cache entries.
    npm install -g --prefer-online "grepmax@${VERSION}"
    ;;
  *)
    echo "Usage: bash scripts/postrelease.sh [--install]" >&2
    exit 2
    ;;
esac

# Ask the running daemon what version it is serving, via the same `ping` IPC the
# CLI uses. Prints nothing and returns non-zero if no daemon answers.
daemon_version() {
  node -e '
    const net = require("node:net");
    const os = require("node:os");
    const path = require("node:path");
    const sock = path.join(os.homedir(), ".gmax", "daemon.sock");
    const conn = net.createConnection(sock);
    const bail = () => { conn.destroy(); process.exit(1); };
    const timer = setTimeout(bail, 3000);
    let buf = "";
    conn.on("connect", () => conn.write(JSON.stringify({ cmd: "ping" }) + "\n"));
    conn.on("data", (d) => {
      buf += d;
      const nl = buf.indexOf("\n");
      if (nl < 0) return;
      clearTimeout(timer);
      try {
        process.stdout.write(String(JSON.parse(buf.slice(0, nl)).version ?? ""));
      } catch {}
      conn.end();
      process.exit(0);
    });
    conn.on("error", bail);
  ' 2>/dev/null
}

# The global install puts the new binary on PATH, but a daemon started from the
# old one keeps running it — every command still talks to a stale daemon over
# the socket until something forces a handoff. Restarting here is what actually
# makes the release live.
#
# `gmax watch --daemon -b` is the graceful path: the new binary notices the
# version gap and asks the running daemon to shut down over IPC (logged as
# reason=version-mismatch), rather than signalling it mid-write. Only restart a
# daemon that is already up — starting one that the user had deliberately
# stopped would be a side effect of releasing, not part of it.
# A safety release must preserve host quarantine, including explicit handoff.
# Probe marker metadata only: never load gmax or open its index here.
daemon_start_denied() {
  node <<'NODE'
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
if (process.env.GMAX_NO_AUTOSTART === "1") process.exit(0);
const shared = path.join(os.homedir(), ".gmax");
const data = process.env.GMAX_HOME ? path.resolve(process.env.GMAX_HOME) : shared;
for (const marker of [path.join(shared, "safety-stop.json"), path.join(shared, "autostart-disabled"), path.join(data, "autostart-disabled")]) {
  try { fs.lstatSync(marker); process.exit(0); }
  catch (error) { if (error.code !== "ENOENT") process.exit(0); }
}
process.exit(1);
NODE
}

if daemon_start_denied; then
  echo "==> Host quarantine is active — preserving it and skipping daemon restart"
elif pgrep -x gmax-daemon >/dev/null 2>&1; then
  echo "==> Restarting daemon onto ${VERSION}"
  # Never fail the release here: the publish is already live and irreversible,
  # so a restart problem is a warning to act on, not a reason to exit non-zero.
  if gmax watch --daemon -b; then
    # Confirm against the daemon itself, not the binary: `gmax --version` prints
    # what is on PATH, which the install already updated, so it would report
    # success even if the old daemon were still serving the socket. The `ping`
    # IPC reply carries the running daemon's own version.
    for i in $(seq 1 10); do
      RUNNING="$(daemon_version || true)"
      if [ "${RUNNING}" = "${VERSION}" ]; then
        echo "    daemon serving ${VERSION} (confirmed over IPC)"
        break
      fi
      if [ "${i}" -eq 10 ]; then
        echo "WARN: daemon reports '${RUNNING:-no response}', expected ${VERSION}." >&2
        echo "      Restart manually: gmax watch --daemon -b" >&2
      fi
      sleep 1
    done
  else
    echo "WARN: daemon restart failed — it is still running the previous build." >&2
    echo "      Restart manually: gmax watch --daemon -b" >&2
  fi
else
  echo "==> No daemon running — skipping restart"
fi

echo "==> Global package installation for ${TAG} complete"
