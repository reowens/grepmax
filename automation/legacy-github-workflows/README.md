# Preserved GitHub workflows

These six workflow files were moved intact from `.github/workflows/` on October 10,
2026 at the user's direction. They are reference material, not active automation.
GitHub Actions is currently disabled for this repository. The user has requested
a full review of CI requirements, including release-only CI and trusted publishing;
the future policy is not settled. Do not restore or trigger workflows during the
review without a selected, authorized change.

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

Depot execution, a future local Linux build box, macOS coverage and GitHub release
triggers belong in the requested review. These archived YAML files have not been
converted into a Depot provider or a local workflow runner.

The preserved `release.yml` contains `id-token: write` and npm OIDC trusted
publishing. Moving it out of `.github/workflows/` and disabling Actions stopped
that publication path from running. The direct CLI publication of 0.26.86 is the
current delivery path, not a decision to permanently replace trusted publishing.
Next session must review the entire setup and user requirements before proposing
changes; do not assume either zero future CI or reinstatement of the old workflows.
