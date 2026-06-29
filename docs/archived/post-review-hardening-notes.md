---
type: doc
status: archived
created: 2026-06-28T22:06:28Z
updated: 2026-06-28T22:06:28Z
modules:
surfaces:
domain:
audience: internal
related_plans:
related_docs:
---

# Post Review Hardening Notes

> One-line summary of what this doc covers.

## Overview

## Post-review hardening — shipped findings & regression coverage

> Extracted verbatim from the retired `NEXT.md` (2026-06-28). All P0–P3 items
> below shipped (v0.21.x) with the regression coverage noted inline; the tests
> named are the live guardrail. Kept as the *why* behind each fix.

## Current Fix Plan: Post-Review Findings

These are the remaining issues verified during the primary-consumer review. Keep
this section current until each item is either fixed with regression coverage or
explicitly deferred.

### P0: Doctor Must Flag Physical Schema Dimension Mismatch — DONE

**Resolution (global-rebuild strategy):**
- `VectorDB.getSchemaVectorDim()` reads the on-disk `vector` FixedSizeList width
  (non-throwing — doctor must see the truth even on an incompatible table).
- `describeSchemaDimGap()` + `schemaDimAgentRow()` are pure helpers in
  `config.ts`, independent of `describeEmbeddingGap` (registry drift). Doctor now
  prints `FAIL  Schema: vector table is 384d, config expects 768d` (human) and a
  `schema_dim_mismatch\ttable_dim=…\tcurrent_dim=…\tfix=gmax repair --rebuild`
  row plus `schema_dim=/schema_dim_ok=` fields (`--agent`).
- Recovery is `gmax repair --rebuild` (new command → daemon `repairRebuild` IPC):
  drops the shared table and re-indexes every registered project at the configured
  dim. `REBUILD_COMMAND` is the single source of truth; `insertBatch`'s mismatch
  throw and the stale-embedding (dim-change) guidance both point at it.
- Tests: `schema-dim-gap.test.ts` (helpers + registry-vs-physical distinctness),
  `vector-db-schema-dim.test.ts` (real LanceDB round-trip reports the stranded
  width), `model-tier-wiring.test.ts` (mismatch error → rebuild command).

**Problem:** `gmax doctor` reports project-registry embedding drift, but it does
not inspect the actual LanceDB table schema width. A project/global config can
say `768d` while the shared `chunks` table is still physically `384d`. In that
case `doctor` can look healthy until writes fail with a vector dimension error.

**Current behavior:**
- `doctor` detects stale embedding by comparing project registry
  `{ modelTier, vectorDim }` to global config.
- `VectorDB.validateSchema()` only checks required field presence, not the
  `vector` column's `FixedSizeList` size.
- `gmax index --reset` deletes rows for a project but does not recreate the
  fixed-width shared table schema.

**Fix scope:**
- Add schema dimension introspection in `VectorDB` or `doctor`.
- Compare physical table vector width to `readGlobalConfig().vectorDim`.
- Human doctor output should show a clear `WARN`/`FAIL`, for example:
  `FAIL  Schema: vector table is 384d, config expects 768d`.
- Agent doctor output should include a machine-readable row, for example:
  `schema_dim_mismatch\ttable_dim=384\tcurrent_dim=768\tfix=...`.
- Update stale-embedding guidance so dim changes do not imply that a
  per-project reset can fix a shared table-width mismatch.
- Decide recovery path:
  - Minimal: tell users to run a global reset/drop-table repair command.
  - Better: table-per-dimension or table-per-model-tier (`chunks_384`,
    `chunks_768`) so dimensions can coexist safely.

**Files:**
- `src/commands/doctor.ts`
- `src/lib/store/vector-db.ts`
- `src/lib/index/syncer.ts`
- `src/commands/index.ts`
- `src/commands/config.ts`

**Tests:**
- Doctor flags physical `384d` schema when config expects `768d`.
- Doctor agent mode emits a stable machine-readable mismatch row.
- Per-project registry drift remains distinct from physical table-schema drift.
- Reset/recovery guidance matches the actual fix path.

### P1: Model Tier Storage Migration Is Still Incomplete

**Problem:** Worker/model wiring is mostly fixed, but the storage model remains a
single fixed-width shared table. A tier change can still strand the table at the
old width.

**Already fixed:**
- Workers receive `GMAX_VECTOR_DIM` and `GMAX_EMBED_ONNX_MODEL` from the active
  tier.
- CPU embeddings honor `GMAX_EMBED_ONNX_MODEL`.
- `VectorDB` defaults to the configured vector dim.
- `VectorDB.insertBatch()` fails loudly instead of padding/truncating vectors.

**Strategy chosen: global table rebuild** (single shared fixed-width table; a
tier/dim change is recovered by dropping + re-indexing all). Implemented as
`gmax repair --rebuild` (P0). Table-per-dimension was rejected as too large a
surface for a tool being absorbed into Sentinel, and the global-tier semantics
mean a change invalidates every project anyway.

**Remaining scope:**
- DONE — recovery message now consistent across surfaces for a dim change: doctor,
  `insertBatch`, `config --model-tier` (was wrongly pointing at `index --reset`),
  and the query-time `maybeWarnStaleEmbedding` hint all route to
  `gmax repair --rebuild` via `REBUILD_COMMAND`. (Chunker-version hints and
  same-dim model swaps still correctly use per-project `index --reset`.)
- Optional hardening: integration test that exercises `repairRebuild` end-to-end
  across a `small`→`standard` switch (currently covered indirectly by the
  `getSchemaVectorDim` round-trip + the shared `reindexOneProject` regression).
- DONE — these `config`/`stale-hint` fixes SHIPPED in **v0.21.1** (`257cf4d`),
  alongside the README model-tier docs (`44b770f`). The CI Node-20 follow-up was
  *not* batched with them and remains open below.

### P1: In-Process First-Run Search Uses Global Row Existence — DONE

**Resolution:** `search-run.ts` now scopes the first-run decision to the searched
project via `hasRowsForPath(effectiveRoot)` in single-project mode, so a sibling
project's rows no longer suppress this project's first-run index. Cross-project
mode (`--all-projects`/`--projects`/`--exclude-projects`) keeps the global
`hasAnyRows()` check so it never first-runs a single directory just because the
cwd is unindexed — never auto-indexes "every project" (initialSync only ever
touches the cwd projectRoot).

**Tests** (`search-command.test.ts`, "first-run auto-index scoping"):
- Sibling rows present (`hasAnyRows` true) but searched project empty
  (`hasRowsForPath` false) → initial sync triggers.
- Current project has rows → no auto-sync unless `--sync` is passed.

### P2: Daemon Version-Mismatch Restart Still Has a Timeout Escape Hatch — DONE

**Resolution (draining marker):** a daemon writes `~/.gmax/daemon.draining`
(`{pid, ts}`) at the very start of `shutdown()` — before it drops its
socket/PID/lock — and clears it on a clean exit (self-expires after a 90s grace
window otherwise). `killStaleProcesses()` now checks `isDaemonDraining(pid)`
first: a draining peer is left to finish its own teardown (and its workers are
not swept), while the successor still takes over the freed lock. The 20s
restart wait in `watch.ts` stays as-is but "starting anyway" is now safe — the
marker stops the successor from SIGKILLing a peer mid-cleanup. A wedged or
already-exited peer (stale ts / dead PID) is still reclaimable.

**Tests:** `draining-marker.test.ts` (marker fresh/stale/cleared/dead-PID/PID
mismatch) and `process-manager-draining.test.ts` (killStaleProcesses leaves a
draining peer + its workers alone and takes over; still kills a truly-stale
peer; still defers to a healthy responsive peer).

### P2: Codex MCP Install Command Is Still Suspect — DONE

**Resolution:** confirmed via `codex mcp add --help` that the synopsis is
`codex mcp add [OPTIONS] <NAME> (--url <URL> | -- <COMMAND>...)`. `codex.ts` now
runs `codex mcp add gmax -- gmax mcp`. AGENTS.md is written only after the
registration `await` resolves, so a failed registration leaves it untouched
(verified by test).

**Tests** (`codex-install.test.ts`): exact command asserted; failed registration
does not call `writeFileSync`; successful registration writes AGENTS.md.

### P2: Factory Droid Settings Safety — DONE

**Resolution:** `parseJsonWithComments()` no longer swallows parse errors into
`{}` (empty/whitespace files still map to `{}`); `loadSettings()` rethrows a
clear "refusing to touch … invalid JSON" error. `installPlugin()` loads+validates
settings BEFORE writing anything, so a malformed user file aborts cleanly with no
half-written hook scripts. Uninstall strips only gmax hook entries (matched by
command pointing at the gmax hooks dir) via `removeGmaxHooks()`, preserving
unrelated user hooks and `enableHooks`/`allowBackgroundProcesses`.

**Tests** (`droid-install.test.ts`): invalid JSON aborts without clobbering the
file or writing hook scripts; existing non-gmax hooks survive install; uninstall
removes only gmax entries and leaves other hooks + events intact.

### P3: Docs And Packaged Assets Drift — RESOLVED

- Skeleton directory examples in the plugin skill: **fixed** in a48f77d (skill
  no longer instructs agents to run `gmax skeleton <dir>`, which the CLI rejects).
- `README.md` `docs/known-limitations.md` / `public/bench.png` references:
  **resolved by decision** — these stay repo-only. npm rewrites relative URLs on
  the published README, so the packaged README renders correctly without bundling
  `public/` or adding the doc. No code change needed.

Nothing left here; kept for the regression note below (skill examples must not
instruct agents to run commands the CLI rejects).

### Recently Resolved Items To Keep Covered

These were verified fixed and should keep regression coverage:
- Project remove and path scoping no longer use wildcard-sensitive prefix
  `LIKE`; destructive deletes slash-terminate prefixes and use `starts_with()`.
- Full reindex now inserts replacement vectors before deleting old chunks.
- Empty/oversized file transitions delete stale chunks instead of leaving search
  ghosts.
- Failed daemon startup calls `shutdown()` to clean half-open socket/PID/lock
  state, and IPC gates non-ping commands until resources are ready.
- Poll-mode watcher timers are cleared during `unwatch`/`remove`.
- Claude plugin marketplace metadata is included in the npm package.
- `gmax setup` calls plugin installation directly instead of showing plugin
  status and exiting early.

---

## Version History

- **2026-06-28T22:06:28Z** Created.

## Related Documentation

