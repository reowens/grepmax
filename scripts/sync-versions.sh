#!/usr/bin/env bash
set -euo pipefail

# Sync plugin and marketplace versions with package.json
VERSION=$(node -p "require('./package.json').version")
echo "Syncing version: $VERSION"

# plugin.json
jq --arg v "$VERSION" '.version = $v' plugins/osgrep/.claude-plugin/plugin.json > /tmp/plugin.json.tmp
mv /tmp/plugin.json.tmp plugins/osgrep/.claude-plugin/plugin.json

# marketplace.json
jq --arg v "$VERSION" '.plugins[0].version = $v' .claude-plugin/marketplace.json > /tmp/marketplace.json.tmp
mv /tmp/marketplace.json.tmp .claude-plugin/marketplace.json

echo "Done. plugin.json and marketplace.json now at v$VERSION"
