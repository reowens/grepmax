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
  echo "         npm install -g --prefer-online grepmax@${VERSION}" >&2
  exit 1
fi

echo "==> Watching run ${RUN_ID}"
gh run watch "${RUN_ID}" --exit-status

# `gh run watch` returns the instant CI marks the publish job done, but npm's
# registry CDN takes a while longer to serve the new version to a fresh install.
# Installing immediately races that propagation and loses with
# `ETARGET No matching version found` (v0.17.14, v0.26.32, v0.26.33).
#
# Poll the document `npm install` actually reads: the abbreviated packument
# (Accept: application/vnd.npm.install-v1+json). `npm view` reads the full
# packument, a separate CDN object that can go live first, so passing that poll
# never proved an install would resolve — on v0.26.32 and v0.26.33 all five
# installs (~25s) still failed after it. The query string defeats CDN caching
# of the poll itself.
install_doc_has_version() {
  curl -fsS --max-time 10 -H 'Accept: application/vnd.npm.install-v1+json' \
    "https://registry.npmjs.org/grepmax?t=$(date +%s)" 2>/dev/null |
    node -e '
      let s = "";
      process.stdin.on("data", (d) => (s += d)).on("end", () => {
        try { process.exit(JSON.parse(s).versions[process.argv[1]] ? 0 : 1); }
        catch { process.exit(1); }
      });
    ' "${VERSION}"
}

echo "==> Waiting for grepmax@${VERSION} to propagate to the npm registry"
VISIBLE=""
for i in $(seq 1 60); do
  if install_doc_has_version; then
    echo "    visible to npm install (after ${i} poll(s))"
    VISIBLE=1
    break
  fi
  sleep 5
done
if [ -z "${VISIBLE}" ]; then
  echo "    not visible after ~5 min — trying the install anyway" >&2
fi

# --prefer-online revalidates every cached packument, so an attempt that ran
# before propagation cannot leave a stale document for the next one to reuse.
echo "==> Installing grepmax@${VERSION} globally"
npm cache clean --force
INSTALLED=""
for i in $(seq 1 6); do
  if npm install -g --prefer-online "grepmax@${VERSION}"; then
    INSTALLED=1
    break
  fi
  echo "    install attempt ${i} failed (registry propagation lag?) — retrying in 20s" >&2
  sleep 20
done

if [ -z "${INSTALLED}" ]; then
  echo "ERROR: global install of grepmax@${VERSION} failed after 6 attempts." >&2
  echo "       The release itself is live (pushed, GH release cut, npm published)." >&2
  echo "       Finish manually once propagated:" >&2
  echo "         npm install -g --prefer-online grepmax@${VERSION}" >&2
  echo "       Then hand the daemon over (graceful, version-mismatch path):" >&2
  echo "         gmax watch --daemon -b" >&2
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
