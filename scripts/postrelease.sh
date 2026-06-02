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

echo "==> Installing grepmax@${VERSION} globally"
npm cache clean --force
npm install -g "grepmax@${VERSION}"

echo "==> Release ${TAG} complete"
