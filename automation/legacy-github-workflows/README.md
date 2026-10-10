# Preserved GitHub workflows

These six workflow files were moved intact from `.github/workflows/` on October 10,
2026 at the user's direction. They are reference material, not active automation.
GitHub Actions is disabled for this repository. Do not restore workflows, trigger
Actions or wait for GitHub CI.

Checks run locally in the repository. The source suite is `pnpm test`; Python tests
are `pnpm run test:python`; Rust tests are `cargo test --locked --manifest-path
lance-maintenance/native/Cargo.toml`. The script tests use `node --test
scripts/test-ci-changes.cjs scripts/test-ci-billing.cjs scripts/test-ci-usage.cjs
scripts/test-depot-usage.cjs`. Platform acceptance and packed-consumer checks remain
in their existing scripts. MLX HTTP contract tests use the locked MLX environment
with `GMAX_TEST_MLX=1` and do not load model weights.

`pnpm run release:check` is an explicit local release check. Publication uses local
npm authentication after local checks and qualified-artifact validation. The version
hook pushes without watching CI; it does not publish or install automatically.
Installation is an explicit local step. Preserve accepted native binaries with
matching source, capabilities and acceptance evidence; do not rebuild unchanged
native code solely for a tag.

Any future Depot execution must run independently of GitHub Actions and requires
separate implementation. These archived YAML files have not been converted into a
Depot provider or a local workflow runner.
