# Stable Lance dependency upgrade — October 29, 2026 UTC

Locally complete; not published or installed on P3. Starting local HEAD:
`47bccf598fa78e8768a6e30409eba1a43de459c0`, released source:
`2ebdb621bda25ada7b400d968700544dbea7b853` (0.26.108). No package version bump.

## Selected versions and compatibility

- Official JS SDK and all seven optional native platform packages: 0.39.0 →
  **0.40.0**, including manifest, pnpm importer/package/snapshot entries and
  integrity hashes. Installed Linux x64 GNU native package is 0.40.0.
- Embedded Rust Lance core: 12.0.0 → **13.0.0**, as pinned in the
  [official SDK 0.40.0 Cargo manifest](https://github.com/lancedb/lancedb/blob/v0.40.0/Cargo.toml).
  [Stable SDK release](https://github.com/lancedb/lancedb/releases/tag/v0.40.0)
  was published October 7. Preview 0.41.0-beta.17 was not selected.
- Python maintenance: pylance 12.0.0 → **13.0.0**, aligned with the SDK's
  embedded engine. The uv lock retains the other package versions; uv rewrote
  lock revision 3 → 5. A fresh wheel-only, no-build local environment was
  installed under the evidence state directory; no Lance/Arrow import ran.
- 13.0.0 is the only published stable 13.x Python release in the official
  [PyPI metadata](https://pypi.org/pypi/pylance/json) checked this session.
  Standalone latest 14.0.2 is not selected: forward read/write compatibility
  from a newer major writer into SDK core 13 was not established. This is an
  actual shared-store compatibility constraint, not a user version freeze.
- Python compatibility is source-grounded, not runtime-qualified: the
  [13.0.0 Python dataset API](https://github.com/lance-format/lance/blob/v13.0.0/python/python/lance/dataset.py)
  retains `cleanup_old_versions(versions, delete_unverified,
  error_if_tagged_old_versions, delete_rate_limit)`, `create_index_uncommitted`
  with fragment IDs/document granularity, and `commit_existing_index_segments`.
  The helper continues selecting the existing segment's format version 1–3.
  Comparing versioned 12/13
  [tokenizer parameters](https://github.com/lance-format/lance/blob/v13.0.0/rust/lance-index/src/scalar/inverted/tokenizer.rs)
  found unchanged serialized fields; `document_granularity`, memory/worker and
  format controls remain skipped in that JSON serialization. The
  [builder](https://github.com/lance-format/lance/blob/v13.0.0/rust/lance-index/src/scalar/inverted/builder.rs)
  still writes `params` JSON to `metadata.lance` and staged metadata. The strict
  physical-tokenizer checks and refusal of unknown formats remain unchanged.
- New Python helper outputs and callers require engine 13.0.0. Historical prune
  and FTS state receipts accept their original 12.0.0 as well as 13.0.0; no old
  receipt is rewritten or relabeled. Existing fixtures/version assertions were
  aligned, including the incompatible-version rejection fixture. The standalone
  compact-recovery utility's version guard now follows the shared Python runtime.
- The **separate custom bounded-maintenance Rust executable remains Lance 12**:
  its Cargo lock, qualification scripts, artifacts and acceptance evidence are
  not the SDK's npm native platform packages. No artifact was relabeled, built,
  qualified or copied; neither source nor generated artifact manifest exists in
  this checkout. Full-table production maintenance remains unconditionally
  disabled. Its cross-engine mutation compatibility is not established; this
  upgrade does not authorize its use or create a newly qualified executable.

## Runtime preparation and verification

Dependency installation used `--ignore-scripts`; SDK package hooks, root
prepublish/test/build/audit aggregates and custom native builds were not invoked.
Python resolution/sync used `--no-build --no-python-downloads` and the existing
locked environment procedure. No global installation or service runtime changed.

The existing `prepare-lance-runtime.cjs` checks exact SDK/native manifest pins and
runtime dependencies, then copies official JS and third-party licenses without
its optional provider manifest. Existing generated SDK files were moved to the
local state backup before preparing a fresh destination, avoiding stale files.
The upstream Apache license is byte-identical to the tracked license. All **58**
official SDK runtime files compare byte-for-byte with the new generated runtime;
provenance version is 0.40.0, entry SHA256:
`da1c79bb5d956e1c706eb778827d8ea1d311a5b8f85314538021251c3eb4079f`.
See [preparation receipt](runtime-preparation.json).

Exactly **one** guarded production compilation ran on final selected source:
`node_modules/.bin/tsc --noEmit --incremental false`, exit 0, 0.846s,
peak sampled aggregate owned RSS 278,499,328 bytes, zero swap growth,
46,241,849,344 bytes final available memory, no surviving owned processes.
The reused controller enforces two CPUs/nice10, 2GiB owned RSS, 180s,
minimum 8GiB available and zero new swap, with owned TERM/KILL cleanup.
See [compilation receipt](typecheck-receipt.json). Its admission passed.
No passing compilation was repeated; no tests or test typecheck ran.

Compilation includes the preserved working-tree ColBERT refactor; it is not a
claim that unrelated work is selected, integrated or validated. No native import,
store/FTS operation, smoke, query, benchmark, profile, audit or independent review
ran. Native ABI and read/write compatibility remain **UNEXERCISED**. No measured
RSS improvement, leak repair or search-quality gain is claimed. The separate
operation-local Table-finally fix remains unselected and untouched.

## State preservation and remaining work

Selected source/fixture changes were clean against the starting root baseline;
only their upgrade edits are collected. The owning plan/handoff already contained
uncommitted history, so their commit images include only this upgrade's section
and frontmatter; older unrelated dirty history stays in the working tree.
All pre-existing index entries/intent-to-add content and unrelated dirty source
are preserved. Local state (pre-edit snapshots, original index, old generated
SDK, upstream versioned source reads and compile controller/log):
`/home/reoiv/.local/state/gmax-lance-upgrade/20261029-stable/`.

The three-query search-quality run remains incomplete with **unknown attempt
count**, no retained rankings and no authorized retry/budget reset. Original
Gmax cases remain never queried. P3 remains the previously recorded 0.26.108;
no fresh service check, release, push, install or handover occurred. FTS is
complete and unchanged. CPU attribution/resource history/backend work remains
deferred. The umbrella delivery plan stays active; saved prompts are untouched.
