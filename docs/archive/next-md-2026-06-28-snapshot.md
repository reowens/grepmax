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

# Next Md 2026 06 28 Snapshot

> One-line summary of what this doc covers.

## Overview

# Next: Sentinel

gmax is being absorbed into [Sentinel](../sentinel/PLAN.md) — Claude's local toolkit for gathering intelligence without burning API tokens. gmax's indexing and search become Sentinel's core, with an optional local LLM (Qwen3.5-35B-A3B) for autonomous investigation and commit review.

See [sentinel/PLAN.md](../sentinel/PLAN.md) for the full roadmap.

---

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

### Decision: standard/768d tier switch — CLOSED (stay on small/384d)

**Decision:** Do **not** switch `small`(384d) → `standard`(768d). 384d stays.

**Why (benchmarked, not on faith):** ran an isolated A/B on the gmax repo
(97 `src/eval.ts` cases, identical ~260-file corpus) under a throwaway `$HOME`
so the live daemon/MLX(:8100) and the shared 384d table were untouched. The
149M/768d "standard" model scored **~10 points worse on Recall@10** than the
47M/384d "small" model, consistently across every condition:

| Condition | small/384d R@10 | standard/768d R@10 | Δ |
|-----------|----------------|--------------------|---|
| MLX GPU, rerank ON (prod path) | 0.732 | 0.629 | −0.10 |
| MLX GPU, rerank OFF            | 0.722 | 0.619 | −0.10 |
| q4 ONNX CPU, rerank OFF        | 0.742 | 0.598 | −0.14 |

The first CPU run looked like it might be a q4-quantization artifact, so the
MLX (production GPU) follow-up was run to check — it **refuted** that: MLX vs q4
moved the numbers ≤0.02, and standard lost on both paths. The regression is
broad (11–13 of 97 cases fall out of the top-20 entirely), not a few outliers.
The bigger model genuinely underperforms on gmax's code-search cases.

**Cost avoided:** full re-embed of all 12 projects (platform alone = 144k
chunks), permanently slower indexing, more worker RAM, more storage — to *lose*
recall. No case for it.

**Residual caveat (doesn't change the call):** measured on gmax's own small
single-project corpus. A much larger/more diverse corpus *could* behave
differently, but there's no evidence pointing that way and the burden was on
standard to justify the cost. Revisit only if a concrete recall complaint
surfaces on a big repo — and benchmark again before switching.

**Operational note:** doctor still reports `schema_dim_ok=true` on 384d; the
index is healthy. The `gmax repair --rebuild` path (P0) is the sanctioned route
*if* a future dim change is ever decided.

### Follow-ups / Maintenance

The open items after v0.21.1. The CI bump is DONE (committed locally, not yet
pushed); the rest are optional/operational.

- **CI Node 20 deprecation — DONE (committed, NOT YET PUSHED).** Fixed at the
  source across both `ci.yml` and `release.yml`:
  - `f9be979` — `pnpm/action-setup` v4→v6. v4 was the *only* Node-20 action (the
    one the v0.21.0/v0.21.1 publish runs warned about); v6 runs on Node 24 and
    keeps the `version: 10` input working. Verified `actions/checkout@v5` and
    `actions/setup-node@v5` already resolve to `using: node24`, so the
    `FORCE_JAVASCRIPT_ACTIONS_TO_NODE24` escape-hatch env was genuinely dead and
    was removed from both files.
  - `7b64c86` — currency: `checkout` v5→v7, `setup-node` v5→v6. Both verified safe
    against this repo's usage — checkout v7's only breaking change blocks fork-PR
    checkout for `pull_request_target`/`workflow_run` (neither workflow uses
    those); setup-node v6 only disables *automatic* pnpm cache detection, and the
    explicit `cache: 'pnpm'` set in both files still works.
  - Validation: `ci.yml` exercises the whole stack (`checkout@v7` +
    `pnpm@v6` + `setup-node@v6` + `cache: 'pnpm'`) on the next push to `main`;
    `release.yml`'s OIDC publish path is unchanged by these majors and re-proves
    on the next tag. **Push these (plus `379c52d`) to land them.**
- **Cleanup — DONE (same unpushed batch).** `379c52d` removed the four broken
  `benchmark*` `package.json` scripts (pointed at a deleted `run-benchmark.sh` /
  nonexistent `src/bench/`) and the orphaned osgrep-era `benchmark/` data
  (`benchmark_opencode.csv`, `plot.ts`, `raw_responses/`, `output/`). Kept
  `benchmark/results/.gitignore` — it's the live output dir for the
  `scripts/compare-engines.ts` engine A/B harness. The live recall harness
  (`bench:*` → `src/eval*.ts`) is untouched.
- **Optional hardening:** `repairRebuild` end-to-end integration test across a
  `small`→`standard` switch (see P1 above — currently covered only indirectly).
- **Operational (not a code change):** the long-running daemon may still be on an
  older binary after a release — v0.21.1's changes are CLI-side so it didn't
  matter, but restart with `pkill -x gmax-daemon && gmax watch --daemon -b` to
  pick up a new global install when a release touches daemon runtime.

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

## Part 1: Daemon as Single Writer — DONE (v0.13.0)

Before adding the LLM, fix the write contention. CLI commands become thin IPC clients routing all writes through the daemon.

### Problem

CLI commands (`gmax add`, `gmax index`, `gmax remove`) and the daemon's BatchProcessor both write to LanceDB. They compete for the writer lock (`~/.gmax/LOCK`), causing:
- "lock already held" errors during normal usage
- `gmax index` must pause the daemon watcher before running
- `gmax add` blocks the daemon for minutes on large repos

### Current Write Paths

| Command | What it does | Lock? | Duration |
|---------|-------------|-------|----------|
| `gmax add` → `initialSync()` | Full index | Yes (entire run) | seconds–minutes |
| `gmax index` → `initialSync()` | Re-index | Yes (entire run) | seconds–minutes |
| `gmax remove` → `deletePathsWithPrefix()` | Delete project | No lock (bug) | seconds |
| `gmax summarize` → `updateRows()` | Field updates | No lock | seconds–minutes |
| Daemon BatchProcessor → `processBatch()` | Incremental | Yes (during flush) | ~1s per batch |

### New IPC Commands

```typescript
// Add to ipc-handler.ts
{ cmd: "index", root: string, reset?: boolean, dryRun?: boolean }
{ cmd: "remove", root: string }
{ cmd: "add", root: string }
{ cmd: "summarize", root: string, limit?: number }
```

### IPC Protocol: Streaming Progress

Currently request → response (one JSON line each way). Needs streaming for long-running operations.

```
Client → Server: {"cmd":"index","root":"/path/to/project"}\n
Server → Client: {"type":"progress","processed":10,"total":500,"file":"src/auth.ts"}\n
Server → Client: {"type":"progress","processed":11,"total":500,"file":"src/db.ts"}\n
...
Server → Client: {"type":"done","ok":true,"indexed":450,"total":500}\n
```

Last message has `type: "done"`. Client keeps connection open until done.

**Protocol details to resolve:**
- Buffer partial JSON across TCP reads (split on `\n`)
- Timeout must be per-operation, not per-connection (current 5s default won't work)
- Daemon currently closes connection after every response — must keep open for streaming
- Handle concurrent commands to same project (per-project queue or mutex)

### CLI Changes

**`gmax add`** (src/commands/add.ts)
- Register project in registry (keep in CLI — file write, not LanceDB)
- Send `{ cmd: "add", root }` to daemon via IPC
- Stream progress to terminal
- If daemon not running, start it first
- Fallback: direct indexing with lock if daemon can't start
- Consider: send IPC first, register on success (avoid registered-but-not-indexed state)

**`gmax index`** (src/commands/index.ts)
- Send `{ cmd: "index", root, reset }` to daemon
- No more "Pausing daemon watcher for reindex" — daemon handles it internally
- Stream progress to terminal

**`gmax remove`** (src/commands/remove.ts)
- Send `{ cmd: "remove", root }` to daemon
- Daemon does delete + cache cleanup atomically

**`gmax summarize`** (src/commands/summarize.ts)
- Send `{ cmd: "summarize", root, limit }` to daemon
- Currently writes via `updateRows()` with no lock — must go through daemon too

### Daemon Changes

**New method: `Daemon.indexProject(root, options)`**
- Calls `initialSync()` internally (same function, just runs inside daemon)
- Uses the daemon's existing VectorDB/MetaCache/WorkerPool — no duplicate resources
- Pauses the project's BatchProcessor during full index
- Reports progress via IPC response stream
- Wire existing `onProgress` callback to IPC writes

**Lock elimination**
- Remove `acquireWriterLock` from `initialSync` — daemon is the single writer
- Remove lock from `processBatch` — already inside daemon process
- Keep lock only as fallback for direct CLI mode (daemon not available)
- Update `src/lib/utils/lock.ts` — make lock acquisition optional/conditional

**Idle timeout**
- Daemon must not idle-timeout during long index operations
- Reset `lastActivity` on each progress tick
- Note: maintenance loop (FTS rebuild, 5 min interval) runs serialized — long index could block it

### Key Files

| File | Change |
|------|--------|
| `src/commands/add.ts` | IPC client instead of direct index |
| `src/commands/index.ts` | IPC client instead of direct index |
| `src/commands/remove.ts` | IPC client instead of direct delete |
| `src/commands/summarize.ts` | IPC client instead of direct updateRows |
| `src/lib/daemon/daemon.ts` | Add indexProject/removeProject/summarizeProject methods |
| `src/lib/daemon/ipc-handler.ts` | Add index/remove/add/summarize commands with streaming |
| `src/lib/utils/daemon-client.ts` | Add streaming response support |
| `src/lib/index/syncer.ts` | Make lock acquisition optional |
| `src/lib/index/batch-processor.ts` | Remove lock (already in daemon) |
| `src/lib/utils/lock.ts` | Conditional lock for fallback mode only |

### Risks

- Streaming IPC over Unix socket — handle partial reads, connection drops
- Progress display — CLI needs to render from IPC stream (currently inline callback)
- Long-running index — daemon idle timeout must be suspended
- Fallback — if daemon can't start, CLI must still work directly
- Concurrent commands — need per-project operation serialization

### Follow-ups (done in v0.13.1)

- **Auto-start daemon** — `ensureDaemonRunning()` in `daemon-client.ts` spawns + polls. Used by `add` and `index`.
- **Abort signal** — `conn.on("close")` wired to `AbortController` in `addProject`/`indexProject`. Client disconnect aborts the sync.

---

## Part 2: Local LLM Integration

TBD — waiting on model details. Rough shape:

- Sentinel daemon hosts/connects to local 122B model
- New IPC command: `{ cmd: "investigate", question: string, context?: string }`
- Sentinel autonomously uses index tools (search, trace, extract, read) to answer
- Returns synthesized answer to caller (Claude via MCP, or CLI)
- Agent loop: LLM decides what to search/read next, iterates until it has an answer

---

## Changelog

### v0.10.2 → v0.12.10 (20 PRs, #52–#67)
- Storage bloat fix (optimize retry, FTS positions, temp file filtering, mutual exclusion)
- `gmax doctor --fix` with index health diagnostics
- 5 new commands (diff, test, impact, similar, context)
- Unified `gmax plugin add/remove` for all 4 clients
- Self-updating OpenCode shim (dynamic SKILL from package root)
- Updated Codex/Droid plugins with fresh SKILLs
- Daemon dedup with PID file
- Live chunk counts in `gmax status`
- Indexing state display
- Walker gitignore fix for nested directories
- Process titles for Activity Monitor
- Postinstall auto-sync for all integrations
- CLI/MCP parity (role on diff, threshold on similar)
- Full doc audit + README rewrite

## Version History

- **2026-06-28T22:06:28Z** Created.

## Related Documentation

