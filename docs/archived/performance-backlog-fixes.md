---
type: plan
status: archived
created: 2026-08-04T08:22:27Z
updated: 2026-08-04T10:54:22Z
surfaces:
  - workers
  - index
  - store
  - search
  - daemon
  - mcp
modules:
  - src/lib/index/chunker.ts
  - src/lib/skeleton/skeletonizer.ts
  - src/lib/workers/pool.ts
  - src/lib/workers/process-child.ts
  - src/lib/workers/orchestrator.ts
  - src/lib/index/batch-processor.ts
  - src/lib/store/vector-db.ts
  - src/lib/search/searcher.ts
  - src/commands/mcp.ts
domain: performance remediation (memory, indexing throughput, search latency)
audience: internal
parent_plan:
related_plans:
  - lancedb-fts-panic-remediation.md
related_docs:
  - ../2026-08-04-performance-review.md
current_state: >
  Phases 1A through 5A are implemented and verified. Phase 1B measurement retained the
  1536 MB worker recycle default. Phase 5B's flag-gated IVF_FLAT implementation failed
  its recall gate and remains disabled; its path scalar index was retained for scoped
  exact-search latency. The full 124-file / 1035-test regression gate passes.
next_step: >
  No further work in this plan. Reopen deferred findings only with a measured trigger.
---

# Performance Backlog Fixes

> Execution plan for the findings in docs/2026-08-04-performance-review.md. The watcher
> ignore-glob fix already shipped (fd11906); this plan covers the remaining top items:
> worker memory leak, IPC serialization, batch concurrency, compaction gating, and the
> search-path (ANN index / MCP-via-daemon) work.

## Problem

Workers settle near 900MB and are never reclaimed; indexing throughput is capped by JSON
IPC and a serial daemon reindex loop; every search brute-force scans the whole shared
vector table; idle daemons pay ~1.7GB compaction spikes every 5 minutes; each MCP session
duplicates the search stack in-process. Full findings + evidence:
docs/2026-08-04-performance-review.md.

## Goals

- Worker RSS plateaus at the documented healthy steady state (700–800MB MLX / 900–1050MB ONNX) instead of drifting into it via leak accumulation.
- Incremental reindex uses the pool's full concurrency.
- Search latency stops scaling with total corpus size across all projects.
- Idle daemon does no compaction work.

## Non-Goals

- Summarizer / LLM-server work (decommissioned; see CLAUDE.md hard stop).
- Embedding model changes or re-embed migrations (separate gated plan).
- Chunker semantic changes (dedup of nested definitions is Deferred, not in scope for the first pass).

## Constraints

- No `await` may be introduced between `parser.parse()` and the corresponding `tree.delete()` (shared parser instance; concurrency safety in orchestrator.ts:339-353).
- `serialization: "advanced"` requires both fork ends on the same protocol — check test harnesses that fork workers.
- Phase ordering: RSS threshold retune (1B) is gated on post-1A measurement; do not combine in one commit.

## Decisions

- MIN_KEEP_WORKERS stays at 1 — the retention problem is the threshold, not the floor (recycleWorker ignores MIN_KEEP and respawns lean).
- Threshold default target after re-measurement: ~1.25× ONNX-fallback p95, rounded to 128MB boundary (likely 1280); floor 1152 — below that re-introduces recycle-thrash.
- Grammar caches (`this.languages`) and Parser instances are intentionally retained; do NOT delete those.

## Open Questions

- Exact wasm-heap accessor in web-tree-sitter 0.26.9 for the soak script (confirm at runtime; fall back to RSS).
- Does Lance push `starts_with()` through a btree scalar index on `path`? (Phase 5B — measure; if not, a `project_root` bitmap column is the deferred durable fix.)
- Does `table.optimize()` in the JS binding fold new rows into an existing vector index? (Phase 5B — check indexStats.numUnindexedRows before/after; latency-only either way.)

## Phases

### Phase 1A — Free tree-sitter trees (chunker + skeletonizer) ✅

**Defect.** `chunker.ts:421` and `skeletonizer.ts:218` call `parser.parse(content)` and
never `tree.delete()`. web-tree-sitter 0.26.9 trees live in the Emscripten heap — V8 GC
never reclaims them and the heap never shrinks. Both classes are long-lived singletons in
the worker (`orchestrator.ts:115-116`, invoked concurrently per file via Promise.all at
:350) → two trees leak per indexed file. Second long-lived leaker: MCP's cached
skeletonizer (`mcp.ts:381-387`). These are the only two `parser.parse()` sites in `src/`.

**Type shims.** Both files declare `parse(content): { rootNode }` — widen to a
`TreeSitterTree` interface with `delete(): void` and make `parse` return
`TreeSitterTree | null` (0.26.9 returns null when no language set / parse aborted).

**chunker.ts edit.** Null-guard after parse (return empty chunks/metadata), then wrap the
entire existing body (lines ~424–1116) in `try { ... } finally { tree.delete(); }`. Last
node access is `root.endPosition.row` at ~1104; the `!sawDefinition` early return at
~1111 and the outer catch in `chunk()` (~306-308) are exactly why this must be `finally`,
not a trailing statement. Pure indentation change for the body — no logic edits.

**skeletonizer.ts edit.** Hoist `let tree: TreeSitterTree | null = null` above the
existing try; add null-guard → fallback result; add `finally { tree?.delete(); }` after
the existing catch. Covers the `elisions.length === 0` early return (~225-232) and the
parse-error catch (~248).

**Escape analysis (verified — eager delete is safe).** Chunks copy `node.text`/positions
into plain strings/numbers; `ElisionRegion` is `{numbers, strings}`; no node-typed field
on any returned type; all node-touching helpers are synchronous function-scoped closures;
neither class caches nodes/trees (fields are parser/languages/initialized only). Do NOT
delete cached `Language` objects or the `Parser`. Add a comment on the `finally`:
"nothing below may retain a Node" (future retention = silent use-after-free).

**Invariants.** `delete()` exactly once (double-free can abort the wasm process). No
`await` between `parse()` and `finally`.

**Verification.**
1. Unit tests (`tests/tree-lifecycle.test.ts`): wrap the private parser post-init to
   count parses/deletes; assert deletes === parses across: happy path, no-definitions
   early return, throwing traversal (outer catch), parse→null, 50-file loop; assert
   exactly-once per tree. Mirror for skeletonizer (normal / zero-elisions / throw / null).
2. Output equivalence: chunker digest over `src/**/*.ts` (chunkCount, sorted symbol
   lists, line ranges) must be byte-identical pre/post — divergence = read-after-free.
   Plus existing chunking/graph-edges/skeleton/context test files.
3. Leak soak (`scripts/tree-leak-soak.ts`, `--expose-gc`, opt-in): 2000 iterations over
   ~50 real files; record wasm heap (HEAPU8.byteLength) every 100. Pre-fix baseline should
   grow monotonically (record it); post-fix: growth from iter 200→2000 < 50MB, tail slope
   < 5MB/100 iters. Plateau ≈ largest-single-file arena, not zero.
4. E2E: full `gmax index` of a large repo in BOTH embed modes; capture lastRssBytes
   trajectory (pool.ts:157,440) — expect flat band, zero recycle events at 1536.
   Captured p50/p95 feed Phase 1B.
5. Canary: repeated `gmax skeleton` / `gmax context` / MCP skeleton tool in one session
   (the mcp.ts singleton is the best repeated-use canary) — watch for
   "memory access out of bounds" or garbage output.

### Phase 1B — Retune WORKER_RSS_RECYCLE_MB (gated on 1A measurement) ✅

Current 1536 default was calibrated with the leak present (pool.ts:206-223 comments:
~700-800MB MLX / ~900-1050MB ONNX steady states, old 800 default caused recycle-thrash).
After 1A ships and E2E p50/p95 are measured in both modes: set default to ~1.25× ONNX
p95 rounded to 128MB (likely **1280**); never ≤1152. Document
`GMAX_WORKER_RSS_RECYCLE_MB=1024` as the MLX-only-host override rather than lowering the
default. Update the pool.ts comment block with: old numbers were leak-inclusive, new
measurements, and the 1.25×-p95 rule. Note: `lastRssBytes` only refreshes on worker
messages (stale for idle workers — conservative in the right direction, no change).

**Measured outcome (2026-08-04).** `scripts/worker-rss-soak.ts` processed the 300-file
TypeScript corpus repeatedly through one long-lived worker with recycling disabled. MLX
(900 tasks) measured p50/p95/max **1055.5/1110/1121.5 MB**; ONNX fallback (600 tasks)
measured **1029.7/1182/1195.3 MB**. The rule gives 1182 × 1.25 = 1477.5 MB, which rounds
to the existing **1536 MB** boundary, so no default change is warranted. The proposed
1024 MB MLX-only override is rejected by measurement because it is below MLX p50; hosts
should retain 1536 unless their own soak supports a lower environment override. Both
runs remained below 1536 with zero recycle events.

### Phase 2 — Worker IPC: serialization "advanced" ✅

**Change.** Add `serialization: "advanced"` to the `childProcess.fork` options at
pool.ts:173. That is the entire functional change — Node injects
NODE_CHANNEL_SERIALIZATION_MODE into the child (verified: the custom `env` spread does
NOT clobber it), so process-child.ts needs ZERO changes; do not add a serialization
option there. Node ≥22 requirement already satisfied. Same binary both ends (fork uses
process.execPath) → no V8 wire-format hazard. No index rebuild — transport only.

**Empirically verified on this machine (Node v22.23.1):** Buffer→Buffer (byteOffset may
be nonzero post-clone), Float32Array/Int8Array/Uint8Array preserved, number[]→number[],
undefined-valued keys now PRESENT (JSON dropped them), class instances flatten to plain
objects, functions/symbols THROW "could not be cloned", and a typed-array subarray view
serializes only the viewed bytes (10-byte view of 1MB buffer → 15 wire bytes — matters
for Arrow views on the rerank path).

**Dead code to delete.**
- pool.ts:42-53 `reviveBufferLike` + :55-66 `reviveProcessFileResult` (also removes a
  shallow copy of every VectorRecord per result) + simplify call site :471-477.
- orchestrator.ts:392-400 `Array.from(pooled_colbert_48d)` workaround → pass the
  Float32Array through (vector-db.ts:701 already Array.from()s it; types permit).
  Optional-but-recommended (removes 48 allocs/chunk).
- vector-db.ts:640-648 toBuffer's `{type:"Buffer"}` branch; :657-668 toNumberArray's
  numeric-key branch — deleting the latter is strictly better: a shape regression then
  trips the loud dimension-mismatch throw at :679-686 instead of silently inserting
  garbage.

**⚠ REQUIRED ADDITION — the one silent-regression hazard.** `coerceColbertBytes`
(orchestrator.ts:55-89) is on the PARENT→CHILD rerank leg; its input is `doc.colbert`
read from LanceDB, and Arrow's Binary getter returns a **Uint8Array subarray view** (not
Buffer/Int8Array). Today the JSON numeric-key branch rescues it; post-switch it falls
through every branch → `new Int8Array(0)` → seqLen 0 → maxSim 0 → **rerank silently
no-ops** (the exact 2026-05-25 defect). Fix: keep the function; replace Buffer branch
with a general `ArrayBuffer.isView` branch reinterpreting bytes as signed with
byteOffset/byteLength preserved (no copy); keep Array.isArray and empty fallbacks;
delete the two JSON-shape branches; rewrite the stale doc comment. Widen RerankDoc
colbert union (+Uint8Array) and the searcher.ts:899 cast (currently a lie at runtime).

**Parent-side types after clone (field-by-field):** `vector` → Float32Array (was
numeric-keyed object), `colbert` → Buffer (Buffer.isBuffer true, possibly nonzero
byteOffset), `pooled_colbert_48d` → Float32Array (post-b4) , `doc_token_ids` stays
number[] (do NOT upgrade to Int32Array here), primitives unchanged, optional fields now
present-with-undefined — insertBatch already normalizes every optional column (?? ""/
null) so LanceDB never sees bare undefined. encodeQuery/rerank payloads already
JSON-safe number[]s — leave them; typed-array-ifying them is a separate optimization.

**Consumers audited:** insertBatch SAFE (isView branches); meta updates SAFE
(primitives); vector accumulation SAFE (real arrays spread); searcher encode/prefilter
SAFE; rerank dispatch SAFE on the wire (view-only serialization) but needs the
coerceColbertBytes fix; daemon socket JSON framing unaffected; tests/setup.ts pool mock
oddity (processFile → []) unaffected, don't fix here. Non-cloneable throws are handled:
child-side send sits in a try → readable task error, not a hang; parent-side send
already try/caught.

**⚠ CI is blind here.** worker-pool-resilience mocks child_process wholesale;
tests/setup.ts mocks the whole pool for other suites. The suite passes whether or not
this works. Verification MUST include the e2e steps.

**Verification.** (1) typecheck/lint; grep zero hits for revive*. (2) Assert
`options?.serialization === "advanced"` in the existing fork-options test
(worker-pool-resilience:76 pattern). (3) coerce-colbert-bytes tests: add Uint8Array case
incl. subarray at nonzero byteOffset and a byte >127 proving signed reinterpretation
(200→-56); drop the JSON-shape cases; keep null/garbage → length-0. (4) Channel-level
test WITHOUT the real worker (booting process-child pulls ONNX): spawn `node -e` that
process.send()s typed arrays over an ipc stdio channel with advanced serialization;
assert constructors on receipt — the only automated check catching a fork-option
regression. (5) E2E mandatory: index a real repo to a scratch dir (no dimension-mismatch
throws); query and assert non-zero pooled_colbert_48d (all-zero = b4 regressed); rerank
on/off must produce DIFFERENT score orderings (identical = coerce returned empty; use
bench:recall/bench:oss). (6) Perf: pool "complete task" elapsed for same large file
pre/post; --cpu-prof on parent — JSON.parse/stringify frames should vanish. (7) Rollout:
daemon restart required (live workers keep the JSON channel).

### Phase 3 — Parallelize batch-processor reindex ✅

**Defect.** `processBatch` (batch-processor.ts:306-467) awaits one `pool.processFile` at
a time → 1/N pool throughput on watcher batches and catchup (which routes all misses
through the same loop, 50/batch). Side effect: the pool never grows past 1-2 workers
during watch, so it's also cold-sized. syncer.ts:273,421-436 is the reference pattern.

**Why it's tractable.** `batch` is a `Map` → unique path keys → concurrent tasks never
touch the same path. All accumulators (`deletes`, `vectors`, `metaUpdates`, `metaDeletes`,
`completed`, `retryFailures`, `reindexed`) are path-keyed or order-insensitive, and JS
single-threading makes mutation between awaits safe — no locking. `filePolicy.ignoreCache`
is promise-memoized so concurrent classifies dedupe. `requeuePath` and instance maps are
only touched after the loop today — keep it that way.

**Structure.**
- New `concurrency` option on `BatchProcessorOptions`; default
  `DEFAULT_BATCH_CONCURRENCY = max(1, CONFIG.WORKER_THREADS - 1)` — the −1 reserves one
  worker for search: pool priority is queue-level only, no preemption (pool.ts:634), so
  saturating all workers makes `encodeQuery` wait a full processFile. Document this in
  the constant's comment.
- Extract lines 321-466 into `processOne(absPath, event)`: every `continue` → `return`;
  abort-`break` in catch → `return` (path stays out of `completed` → requeued
  non-failed); `!pool.isHealthy()` `break` → `stopDispatch = true; return` (no retry
  budget spent). `schedule()` helper mirrors syncer (push task, splice on settle,
  `Promise.race` when at limit); dispatch loop guards `aborted || stopDispatch`; then
  `await Promise.allSettled(activeTasks)` BEFORE the commit phase.
- Progress counter moves from dispatch (`processed++`) to completion (`settled++` in
  finally); keep `Progress: N/M` format and the >10/every-10 threshold.
- Everything from line 469 on (pure-delete revalidation ×2, requeue loop, insertBatch →
  deletePathsExcludingIds ordering, meta apply, catch/finally) stays serial and
  UNCHANGED. Revalidation-loop concurrency explicitly out of scope.

**Semantics to preserve.**
- Abort: in-flight processFile rejects promptly (pool.enqueue abort listener, pool.ts:
  553-571); tasks return without touching retryFailures/completed; 484-488 requeues all
  non-completed with failed=false → no retry budget on abort (generalizes the existing
  test at project-batch-processor.test.ts:105 from 1 file to N). `close()` must still
  await full settlement — no fire-and-forget tasks.
- Disk pressure: keep single `checkDiskPressure()` sample before the loop (test asserts
  calledOnce); critical → return after classification, before cache check — deletions
  still commit, no worker dispatch under critical pressure. Flush-phase ENOSPC handling
  untouched.
- Don't abort in-flight on stopDispatch — let them settle.
- Pool mock in tests/setup.ts has no `isHealthy` by default — do NOT add new
  `isHealthy()` call sites or directory-delete/policy-parity tests throw.

**Expected side effects (not regressions).** Concurrency N materializes N forked
workers during active indexing; idle reap returns to 1 after 60s. K projects × N tasks
just queue in the pool (FIFO interleave) — no cross-project semaphore in this pass.

**Verification.** Existing: project-batch-processor (27 cases — esp. :76 close-waits,
:105 abort, :141/:168 force generations, :331-:372 retry budget, :425-:528 disk
pressure, :546 revalidation, :595 re-classify), directory-delete.test.ts:72 (single
deletePaths call = don't flush per task), ingestion-policy-parity (path-set parity).
New (deterministic via `concurrency` option): actually-parallel (3 in flight, +1 on
resolve); limit==1 strictly sequential; out-of-order completion → complete flush;
insert-before-delete ordering; abort with N in flight (pendingFiles=5, retryCount
empty, no insert); unhealthy pool stops dispatch (≤ limit+1 calls); critical pressure
with concurrency>1 (no processFile, unlinks still delete); progress log non-decreasing.
Soak: touch ~200 files → batch wall time ~3× better, pool spawn lines appear,
concurrent search stays fast, reap to 1 after idle.

**Do-nots.** No mid-batch flushing (breaks directory-delete:72 + delete-excluding-ids
invariant); no moving requeue/revalidation/flush into tasks; no changes to
MAX_BATCH_SIZE/DEBOUNCE_MS/MAX_RETRIES/batchTimeoutMs; no new env var; no cross-project
throttling.

### Phase 4 — Write-gated LanceDB maintenance ✅

**Defect (verified).** Every 5-min tick unconditionally: createFTSIndex (takes the write
gate for a full openTable/schema round trip), `optimize(5,0,true)` (retention 0 →
all-or-nothing compact+prune, the ~1.7GB spike), a SECOND write-gated ensureTable, and a
**synchronous recursive getDirectorySize walk of the multi-GB store on the event loop**
(vector-db.ts:1012) — plus optional 2s-sleep + second optimize on bloat. Searches stall
because searcher.ts:519 ensureTable → withWriteGate spins on `compactingPromise` for the
whole optimize. Precedent to generalize: syncer.ts:731-742 already runs maintenance only
when data changed; compactIfNeeded (write-driven, threshold 50 frags) already exists.

**Mechanism: monotonic write epoch + on-disk version probe.**
- Fields: `writeEpoch` (bump on every committed mutation), `maintainedEpoch` (-1 =
  never), `maintainedTableVersion` (from `table.version()` — confirmed in
  @lancedb dist/table.d.ts:485; metadata read, sees OTHER processes' writes),
  `lastMaintenanceMs`, `ftsIndexEnsured`.
- Counter not boolean: pass snapshots `writeEpoch` at entry, assigns
  `maintainedEpoch = snapshot` only on success → a write landing mid-optimize keeps the
  store dirty for the next tick. Never reset to 0.
- Instrument the 7 true commit points ONLY (NOT withWriteGate — ensureTable routes
  through it on every search and would pin the store dirty): insertBatch after
  `table.add` (:723); deletePaths + deletePathsExcludingIds inside their
  `existing.length > 0` branches (:1105,:1154 — guard already suppresses no-op
  versions); deletePathsWithPrefix unconditionally (:1170); updateRows after loop
  (:1120 — no callers today, future-proof); ensureTableUnsafe creation branch + each
  evolveSchema addColumns; withExclusiveTableMutation after mutation resolves (:391,
  drop()'s path). Leave optimize/createFTSIndex uninstrumented (self-perpetuating loop
  otherwise).

**Gates (two layers).**
- Timer pre-check in startMaintenanceLoop after the maintenancePromise guard:
  `if (!this.maintenanceDue()) return;` — sync, zero-IO: dirty || !ftsIndexEnsured ||
  hourly fallback due. Must be at the timer, not just inside runMaintenance: invoking
  maintenanceRunner takes a shared OperationCoordinator slot (blocks exclusive
  repair/rebuild; defers maybeRecycle via activeCount) and sets maintenancePromise —
  a no-op tick should do neither. `CLEAN_MAINTENANCE_INTERVAL_MS = 1h`.
- runMaintenance gains `{force?: boolean}`. Clean + fallback-due path = **version probe,
  not optimize**: `openExistingTableUnsafe()` (NOT ensureTable — not write-gated, can't
  stall/be stalled, returns null on missing table without creating a version), compare
  `table.version()` to maintainedTableVersion; unchanged → re-arm and skip; moved →
  log "External store writes detected (vN → vM)" and run full pass. On success assign
  maintainedEpoch=snapshot, maintainedTableVersion, lastMaintenanceMs. Disk-critical
  early return updates NOTHING (retry next tick); disk-low single-pass DOES update.
- FTS flag: set true on createIndex success + "already exists" short-circuit; NOT on
  the warn-fallthrough; clear on rebuild branch, position-error drop, and panic-recovery
  rebuild. Fresh instance (startup, post-rebuild targetDb/restoredDb) → first tick
  always full pass. syncer.ts:740 passes `{force: true}` (its own change-detection is
  authoritative there).

**Why keep the hourly fallback (as probe).** Writers outside the daemon instance exist:
MCP servers (own VectorDB; FTS rebuild on position-error or schema evolution commits
versions), `gmax doctor` optimize(3,0), `gmax add` deletePathsWithPrefix. In-daemon and
IPC-delegated paths are epoch-covered; standalone index/remove fallbacks self-maintain.
The probe closes the external-writer hole for one metadata read/hour vs 24×1.7GB blind
optimizes.

**Bloat-retry fix (same idle-cost defect).** Track `lastOptimizeDidWork` (true iff
fragmentsRemoved/oldVersionsRemoved/bytesRemoved > 0; false on "Nothing to do"/ENOSPC);
guard the ensureTable+getDirectorySize+retry block (:964-981) on it, and use
openExistingTableUnsafe instead of a second write-gated ensureTable. (Returning stats
from optimize() is cleaner but changes a signature used by doctor.ts:551 + tests —
private field is lower-risk.) compactIfNeeded needs NO gate (write-driven by
construction).

**Edge cases.** Missing table → probe returns null, ftsIndexEnsured false → full pass
creates it; corruption → pass never completes → epoch stays behind → keeps retrying
5-min with existing hourly log rate-limit (do NOT mark clean on failure);
maintenanceRunning shared with compactIfNeeded → early return leaves epochs untouched;
don't gate on activeWrites/compactingPromise (liveness, not dirtiness). Stub tables in
tests lack version() — keep it behind `.catch(() => null)` and only in the fallback
branch (vector-db-exclusive-mutation.test.ts:272's stub would otherwise throw).

**Verification.** Existing net: vector-db-exclusive-mutation (:272 runs on virgin
instance via ftsIndexEnsured=false — confirm), vector-db-optimize-recovery (panic-path
flag toggles must not disturb), syncer-reset-safety/cache-coherence (see new force arg),
batch-processor/watcher/daemon-rebuild/shutdown suites (call-shape guards). NO existing
test exercises the timer — that gap is why this shipped. New
tests/vector-db-maintenance-gate.test.ts (fake timers + stubbed ensureTableUnsafe,
pattern from optimize-recovery): clean-idle skips (no optimize/FTS/getDirectorySize,
isMaintenanceActive stays false); first tick always runs; each of the 6 mutation methods
dirties; no-op delete stays clean; N searches don't dirty (anti-regression for the
withWriteGate decision); write-during-maintenance not lost; hourly probe unchanged→skip
/ moved→full pass; zero-stat optimize skips bloat probe; close() mid-pass awaits, close()
after skip returns fast. Live: 30-min idle → zero optimize lines + flat RSS (vs 6 spikes);
touch file → exactly one pass; 12h idle soak → doctor fragment/version/disk-ratio flat;
MCP searches from another process → probe skips or runs once; no search p99 outliers at
5-min boundaries.

**Out of scope.** Changing MAINTENANCE_INTERVAL_MS / retention / threshold; async
getDirectorySize (gating removes it from the idle path); MCP-via-daemon (Phase 5).

### Phase 5A — Route MCP search through the daemon ✅ (ship BEFORE 5B)

**Scope.** Eliminates the duplicated embedding worker per MCP session (fork + Granite +
ColBERT load, the 300MB–1GB item). Does NOT remove the per-session LanceDB working set —
getVectorDb() has ~24 call sites (peek/extract/trace/graph/audit/similar) with no IPC
equivalent; out of scope. handleSimilar (mcp.ts:2532) is raw vectorSearch, stays local
(possible "similar" IPC command = follow-up).

**Feasibility (verified).** Request/response shapes map 1:1: handleDaemonSearch returns
`{ok, data: ChunkType[], warnings?, ...}`; mcp.ts consumes exactly result.data/.warnings
(:585-600). IPC accepts query/limit/filters/pathPrefix/rerank/seeds; cross-project
`search-v2` requires filters.projectRoots and rejects pathPrefix — matching mcp.ts's
existing scope:"all" branch (:445-462, :498-511).

**Changes (all in mcp.ts).**
- New `daemonSearch(args): Promise<SearchResponse | null>` next to getSearcher()
  (:376-379); dynamic-import sendDaemonCommand (already done at :2653/:2686);
  `{timeoutMs: 60_000}` matching search-run.ts:141. null → fall back to local Searcher;
  throw → surface to user.
- Three call sites become try-daemon-else-local: handleSemanticSearch (:556,:579-585),
  handleDiffChanges query mode (:2266-2273), handleBuildContext (:2583-2589). Wire
  projectRoot = resolvedRoot (umbrella resolution :424-434), never findProjectRoot's.
- Fallback partition (wider than the CLI's, MCP must degrade not error): fall back on
  ENOENT/ECONNREFUSED, "project not watched", "daemon not ready", "oversize" (2MB line
  cap), unknown-command (daemon older than binary — version-skew, ipc-handler:212-216).
  Surface as tool error: "stale_embedding" (has repair hint), projectRoots validation
  errors (falling back would run a DIFFERENT scope than what the daemon rejected).
- Daemon startup: fire-and-forget memoized ensureDaemonRunning() at server start (it
  polls up to 30s — NEVER block a tool call on it); first search gets short timeout +
  immediate local fallback. Note: `void ensureWatcher()` at :494 can race the first
  search → "project not watched" is in the fallback set.
- Keep client-side assertEmbeddingSearchCompatible (:553,:2578) — better message when
  daemon is down. Keep allowedRoots re-filter/prefixNotes untouched (operate on
  result.data). Searcher is lazy and its pool only forks on first encodeQuery — not
  reaching getSearcher() is sufficient; no restructuring.

**Latency.** Socket round trip sub-ms; ≤50 pointer-detail records = tens of KB. Beats
in-process first query by a mile (fork + model load + cold openTable ~10-15s on 5GB
store per daemon.ts:490-497). Real cost is cross-session contention on one pool
(MIN_KEEP_WORKERS=1) — intended trade; cancellation already wired (socket close aborts).

**Verification.** Exported fallback predicate tested like search-run-fallback.test.ts;
extend mcp-search-result-shape + ipc-search-scope tests. Live stdio smoke (the
mcp-server-migration acceptance bar): search / scope:"all" / diff_changes / build_context
with daemon up then down — byte-identical results modulo latency. Process check: daemon
up → `pgrep -P <gmax-mcp pid>` shows NO forked worker; daemon down → worker appears
(fallback proven live). RSS of gmax-mcp with 3 concurrent sessions = headline number.
Scope safety: allowedRoots post-filter identical on daemon path (check cross-project).

### Phase 5B — ANN vector index (IVF_FLAT) ⏭ rejected by soak gate

**Correction to the review doc.** LanceDB 0.30 `.where()` prefilters by default
(postfilter is opt-in, never used here). The defect: no vector index → nothing to prune
→ prefilter degenerates to a full scan of the vector column; and no scalar index
accelerates `starts_with(path,…)` either. Fix both halves.

**Index choice: IVF_FLAT, l2, NOT IVF_PQ, NOT HNSW.** Vectors are small (384×4B; 185k
chunks ≈ 285MB — the 16GB store is content/colbert/skeletons, not vectors) so PQ buys
nothing and costs recall; IVF_FLAT keeps `_distance` exact (refineFactor unnecessary —
it's PQ-only and with PRE_RERANK_K=500 would fetch 2000-5000 rows); HNSW is wrong for
the continuous-rewrite watcher regime. Metric l2 deliberately: query path never sets
distanceType (l2 default), vectors are L2-normalized (granite.ts:109-118) so l2 rank
order ≡ cosine, and mcp.ts:2549 computes 1/(1+_distance) against a user threshold —
cosine would silently change its meaning. Config:
`Index.ivfFlat({distanceType: "l2", numPartitions: clamp(round(sqrt(rowCount)), 64, 2048)})`,
`{name: "vector_idx", replace: true}`. ivfPq = deferred escalation only if size/RSS hurts.

**Companion btree on `path`** (high-cardinality string; bitmap wrong) — LanceDB docs
recommend scalar indexes on prefilter columns; also helps FTS branch. ⚠ Verify
empirically that Lance pushes starts_with() through the btree; if not, the durable fix
is a low-cardinality `project_root` column + bitmap index = schema change + reindex →
DEFERRED, do not fold in.

**Build mechanics.** `VectorDB.createVectorIndex(rebuild=false, retries=5)` mirroring
createFTSIndex exactly (withWriteGate + Unsafe body + conflict/Retryable backoff +
"already exists" = success + warn-never-throw). Gates: row-count ≥ GMAX_ANN_MIN_ROWS
(default 50k; use table.countRows() — countRowsForPath is per-prefix and wrong);
idempotency via listIndices() unless rebuild || indexStats distanceType ≠ l2 (metric
drift guard) || numUnindexedRows/numIndexedRows > 0.2 (staleness); checkDiskPressure()
skip on low/critical (IVF_FLAT ≈ duplicates vector column on disk). Call sites: (1)
runMaintenance() after createFTSIndex before optimize — PRIMARY hook (write-gated by
Phase 4); (2) search-run.ts:269 after initialSync for CLI first-run; (3) daemon warmup
:507 CHECK-ONLY (listIndices + threshold; a 185k-row train on startup would block the
hot path — schedule via runMaintenance instead). Do NOT build lazily from
Searcher.search (FTS bootstrap pattern doesn't transfer — IVF training is expensive).
⚠ Open question: does table.optimize() fold new rows into the vector index in the JS
binding? Verify via indexStats numUnindexedRows before/after; if not, runMaintenance
issues explicit replace-rebuild at >0.2 ratio. Latency-only either way (unindexed tail
is brute-forced and merged — never a correctness issue).

**Query side (searcher.ts:574-578).** Add `.column("vector")` (table has TWO
FSL-float columns — 384 and 48-wide; today disambiguated by query width, latent trap
once indexed) at all six vectorSearch sites: searcher.ts:574, mcp.ts:2532,
similar.ts:113, surprising-connections.ts:671, eval-graph-sanity.ts:96,
eval-graph-recovery-probe.ts:79. Add `.minimumNprobes(20)` + `.maximumNprobes(200)` —
excess partitions probed only when results starve, which is exactly the
narrow-prefilter-in-shared-table case, free otherwise. NO refineFactor; NO postfilter()
(would starve the RRF pool below PRE_RERANK_K). Env: GMAX_ANN_NPROBES,
GMAX_ANN_MAX_NPROBES, GMAX_ANN_MIN_ROWS, kill switch GMAX_ANN=0 (+ bypassVectorIndex for
A/B). Blast-radius note: everything after retrieval (RRF → STAGE1 pooled cosine →
ColBERT rerank) is exact — ANN error can only be candidates-never-generated, so
overlap@K is the right primary metric.

**Risks.** Training slow/memory-hungry → only inside runMaintenance under gates; commit
conflict → reuse FTS backoff verbatim; Rust panic during merge (precedent: FTS merge
bug, commit 9b012b2, vector-db.ts:885-912) → one-shot drop+rebuild with
annPanicRecoveryExhausted latch, then give up loudly; recall on narrow prefilters →
maxNprobes 200 + D2 probe; disk ~+300MB/200k rows → pressure gate + report in doctor.

**Verification.**
- D2 recall probe (primary): standalone script on the eval-graph-sanity pattern; ~50
  queries from eval.ts cases; same vectorSearch twice — normal vs `.bypassVectorIndex()`
  (documented as existing exactly for recall ground truth). overlap@500 acceptance:
  mean ≥ 0.95, min ≥ 0.90; sweep nprobes until met; run scoped AND unscoped (scoped is
  the at-risk case).
- D3 e2e: bench:recall:json + GMAX_EVAL_RERANK=1 variant + bench:oss:json, baseline
  (no index) vs indexed. Acceptance: mrrAt10/recallAt10 within −0.01 absolute, ZERO
  cases flipping found true→false (one flip ≈ 2% MRR = blocker), avgTimeMs drops
  materially on the 185k project. (eval.ts is in-process — unaffected by 5A; don't use
  it to validate 5A.)
- D5 soak behind GMAX_ANN=1: hour of watcher edits → numUnindexedRows grows,
  runMaintenance re-folds, no conflict/panic log entries, doctor reports cleanly (add
  index presence + unindexed count to doctor output as part of this change).
- Unit: createVectorIndex idempotency/replace/threshold-skip/metric-mismatch/conflict
  retry (pattern: vector-db-optimize-recovery, vector-db-schema-dim).

**Measured outcome (2026-08-04).** The live 305,829-row IVF_FLAT index failed the
overlap gate and was dropped. Default probes measured unscoped mean/min overlap
**0.947/0.720** and scoped **0.835/0.382**; fixed 200-probe results were slightly worse.
ANN therefore remains disabled. The companion `path_idx` was retained: scoped exact
K=500 latency improved from 25.2 ms to 2.7 ms (about 9.5x) without changing retrieval.

## Deferred

- Nested-definition duplicate chunking (T4) — semantic change to chunk output; needs
  recall benchmarking; separate effort.
- Embed pipeline overlap / batch-size / clear_cache / ColBERT bucketing (T3) — worthwhile
  but below the fold; revisit after Phases 1–3 land.
- Classification dedup (T5), splitByChars O(L²) (T6), searcher row-hydration (S2),
  double-serialization (S4), heartbeat execSync (S5), graph N+1 (S6) — tracked in the
  review doc; pick up opportunistically.

## Version History

- **2026-08-04T10:54:22Z** Archived — Shipped in 7b6349c; ANN rejected by recall gate; exact search retained with path btree.
- **2026-08-04** Implementation complete in the working tree. Phase 1B retained
  1536 MB from measured ONNX p95; Phase 5B was rejected by recall measurement; all tests,
  typechecks, Biome, and whitespace checks pass.
- **2026-08-04T09:06:57Z** Started (active → in-session).
- **2026-08-04T08:22:27Z** Created.
- **2026-08-04** All five phase specs finalized from Opus agent drafts: 1A/1B (tree
  leak + threshold), 2 (IPC serialization — incl. the coerceColbertBytes Uint8Array
  hazard), 3 (batch concurrency), 4 (write-gated maintenance — epoch + version probe),
  5A/5B (MCP-via-daemon + IVF_FLAT ANN index). Rollout order decided: 1A → 2 → 3 → 4 →
  5A → 5B.

## Closeout

Phases 1A, 2, 3, 4, and 5A passed their acceptance gates. Phase 1B completed as a
measurement-only disposition: the formula supports retaining the existing 1536 MB
default, and the proposed 1024 MB override was rejected. Phase 5B's implementation and
diagnostics remain flag-gated, but production ANN was rejected and its live vector index
was removed after poor scoped recall; the independently beneficial path btree remains.
Nested chunking and the lower-priority review findings remain deferred as listed above.
Implementation and public architecture docs shipped in `7b6349c`; documentation index
references shipped in `1553580`.
