#!/usr/bin/env bash
set -euo pipefail

# The version hook pushes and returns immediately. Qualification stays local;
# the explicit release.yml dispatch publishes through the npm trusted publisher.
# Once the package exists, use --install for one install and normal handover.
VERSION="${npm_package_version:-$(node -p "require('./package.json').version")}"
TAG="v${VERSION}"

# A host whose daemon is the gmax.service systemd user unit must get the new
# build where that unit loads it from, which need not be `npm prefix -g`, and the
# handover must go through systemd so the daemon stays inside the unit's cgroup
# and limits. Hosts without systemd, a user bus or the unit keep the plain path.
UNIT=""
UNIT_ACTIVE=""
UNIT_PREFIX=""
UNIT_NODE_DIR=""
UNIT_NPM="npm"
unit_prop() {
  systemctl --user show gmax.service -p "$1" --value 2>/dev/null || true
}
detect_unit() {
  command -v systemctl >/dev/null 2>&1 || return 0
  [ "$(unit_prop LoadState)" = "loaded" ] || return 0
  UNIT_ACTIVE="$(unit_prop ActiveState)"
  local file_state exec_start entry node
  file_state="$(unit_prop UnitFileState)"
  [ "${UNIT_ACTIVE}" = "active" ] || [ "${file_state}" = "enabled" ] || return 0
  UNIT="gmax.service"
  exec_start="$(unit_prop ExecStart)"
  entry="$(printf '%s\n' "${exec_start}" | grep -oE '[^ ;"=]*/lib/node_modules/grepmax/dist/bin\.js' | head -n 1 || true)"
  if [ -z "${entry}" ]; then
    echo "WARN: cannot find grepmax/dist/bin.js in ${UNIT} ExecStart; installing into the default prefix." >&2
    return 0
  fi
  UNIT_PREFIX="${entry%/lib/node_modules/grepmax/dist/bin.js}"
  node="$(printf '%s\n' "${exec_start}" | sed -nE 's/.*path=([^ ;]+).*/\1/p' | head -n 1 || true)"
  if [ -n "${node}" ] && [ -x "$(dirname "${node}")/npm" ]; then
    UNIT_NODE_DIR="$(dirname "${node}")"
    UNIT_NPM="${UNIT_NODE_DIR}/npm"
  fi
}

case "${1:-}" in
  "")
    echo "==> Pushing main + ${TAG}"
    git push origin main
    git push origin "${TAG}"
    echo "==> ${TAG} pushed; publication uses GitHub trusted publishing."
    echo "    Check locally: pnpm run release:check"
    echo "    Attach the qualified archive and source receipt to a draft GitHub release."
    echo "    Dispatch release.yml with the reviewed version, source commit and archive SHA256."
    echo "    After publication: bash scripts/postrelease.sh --install"
    exit 0
    ;;
  --install)
    detect_unit
    echo "==> Installing published grepmax@${VERSION}"
    # A missing version or failed install is an actionable failure, not a poll loop.
    # Revalidate cached metadata without clearing unrelated npm cache entries.
    if [ -n "${UNIT}" ] && [ -n "${UNIT_PREFIX}" ]; then
      echo "    into ${UNIT_PREFIX}, where ${UNIT} loads grepmax from"
      PATH="${UNIT_NODE_DIR:+${UNIT_NODE_DIR}:}${PATH}" "${UNIT_NPM}" install -g --prefix "${UNIT_PREFIX}" \
        --prefer-online "grepmax@${VERSION}"
    else
      npm install -g --prefer-online "grepmax@${VERSION}"
    fi
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

# Under the systemd unit the handover is `systemctl --user restart`, which stops
# the daemon within the unit's TimeoutStopSec and starts the new build with the
# unit's limits. An enabled unit that is not running was stopped on purpose.
confirm_version() {
  for i in $(seq 1 30); do
    RUNNING="$(daemon_version || true)"
    if [ "${RUNNING}" = "${VERSION}" ]; then
      echo "    daemon serving ${VERSION} (confirmed over IPC)"
      return 0
    fi
    if [ "${i}" -eq 30 ]; then
      echo "WARN: daemon reports '${RUNNING:-no response}', expected ${VERSION}." >&2
      echo "      Restart manually: $1" >&2
    fi
    sleep 1
  done
}

if daemon_start_denied; then
  echo "==> Host quarantine is active — preserving it and skipping daemon restart"
elif [ -n "${UNIT}" ]; then
  if [ "${UNIT_ACTIVE}" != "active" ]; then
    echo "==> ${UNIT} is not active; skipping restart"
  else
    echo "==> Restarting ${UNIT} onto ${VERSION}"
    if systemctl --user restart "${UNIT}"; then
      confirm_version "systemctl --user restart ${UNIT}"
    else
      echo "WARN: systemctl --user restart ${UNIT} failed; the daemon may still run the previous build." >&2
      echo "      Restart manually: systemctl --user restart ${UNIT}" >&2
    fi
  fi
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
