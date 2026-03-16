set dotenv-load

# Deploy the latest git tag to npm. Fails if HEAD is not tagged or already published.
deploy:
    #!/usr/bin/env bash
    set -euo pipefail

    if [[ -z "${NPM_TOKEN:-}" ]]; then
        echo "Error: NPM_TOKEN not set. Add it to .env"
        exit 1
    fi

    TAG=$(git describe --exact-match --tags HEAD 2>/dev/null || true)
    if [[ -z "$TAG" ]]; then
        echo "Error: HEAD is not tagged. Tag a release first: git tag v0.x.x"
        exit 1
    fi

    PKG_VERSION=$(node -p "require('./package.json').version")
    if [[ "v$PKG_VERSION" != "$TAG" ]]; then
        echo "Error: Tag $TAG does not match package.json version v$PKG_VERSION"
        exit 1
    fi

    PUBLISHED=$(npm view "grepmax@$PKG_VERSION" version 2>/dev/null || true)
    if [[ "$PUBLISHED" == "$PKG_VERSION" ]]; then
        echo "Error: v$PKG_VERSION is already published to npm"
        exit 1
    fi

    echo "Publishing grepmax@$PKG_VERSION..."
    pnpm build
    pnpm typecheck
    echo "//registry.npmjs.org/:_authToken=${NPM_TOKEN}" > .npmrc
    pnpm publish --access public --no-git-checks
    rm -f .npmrc
    echo "Published grepmax@$PKG_VERSION"
