---
type: plan
status: active
created: 2026-11-05T17:30:00Z
updated: 2026-11-07
surfaces:
  - daemon
  - watcher
  - workers
modules:
  - src/lib/index/batch-processor.ts
  - src/lib/workers/pool.ts
  - src/lib/store/vector-db.ts
  - src/lib/store/store-lease.ts
  - src/lib/search/searcher.ts
  - src/lib/daemon/process-manager.ts
  - src/lib/daemon/daemon.ts
  - src/index.ts
domain: Catch-up throughput under a CPU-quota service, stale daemon markers and false startup warnings
audience: internal
parent_plan: docs/plans/gmax-delivery.md
related_plans:
  - docs/plans/gmax-delivery.md
  - docs/plans/gmax-p3-container.md
current_state: "Steps 1-6 and the batch-timeout and hard-deadline fixes run on the P3 as a local build of 6ec8970 at 400%; no public release."
next_step: "Owner answers Q2-Q5; the P3 runs a local build of the commit at 400%."
summary: "Catch-up embeds 1 file per batch because the 2 s background window cuts every slow batch and the pool admits 1 background file at 2 CPUs; Q1 sets the CPU and search trade-off."
---

# Catch-up throughput and daemon startup on the P3

Planned 2026-11-05 from source at `ff4941d` and the P3 service journal. Installed: 0.26.110 under the user systemd unit with `CPUQuota=200%`, `CPUWeight=10`, `Nice=10`, `WorkingDirectory=%h`; config Small/384d/CPU, `workerThreads` 4. `gmax status` reports 2 effective CPUs, 4 configured workers (automatic default 2) and a background indexing allowance of 1 file. The P3's largest project (`<repo>`, about 2,140 catch-up files pending at 16:56) is the subject.

## Findings

### 1. Catch-up runs 1 file per batch

4 limits stack. Limits 1-3 shrink each batch to 1 file plus a 2 s gap; limit 4 holds throughput at 1 file in flight:

- **The 2 s background window cuts every slow batch.** `src/lib/index/batch-processor.ts:808-813` stops dispatching background work once 1 file has settled and 2 s (`BACKGROUND_DISPATCH_WINDOW_MS`, :54) have passed, whether or not live work is waiting. A changed file takes 3-170 s to embed, so each batch embeds exactly 1 file.
- **Catch-up batches hold at most 4 files** (`MAX_CATCHUP_BATCH_SIZE`, :53, applied at :491-495) against 50 for live and cleanup (:52).
- **Catch-up runs at concurrency 1** (:785-788, `kind === "live" ? this.concurrency : 1`).
- **The pool admits 1 background file across all projects** at 2 CPUs: `fileCpuLimit = effectiveCpus - 1` (`src/lib/workers/pool.ts:351`), `backgroundIndexingLimit = min(fileCpuLimit, maxWorkers - 1)` (:382-384), enforced in `canDispatch` (:436-443). Half the quota is held back for queries.

Each ONNX session is single-threaded (`ONNX_THREADS = 1`, `src/lib/workers/embeddings/granite.ts:10`, `colbert.ts:7`), so 1 file in flight uses at most 1 of the 2 CPUs the unit allows.

**Origin.** Limits 1-3 arrived together in `bad7365` (2026-10-07, 0.26.63, "prioritize live edits over watcher catchup and cleanup"); before it, catch-up shared the 50-file batch at the live concurrency. README.md:519 documents the behaviour as intended. The aim was live-edit latency, not thermal containment or lock cancellation. Limit 4 arrived in `b7066b8` (2026-10-28, 0.26.105, "honor CPU quotas and share background worker admission"). The `601cdda` root on `main` is grafted; the full history is reachable with `git log --all`. Retained rollback installs 0.26.103 to 0.26.109 all carry limits 1-3.

**Journal, 2026-11-05 boot (55 batches, 16:33 to 16:56):** 46 batches reported "4 files, 1 reindexed", 4 reported 2, 2 reported 0. Mean batch time 23.4 s, about 2 s between batches. The last 12 batches cleared 13 files in about 212 s, 16 s per file; over all 55 batches it is about 25 s per file with the gap. The 2 batches with 0 reindexed left `remaining` unchanged (2190, 2171), so their first file was requeued too, most likely as a retry after an mtime change during embedding; step 1 records the reason.

**The files changed.** Sampled pending files (5 under the project's plan folder) have mtimes and commits from 06:16 to 06:27 the same morning, so this backlog is real re-embedding work, not cache misses. Whether chunk reuse is working on these edits is unmeasured (step 1).

### 2. The other 3 files are requeued untried

They are not cache hits and not deferred by the pool. The batch removes all 4 from `pending` (:535); the window break leaves 3 outside `completed`; the requeue loop (:851) calls `requeuePath(..., false)`, which re-inserts them through `enqueueWork` at the tail of the `pending` map (:240). The queue acts as a ring: 1 file leaves per batch and 3 rotate to the back with no retry charge. The journal shows this as alphabetical runs that skip 3 names per batch.

The log line misreports it: "Batch complete: N files" prints `batch.size` (:906-909) while `recentBatches` records `settled` (:899).

Unchanged files are already cheap when they reach `processOne`: stat match (:627-636) or in-process hash (:638-659), with no worker. The cost is the slot they occupy in a 4-file batch that the window then cuts.

### 3. An empty `daemon.pid` blocks startup permanently

`ProcessManager.assertStartupAvailable` (`src/lib/daemon/process-manager.ts:77-112`) throws "Cannot verify daemon marker" for any marker that is empty or not digits (:84-98). The daemon writes the marker with a plain `fs.writeFileSync` after the socket is listening (`src/lib/daemon/daemon.ts:546`, :560 at HEAD), which truncates first, so an interrupted start can leave 0 bytes. The journal for 2026-11-05 has 247 refusal lines from 08:15 until the file was removed by hand, and `Restart=on-failure` / `RestartSec=1s` kept retrying.

### 4. False legacy-index warning on every daemon start

`src/index.ts:67-75` checks `<cwd>/.gmax/lancedb`. The unit's working directory is the home directory, so the check finds the central store itself and prints "Legacy per-project index detected at ~/.gmax" on every start.

### 5. Configured workers above the CPU quota

`maxWorkers = CONFIG.WORKER_THREADS` (`pool.ts:345`) is not bounded by effective CPUs. With 4 configured and 2 CPUs, the pool may hold 4 model-loaded workers (about 1 GB each, per the comment at `batch-processor.ts:68-72`) that can never run in parallel. `gmax status` already prints the automatic default beside the configured value.

### 6. Search during catch-up

- **"Results may be incomplete" is the queue, not the search.** The footer adds it whenever `pendingFiles > 0` (`src/lib/output/index-state-footer.ts:84-100`); it says nothing about the 17 s.
- **The 17 s is unattributed.** Query encoding goes through the same pool (`src/lib/search/searcher.ts:575`). With 1 worker busy on a 3-170 s file, a query either waits for it or waits `SCALE_UP_WAIT_MS` and cold-spawns a model-loading worker (`pool.ts:933-950`, `SCALE_UP_WAIT_MS` at :277) under a quota the busy worker already half uses. This boot's journal shows 1 spawn only (16:30:15, "1/4"), and no search timestamps, so which of the 2 happened is not yet known.

### 7. Per-chunk cost on the P3 (measured 2026-11-05)

Standalone on one P-core at nice 10 with the installed models and real chunks from `<repo>` plan docs (measurement scripts not committed):

| Model file | Threads | Dense ms/chunk | ColBERT ms/chunk |
|---|---:|---:|---:|
| granite small `model_q4.onnx` (installed) | 1 | 138.7 | 53.3 |
| granite small `model.onnx` (fp32) | 1 | 145.5 | 46.3 |
| granite small `model_quantized.onnx` (int8) | 1 | 79.8 | 47.1 |
| `model_q4.onnx` | 2 | 73.5 | 28.6 |

- About 190 ms per chunk at 1 thread, the same as the service: a 554-chunk plan took 108.9 s in the journal (196 ms/chunk). Dense at 256 tokens is about 15 GFLOP per chunk, so 139 ms is about 110 GFLOPS on one core: the inference runs near the core's FP32 rate, not slowly. Per-file time is chunks to embed times 0.19 s.
- q4 is no faster than fp32 on this x86 CPU. int8 is 1.74x faster for dense, but its vectors differ from q4 (cosine mean 0.975, min 0.968 over 32 chunks; fp32 vs q4 0.985), so adopting it is Q3.
- The Mac embeds dense on the GPU through MLX and runs only ColBERT on the CPU, so its per-chunk CPU cost is about a quarter of the P3's. Its own watcher catch-up is slow on large docs too ("3 files, 1 reindexed (181.5s)", "11 files, 9 reindexed (150.2s)" in its watch log); its fast runs are bulk indexing, which has none of the catch-up limits in finding 1.

### 8. Small edits re-embed whole files

Chunk boundaries are absolute offsets: `splitByChars` (`src/lib/index/chunker.ts:1253`) cuts every 1,800 characters from the start of an oversized block and `fallbackChunk` (:1278) every 65 lines. Inserting lines near the top of a file shifts every later window, so no chunk text matches a stored reuse key. A 2-line frontmatter insertion in a 41-chunk plan left 0 of 41 chunks reusable; a 554-chunk plan with mid-file edits kept 525 to 535. The 2026-11-05 backlog came from commits that inserted 2-3 frontmatter lines into about 1,000 plans, so nearly every chunk re-embeds. Content-anchored boundaries are Q4; changing them re-keys every stored chunk once.

### 9. Large files time out forever, and batches fail on Lance query timeouts

- **Batch timeout.** The batch aborted after 180 s of wall clock (`batchTimeoutMs`, `max(1.5 x task timeout, 120 s)`), and the pool killed any task after 300 s (`HARD_DEADLINE_MS`, sized for MLX). On the CPU path a file over about 900 chunks, or a smaller one under quota throttling, can never finish: the 2026-11-05 journal has 25 "Batch timed out after 180000ms" lines, and one 554-chunk plan was processed 148 times since 2026-11-04 with batches of 174 s and 129 s that reindexed nothing. 58 of 636 batches that day (1,596 s of 20,026 s) reindexed nothing.
- **Lance query timeouts.** 24 batches failed with "Query timeout after 15000 ms" and lost every file in them. The P3 store has only the FTS index (`listIndices`: `content_idx`); the path btree is absent and containment does not build it, so each per-file reuse lookup and path delete scans the 666k-row table (350-475 ms idle, read-only probe). Building it is Q5.

### 10. Search takes 7.5 to 9 s with the queue idle (measured 2026-11-07)

5 queries through the installed CLI took 7.49 to 8.96 s wall with `catchup=0 live=0 active=0` on 667k chunks. The CLI uses the daemon (0.24 s user CPU; `gmax --version` 0.24 s wall) and query encoding takes 7 to 13 ms (`encodeQuery` lines). A read-only probe of the same store at 4 CPUs and nice 10 split the rest:

| Stage | Time |
|---|---:|
| FTS `table.search()` | 6.1 to 6.5 s |
| Flat vector search, no filter | 0.6 to 0.75 s |
| Flat vector search with `path LIKE '<root>/%'` | 0.9 to 1.1 s |
| `path = ...` lookup | 0.30 to 0.34 s |

- **FTS is mostly unindexed.** `content_idx` (built 2026-10-26, 49 segments) covers 353,105 rows; 315,467 (47%) are unindexed and Lance scans them on every search. Under containment nothing refreshes it: the daemon only adopts the index (`createFTSIndex`, `vector-db.ts`), and `gmax fts-refresh` is explicit-only. That is Q6.
- **A torn reader marker blocks all exclusive store work.** `lancedb.lease/readers/<nonce>.json` was 0 bytes from 2026-11-05 07:09:17, 2 minutes before an unclean reboot (kernel boots at 07:09:10 and 07:11:13). `liveReaders` (`src/lib/store/store-lease.ts`) counted any unreadable marker as a live owner forever, so every exclusive acquisition timed out: the hourly "Version cleanup deferred: Timed out waiting for shared store owners to close" since then, and `gmax fts-refresh` would refuse the same way.
- **No path B-tree.** The project prefilter and every per-file lookup scan the table. Lance 0.41 answers `path LIKE 'prefix%'` and `path = ...` from a B-tree (`ScalarIndexQuery ... @path_idx(BTree)` in `explainPlan` on a synthetic table).
- **The vector floor.** The flat scan reads 667k 384-d vectors across 11,481 data fragments; with compaction contained and IVF opt-in (`GMAX_ANN`), 0.6 s is the floor for this stage.

Fixes (local commit):

- `liveReaders` moves a reader marker that is a regular file and still unreadable after 60 s to `lancedb.lease/quarantine/<name>.unverified-<ms>` and logs it. Markers land by rename (`writeOwnerAtomic`), so a live owner's marker is never partial; symlinks and other entries still block.
- `VectorDB.ensurePathIndex` builds `path_idx` when missing and replaces it when its unindexed tail passes 20% of indexed rows, so appends and table rewrites that drop coverage are caught. Owner-only, disk-pressure gated, through the write gate. Under containment there is still no maintenance timer: the daemon checks once at start and after committed writes, at most every 5 minutes.
- The daemon logs each search as `[search] <total>ms: encode, vector, fts, rerank, results, ms in handler` from `Searcher.lastTimings`.

## Plan

One batch; each step lists its tests. Live-edit priority from `bad7365` stays.

1. **Measure before tuning, from existing logs only.** Add per-file elapsed and reused-chunk counts to the `Processing`/`Batch complete` lines, and query queue-wait vs encode time to the search handler's debug line. No new diagnostics surface.
2. **Catch-up batching** in `batch-processor.ts`:
   - Remove the elapsed-time half of the break (:811); background work yields only when live work is ready (`hasReadyLiveWork`), on pause, or on abort.
   - Raise catch-up to `MAX_BATCH_SIZE` and commit to the store every N settled files or every 30 s inside the batch, so a long batch still publishes progress and a pause loses at most one file of work.
   - Run catch-up at the pool's background allowance instead of 1 (:786).
   - Log settled, reindexed and requeued counts separately.
   - Tests: extend `tests/project-batch-processor.test.ts` (fake clock, mocked worker): a slow first file no longer requeues the rest; a live save still preempts between files; pause mid-batch requeues only unsettled files.
3. **Background admission at low CPU counts** in `pool.ts`: when no query or live task is queued, admit background files up to `effectiveCpus` (2 here); return to `effectiveCpus - 1` as soon as a query or live task arrives. A running `processFile` cannot be preempted (`batch-processor.ts:65-66`), so with step 4's cap a query that arrives while 2 files run waits for the shorter one; only a third worker over the quota avoids that. Q1 decides which. Tests: admission with 2 and 4 effective CPUs, query arriving mid-catch-up.
4. **Workers vs quota:** cap the effective `maxWorkers` at effective CPUs and log once when config asks for more; `gmax status` shows configured and effective. Tests: config 4 with 2 CPUs gives 2 and a warning.
5. **Stale marker:** write `daemon.pid` by temp file and rename. In `assertStartupAvailable`, an empty or unparsable regular-file marker gets a connect probe of the daemon socket: an answer refuses as today; `ENOENT` or `ECONNREFUSED` renames the marker to `daemon.pid.unverified-<timestamp>`, logs it, and continues. No unlink and no signal, consistent with "Neither a PID nor a title permits termination" (:77). Symlinks, non-files and unreadable markers still refuse. The socket `listen` (`daemon.ts:546`) stays the final arbiter, so 2 starters racing after a quarantine end with one `EADDRINUSE` refusal, not 2 daemons. Tests: empty marker with no socket starts; empty marker with a live socket refuses; symlink refuses; a listen failure is fatal.
6. **Legacy warning:** skip when `realpath(<cwd>/.gmax)` equals the configured home store; keep it for a real project-local `.gmax`. Tests: cwd at home is silent; a project with its own `.gmax/lancedb` warns.

Then one release and one same-unit handover, per the delivery plan's procedure.

**Implemented** (local commit, no public release):

- Step 1: `Embedded <file>: N chunks, R reused (Ts)` per file, `Batch complete: S settled, R reindexed, Q requeued`, and `encodeQuery waited Wms, encoded Ems` from the pool (`src/lib/workers/pool.ts`).
- Step 2: catch-up batches of 50, no 2 s window, background concurrency `min(batch concurrency, pool background allowance)`, commits every 10 settled files or 30 s (`BACKGROUND_COMMIT_FILES`, `BACKGROUND_COMMIT_MS`).
- Step 3: under Q1 (c) admission stays `effectiveCpus - 1`, so 400% gives 3 background files and 1 worker for queries; no admission change.
- Step 4: `cappedWorkerCount` caps workers at effective CPUs and warns once; `gmax status` prints configured and effective workers.
- Step 5: `daemon.pid` is written through a temp file and rename; an empty or unparsable marker is renamed to `daemon.pid.unverified-<ms>` only when the socket probe gets `ENOENT` or `ECONNREFUSED` (`src/lib/daemon/process-manager.ts`).
- Step 6: `findLegacyProjectIndex` (`src/lib/utils/legacy-index.ts`) skips the central store.
- Finding 9 fix: the batch aborts only after no file settles for `max(1.5 x task timeout, 120 s, hard deadline + 60 s)`, and the hard deadline is 30 min in CPU mode, 5 min with MLX (`src/lib/workers/task-deadline.ts`).

## Measured after the change (P3, 2026-11-05)

Local build of `6ec8970` under the same unit at `CPUQuota=400%`; `gmax status`: 4 effective CPUs, 4 workers, background allowance 3 files. Journal 17:54:14 to 17:59:58 (5.7 min), while other sessions kept editing the project:

- 114 files embedded (about 20 files/min, against 2.4 to 3.8 before), 3,630 chunks, 1,440 of them reused; 0 batch timeouts, 0 failed batches, 0 Lance query timeouts.
- Pending fell from 2,183 to 2,102 while live edits added files, about 14 files/min net: roughly 2.5 h for the rest at that rate, 1.75 h at the gross rate.
- Files in flight averaged 1.3 of the allowed 3: catch-up batches yield to every ready live edit ("3 settled, 1 reindexed, 4 requeued") and wait for their slowest file before the live batch runs.
- Search during catch-up: `encodeQuery waited 0ms, encoded 324ms`; the CLI search took 9.7 s wall. Package temperature 74 to 76 °C in 3 samples, against a 110 °C trip point.

## Expected catch-up time

At 16 to 25 s per file (last 12 batches, all 55 batches) and about 2,140 files:

| Setting | Files in flight | Search during catch-up | Estimate |
|---|---:|---|---:|
| Today | 1, plus about 2 s between batches | as today | 10 to 15 h |
| Steps 2-4 at 200% | 2 | waits behind a running file | 5 to 7.5 h |
| Steps 2-4 at 400% | 3, 1 worker kept for queries | as today | 3.3 to 5 h |

Batching alone saves only the gap between batches; the gain comes from more files in flight. If step 1 shows chunk reuse is not working on these edits, fixing it shortens every row.

## Open questions for the owner

- **Q1 (answered: c).** 400% with 3 files in flight and 1 worker kept for queries, ruled in the host's session-host plan as P12. The ruling also rejected the 3.3-5 h estimate; findings 7-9 are the per-file cost it asked for.
- **Q2:** cap workers at effective CPUs silently with a log line (step 4, as built), or refuse a config above the quota at startup?
- **Q3:** keep q4 dense (as today), or move the CPU path to the int8 file: dense 1.74x faster, but vectors shift (cosine 0.975 to q4), so stored q4 vectors and new int8 vectors would mix unless the embedding generation changes and the store re-embeds once.
- **Q4:** keep absolute chunk windows (as today: a few inserted lines re-embed the whole file), or anchor boundaries to lines and content so edits re-embed only nearby chunks; the change re-keys every stored chunk, so each file re-embeds fully once on its next edit.
- **Q5 (answered).** Scalar indexes the search and per-file paths need (the `path` B-tree) are built and kept current under containment, as a narrow exception; every other full-table maintenance stays disabled (`ensurePathIndex`, `src/lib/store/vector-db.ts`).
- **Q6:** keep FTS catch-up explicit (as today: `gmax fts-refresh --run` with the daemon stopped, so `content_idx` falls behind on every store until someone runs it, and each unindexed row is brute-forced on every search), or let the daemon run the same bounded delta (100k rows, no data rewrite) in its exclusive version-cleanup window, so the index keeps up on its own; the second needs the refresh wired into that window and its tests.
