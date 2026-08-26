#!/usr/bin/env bash
set -euo pipefail

# Runs as npm `postversion`: push the just-tagged release, cut the GitHub
# release, wait for the release.yml CI run (which publishes to npm), then
# install the freshly-published version globally.
#
# Why a poll loop instead of `sleep 5 && gh run watch $(gh run list ...)`:
# the tag push triggers release.yml, but the run can take several seconds to
# register with the API. A flat sleep races that registration and loses — when
# `gh run list` returns empty, `gh run watch` gets no run id and the whole
# chain aborts *before* the global install (observed on v0.17.10 and v0.17.11).
# Polling for the run id makes the wait robust to that registration latency.

VERSION="${npm_package_version:-$(node -p "require('./package.json').version")}"
TAG="v${VERSION}"

echo "==> Pushing main + ${TAG}"
git push origin main
git push origin "${TAG}"

echo "==> Creating GitHub release ${TAG}"
gh release create "${TAG}" --generate-notes --title "${TAG}"

echo "==> Waiting for release.yml run on ${TAG}"
RUN_ID=""
for i in $(seq 1 30); do
  RUN_ID="$(gh run list --workflow=release.yml --branch "${TAG}" --limit 1 \
    --json databaseId --jq '.[0].databaseId // empty' 2>/dev/null || true)"
  if [ -n "${RUN_ID}" ]; then
    echo "    found run ${RUN_ID} (after ${i} poll(s))"
    break
  fi
  sleep 3
done

if [ -z "${RUN_ID}" ]; then
  echo "ERROR: no release.yml run appeared for ${TAG} after ~90s." >&2
  echo "       Inspect with: gh run list --workflow=release.yml" >&2
  echo "       Then finish manually once CI is green:" >&2
  echo "         npm cache clean --force && npm install -g grepmax@${VERSION}" >&2
  exit 1
fi

echo "==> Watching run ${RUN_ID}"
gh run watch "${RUN_ID}" --exit-status

# `gh run watch` returns the instant CI marks the publish job done, but npm's
# registry CDN takes a few more seconds to serve the new version to a fresh
# install. Installing immediately races that propagation and loses with
# `ETARGET No matching version found` (observed on v0.17.14). Poll `npm view`
# until the version is actually servable, then install with a retry backstop.
echo "==> Waiting for grepmax@${VERSION} to propagate to the npm registry"
for i in $(seq 1 30); do
  PUBLISHED="$(npm view "grepmax@${VERSION}" version 2>/dev/null || true)"
  if [ "${PUBLISHED}" = "${VERSION}" ]; then
    echo "    visible on registry (after ${i} poll(s))"
    break
  fi
  sleep 3
done

echo "==> Installing grepmax@${VERSION} globally"
npm cache clean --force
INSTALLED=""
for i in $(seq 1 5); do
  if npm install -g --allow-scripts=grepmax "grepmax@${VERSION}"; then
    INSTALLED=1
    break
  fi
  echo "    install attempt ${i} failed (registry propagation lag?) — retrying in 5s" >&2
  sleep 5
done

if [ -z "${INSTALLED}" ]; then
  echo "ERROR: global install of grepmax@${VERSION} failed after 5 attempts." >&2
  echo "       The release itself is live (pushed, GH release cut, npm published)." >&2
  echo "       Finish manually once propagated:" >&2
  echo "         npm cache clean --force && npm install -g grepmax@${VERSION}" >&2
  echo "       Then restart the daemon: pkill -x gmax-daemon; gmax watch --daemon -b" >&2
  exit 1
fi

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
if pgrep -x gmax-daemon >/dev/null 2>&1; then
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

echo "==> Release ${TAG} complete"
