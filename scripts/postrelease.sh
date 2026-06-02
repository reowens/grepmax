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
  if npm install -g "grepmax@${VERSION}"; then
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

echo "==> Release ${TAG} complete"
