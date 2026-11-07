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
- Lease waits keep their poll timer referenced (`delay`, `store-lease.ts`): an unref'd timer let `gmax fts-refresh --check/--run` exit 0 with no output while the daemon held the store; it now prints the lease timeout and exits 1.

After installing the local build (`9012a66`) on the P3:

- The torn marker was quarantined on the first exclusive attempt; version cleanup then removed 1,057 versions in 9 passes of up to 128 (about 5 GB) and stays at 0 eligible.
- `path_idx` was built in 845 ms.
- 5 queries: 6.64 to 7.10 s wall; the daemon line shows fts 5.67 to 6.10 s, vector 0.65 to 0.99 s, encode 7 to 10 ms. Under 1 s is not reached: FTS still brute-forces 315,505 unindexed rows.
- **The daemon's own FTS repair refuses.** With version cleanup at 0, bounded maintenance (native `index-refresh`, the shipped automatic coverage repair for `content_idx` and `path_idx`) ran for the first time since the marker and failed after 53 s with "native cleanup admission or verification refused", the default category, so the native reason matched none of the disk, ledger, lease, version or index-fit patterns. The receipt is still the finalized one from 2026-10-28, so startup recovery does not pause the daemon. While it keeps failing it retries every 10 minutes and quiesces the watcher for each attempt; a search started as the 03:09:15 attempt began took 9.87 s against 6.6 to 7.1 s outside it. Its native reason is not surfaced; that is the next diagnosis, and Q6 covers catch-up meanwhile.
- **Offline `fts-refresh` cannot hold a window here.** `systemctl --user stop gmax.service` was followed by a start from systemd in the same second, from another session's gmax use (`fts-refresh` itself starts no daemon).
- Even with FTS caught up, vector 0.73 s plus about 0.25 s of CLI start sits at the 1 s line; the levers left (IVF under `GMAX_ANN`, compaction) are outside the Q5 exception.
- **After the compaction (2026-11-07 13:04 UTC, load 9.2 from other sessions):** the 5 queries took 0.54 to 0.76 s wall through the CLI; the daemon's `[search]` line shows fts 46 to 151 ms, vector 216 to 375 ms, encode 8 to 12 ms. The same morning before it: 7.67 to 10.60 s wall, fts 6.4 to 6.6 s, vector 0.97 to 1.29 s, at load 6 to 7. Under 1 s is reached, so this finding is closed; vector search stays at 0.2 to 0.4 s, under the 0.5 s line that would raise IVF. Same top hit on all 5; queries 4 and 5 swap 1 of 5 hits (Compaction, step 3).

### 11. A unit stop waits up to 90 s and the next CLI call undoes it (measured 2026-11-07)

`systemctl --user restart gmax.service` on the P3 before the fix:

- A started, idle daemon: 0.16 s, with and without a live worker.
- A daemon still starting (between "Watching 1 of 3 registered projects" and "Watching <root>"): 25.6 s. The journal has 40 s (04:52:09) and 53 s (05:01:52) earlier the same day.
- At 04:50:30 no shutdown step logged for 90 s, then systemd killed the daemon and its worker ("State 'stop-sigterm' timed out. Killing.").

Causes:

- **A stop during startup waits for the native subscribe.** The @parcel/watcher subscribe of a large tree on Linux cannot be cancelled and takes 25 to 50 s. Shutdown waited for it twice: `unwatchProject` (`src/lib/daemon/watcher-manager.ts`) awaited the in-flight `subscriptionUpdates` promise, and the operation drain waited for the startup `watch` operation, whose `watchProject` awaited the same subscribe. "Unwatched <root>" landed in the same millisecond the startup subscribe returned; with only the first fixed, the build logged "shutdown step operation drain took 24.4s".
- **The pool replaced the worker the stop signal killed.** `KillMode=control-group` signals every process in the unit. The worker exited before `destroy()` ran, late in `performShutdown`, so `handleWorkerExit` and `maybeRespawn` (`src/lib/workers/pool.ts`) forked a replacement ("respawn #1 after exit") during every stop with a live worker.
- **The exit waited for the subscribe too.** With both waits removed, a stop during startup logged "Shutdown complete" 10 ms after "Shutting down..." and the process still exited 31 s later: `process.exit` joins libuv's threadpool, which finishes the running native crawl first. A probe with a 4 s threadpool job: `process.exit` took 4.3 s, ending by the signal took 5 ms (status 143).
- **The backstop could not win.** `SIGNAL_EXIT_BACKSTOP_MS` (`src/commands/watch.ts`) was 90 s, equal to the unit's `TimeoutStopSec`, so a wedged step ended in SIGKILL with no record of which step. The 04:50 step is not attributable from that journal and was not reproduced, since the store was compacted after it.
- **A CLI call cancelled the stop.** Shutdown removes the socket and pid file first, so a CLI call during the drain finds no daemon and runs `systemctl --user start gmax.service` (`startUserDaemonService`, `src/lib/utils/service-startup.ts`). In the default job mode that start replaces the queued stop, and the unit starts again in the same second (finding 10, offline `fts-refresh`).

Fixes (local commit):

- `unwatchProject` does not wait for an in-flight subscribe once shutdown has begun, and `watchProject` stops waiting for it when its lifecycle is aborted; `subscribeWatcherNow` already unsubscribes when its processor was removed.
- A signal-driven daemon exit ends by that signal's default action once shutdown is complete (`gracefulExit(0, { bySignal })`, `src/lib/utils/exit.ts`), which skips the threadpool join; systemd counts death by SIGTERM as a clean stop.
- `WorkerPool.beginShutdown()`, called before the first await in `performShutdown`, stops every spawn and respawn, and fails queued work when the last worker exits.
- The signal backstop is 45 s and names the step it was stuck in; `performShutdown` logs any step that takes 1 s or more (`shutdown step <name> took <s>s`).
- The unit start runs with `--job-mode=fail`. A start while a stop job is queued fails ("Transaction for gmax.service/start is destructive", checked on the P3) and the CLI reports "gmax.service is stopping; a start would cancel that stop; no standalone daemon was started". An active or starting unit still succeeds, and a stopped one still starts.
- The host's unit uses `KillMode=mixed`, written by the host's unit script: systemd signals only the daemon, which ends its workers after the drain.

To hold a stop for maintenance: `touch ~/.gmax/autostart-disabled`, then `systemctl --user stop gmax.service`. While the file exists `daemonStartDeniedReason` (`src/lib/utils/autostart.ts`) refuses every CLI start of the daemon; remove it and start the unit when done.

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

## Compaction (Q7)

Measured read-only on 2026-11-07 (`table.stats()` on `chunks`): 33.4 GB, 668,702 live rows from 41,662 files, 614,924 deleted rows still stored, 10,712 fragments, all small (median 24 rows, p99 1,024). Every re-embed marks the old rows deleted and appends a new fragment; only compaction drops deleted rows and merges fragments, and full-table maintenance has been disabled since the October rewrite loop (a 15 to 18 GB rewrite about every 35 minutes). The fragment count is what makes `index-refresh` refuse (B1), leaves about 315k rows outside `content_idx`, and keeps the vector scan at 0.65 to 0.99 s.

1. **Compact a copy, not the live store.** Copy `~/.gmax/lancedb` under a held store lease (the unit restarts within a second when only stopped, finding 10), so the copy is one consistent version; the daemon then keeps serving the original. Free-space precheck: twice the store size plus the disk floor.
2. **One operator command, `gmax compact --once <store>`,** the only path past `fullTableMaintenanceDisabled()` (`src/lib/store/maintenance-policy.ts:14`). It refuses a store a daemon or another writer holds, refuses without the free space, compacts with deleted-row removal, rebuilds `content_idx` and `path_idx` over every row, and cleans old versions only after the result verifies. The automatic paths (`optimize()` at `src/lib/store/vector-db.ts:1853`, the daemon timers) stay contained. Tests: each refusal, the automatic paths still skipped, live rows and ids identical before and after on a fixture with deletions and many small fragments. Built: `gmax compact --once <store>` (`src/commands/compact.ts`, `src/lib/store/compact.ts`). It takes the store's exclusive lease with a 1 s wait (a daemon's shared marker refuses it), needs the table's size plus `DISK_CRITICAL_BYTES` free, streams the live rows of the current version into new fragments (the first write overwrites, so the version number keeps rising and the store's state files stay valid), rebuilds `content_idx` (`Index.fts({ withPosition: true })`) and `path_idx` (B-tree), and before it reports compares a sha256 of every column of every row, keyed by id, against the source version, the schema, 0 deleted rows, 0 unindexed rows in both indexes and every new data file's size. Any failure after the first write restores the source version as head. It refuses a table with any other index and never prunes versions; the daemon's version cleanup removes the old ones. Fragments are capped at 8,192 rows and about 16 MiB in memory (`--target-mib`), not merged into tens: bounded reclamation skips any fragment over 32 MiB or 32,768 live rows (`lance-maintenance/native/src/engine.rs:1166-1173` at `462fc9e`), and a fragment it skips is drained by row relocation at most 1,024 rows or 2 MiB per attempt (`relocation.rs:30-31`), about 85 rows of this store's 24 KB rows. At this store's row size that gives several hundred fragments, far under 4,096. Tests: `tests/compact.test.ts`, 6 of 6 (a fixture with deletions, 60 small fragments and an unindexed tail keeps every row and id; refusals for a held lease, free space and a missing `--once`; a failed index build restores the source; `VectorDB.optimize()` still skips after a compaction).
3. **Verify the compacted copy before using it:** the same live row count and ids as the copy's source version, 0 deleted rows, no fragment over 32 MiB or 32,768 rows (step 2), 0 rows outside `content_idx` and `path_idx`, and 5 search queries returning the same top results against both.
4. **Swap with the original kept.** Under the held lease, move the original aside as the backup and the compacted copy into place, then start the unit; its startup catch-up re-embeds the files changed since the copy, compared by hash. The backup stays until the owner says to delete it.
5. **Keep it from regrowing.** With fragments far under 4,096, the daemon's bounded maintenance (deleted-row reclamation, row relocation, `index-refresh`; `src/lib/store/bounded-maintenance.ts`) can run again. Confirm each operation completes on the compacted store, and record fragments and deleted rows for 2 days of normal edits. If small fragments still climb toward 4,096, a bounded small-fragment merge in the native helper is the next fix (it needs the helper requalified on both platforms, like `0ee719d`). `0ee719d` stays uninstalled unless that growth shows it is needed.
6. **Re-time** the 5 queries from finding 10 with the `[search]` stage times. Under 1 s closes finding 10; if vector search alone stays near 0.5 s or more, an IVF index is a separate question.
7. **Record:** this section, finding 10, B1, the platform host plan's install line, and the October containment record (T6 in the host's tooling problems) get the result.

**Run on the P3, 2026-11-07 (`25d292d` installed, steps 1 to 4):**

- **Install:** `git archive` of `25d292d` with `lance-maintenance/` taken from `462fc9e` (`diff -r` identical), so `0ee719d`'s native change is not in it; `pnpm install --frozen-lockfile`, `pnpm build`, qualified helpers copied unchanged (`diff -rq` identical), `npm pack`, `npm install -g --prefix ~/.local`. The previous install is kept at `~/.local/state/gmax-handover/20261107T124631Z-0.26.110-compact/previous-install`.
- **Copy (step 1):** one process took the exclusive intent, then stopped the unit; a concurrent start cancels the stop job, and the daemon still needs the full 90 s `TimeoutStopSec` because its pool respawns a worker after SIGTERM (`[pool] respawn #1 after exit` on every stop today), so the lease was held after 40 s. Under it: `cp -a` of the store in 36.3 s and a read-transaction backup of `meta.lmdb` (catch-up compares files against `meta.lmdb`, not the store, so the snapshot must travel with the copy). Copy and source both at version 32488, 668,804 live rows, 615,853 deleted, 10,729 fragments, 33.5 GB. Hold 76.9 s. A restarted daemon opened `meta.lmdb` while blocked on the store lease, so the meta copy has to be a read-transaction backup, not a file copy.
- **Compaction (step 2):** `gmax compact --once` on the copy, CPU quota 800%, nice 10, load 6.2: 2 min 59 s wall (rewrite 102.6 s, indexes 30.6 s, row verification 45.3 s), 4.0 GB peak RSS. Result: version 33839, 668,804 rows, 0 deleted, 1,349 fragments of at most 1,024 rows and 16.5 MB, `content_idx` and `path_idx` 668,804 indexed and 0 unindexed. Live data 16.7 GB; the copy held 50.3 GB until old versions are pruned.
- **Verification (step 3):** the command's row check passed, and `table.stats()`/`indexStats()` read again separately agree. The 5 queries (finding 10) ran in-process against the copy before and after compaction: top 1 identical on all 5; queries 1 to 3 identical top 5; queries 4 and 5 swap 1 of 5 hits at ranks 2 to 5 (4: `services/push.ts:3476` leaves, `foyer/send-guest-notification.ts:79` enters; 5: `platform/iris/types.ts:852` leaves, `IrisDecisionDetailView.swift:190` enters). Both leaving chunks are still in the full-text results of the compacted table at a near score (rank 28 to 32 and 96 to 109 of 200, version 32488 against head), so this is the BM25 statistics now covering every row, not a lost match. The uncompacted copy also gave the same top 5 as the live daemon.
- **Swap (step 4):** a second hold (53.8 s, all but 0.1 s waiting for the stop), then `mv -T --exchange` of the store and of `meta.lmdb` with the snapshot, and the unit restarted before the lease was released. Backups, kept until the owner deletes them: `~/.gmax/lancedb.pre-compact-20261107` (the original, version 32488) and `~/.gmax/cache/meta.lmdb.pre-compact-20261107`.
- **Catch-up and step 5, first look:** the store version at the swap was still 32488, the copy's, so no write landed on the original after the copy; the restarted daemon re-embedded 1 file edited after the swap. Re-timing: finding 10. Bounded maintenance had not run in the first minutes: its loop waits until version cleanup has no eligible versions left (`startBoundedCleanupLoop`, `src/lib/daemon/daemon.ts`), and the compaction left about 1,350 versions, pruned 128 per pass. The first pass, at 13:04:46 UTC, ended "Version cleanup deferred: Cleanup cancelled; cleanup completion is uncertain" after the store went from 44 to 43 GB; the next pass retries the uncertain attempt. Open: why that pass was cancelled, each bounded operation completing on this store, and fragments and deleted rows recorded right after and for 2 days.
- **Why the cleanup passes were cancelled (step 5):** the daemon's 60 s deadline for runtime setup and admission (`AbortSignal.timeout(60_000)` in `performVersionCleanup`, `src/lib/daemon/daemon.ts`) was also passed to the prune helper, whose abort listener reports any abort as "Cleanup cancelled" (`runCleanupProcess`, `src/lib/store/lance-cleanup.ts`). The helper deletes at most 32 files a second (`delete_rate_limit=32`, `lance-maintenance/prune.py`) and removes old manifests only after the unreferenced data, index and deletion files, so after the compaction no pass reached a manifest. Every pass was cut 60 s after it started, the first in each process 120 s after the unit started (first tick at 60 s, then the deadline), 3 of them in one process with no stop between (13:04:46, 13:09:46 and 13:19:46 UTC; the 5 and 10 minute gaps are the failure backoff), and the receipt of the 13:51:12 UTC attempt ran 59.3 s to `uncertain`. Only the 13:45:48 UTC cancel was a unit stop. The killed passes still deleted files: at 13:50 UTC the table held 17 GB in 1,777 data files, with all 1,421 manifests, 1,293 transaction files and 3,134 deletion files still present. Fixed: the deadline bounds setup and admission only, and the prune runs under the helper's own 600 s bound (`MAX_PRUNE_MS`); a caller's timeout is reported as "timed out by its caller", not as a cancellation (tests in `tests/daemon-version-cleanup.test.ts`, `tests/lance-cleanup.test.ts`). A backlog pass keeps watched edits paused while the prune runs; reads stay open, and ordinary passes take seconds.

Work: 1 build agent for steps 1 to 4 and 6, step 5's first checks in the same run; the 2-day record after. The run restarts the unit (model reload, about 1 minute) and copies 33 GB.


## Open questions for the owner

- **Q1 (answered: c).** 400% with 3 files in flight and 1 worker kept for queries, ruled in the host's session-host plan as P12. The ruling also rejected the 3.3-5 h estimate; findings 7-9 are the per-file cost it asked for.
- **Q2:** cap workers at effective CPUs silently with a log line (step 4, as built), or refuse a config above the quota at startup?
- **Q3:** keep q4 dense (as today), or move the CPU path to the int8 file: dense 1.74x faster, but vectors shift (cosine 0.975 to q4), so stored q4 vectors and new int8 vectors would mix unless the embedding generation changes and the store re-embeds once.
- **Q4:** keep absolute chunk windows (as today: a few inserted lines re-embed the whole file), or anchor boundaries to lines and content so edits re-embed only nearby chunks; the change re-keys every stored chunk, so each file re-embeds fully once on its next edit.
- **Q5 (answered).** Scalar indexes the search and per-file paths need (the `path` B-tree) are built and kept current under containment, as a narrow exception; every other full-table maintenance stays disabled (`ensurePathIndex`, `src/lib/store/vector-db.ts`).
- **Bug B1 (was Q6): the daemon's automatic FTS repair refuses on large stores.** Native `index-refresh` refuses any table with more than 4,096 fragments ("Too many fragments for bounded metadata", `lance-maintenance/native/src/engine.rs:409-412`); this store has 11,481, so `content_idx` never catches up and every search brute-forces about 315k rows. The reason now reaches the daemon log (`9cbaa22`, `nativeRefusal` in `src/lib/store/bounded-maintenance.ts`). Done in source: (1) the whole-manifest check is gone from `open_metered`; index repair examines at most 4,096 uncovered fragments per attempt and selects at most 64, and only orphan, relocation and compaction planning, which read every fragment, keep the 4,096-fragment manifest bound (`SCAN_FRAGMENTS`, `scannable`, `lance-maintenance/native/src/engine.rs`; `src/repair.rs` `plan`). On this store those 3 steps stay refused, so the change builds index segments and rewrites no data. Linux x64 release build: native acceptance 23 of 23 (new case `test_index_refresh_runs_past_the_whole_manifest_scan_bound`), fault acceptance 4 of 4, 0 skipped, space-loss cases on a 192 MiB ext4 loop volume. The Linux artifact (source digest `775d661f`, binary `ef28ac33`) and its recipe are kept at `~/.local/state/gmax-handover/20261107-native-linux-x64-0ee719d/` on the P3, in the directory layout `assemble-bounded-runtime.cjs` reads. The recipe needs a pylance 12.0.0 fixture runtime from `git show 946c398^:lance-maintenance/{pyproject.toml,uv.lock}` (the current 14.0.2 lock makes every case skip as not qualified), the `release` profile (assembly refuses `dev`) and a small volume in `GMAX_BOUNDED_FIXTURE_BASE` (on macOS `hdiutil create -size 192m -type SPARSE -fs APFS`). Open: the darwin-arm64 release build and its acceptance from the same source, which the packaging gate (`scripts/assemble-bounded-runtime.cjs`, `scripts/prepare-bounded-runtime.cjs`) requires before the helper can ship or install; until then the P3 keeps the old helper and the FTS tail. Store at version 32363 before the change: `content_idx` 49 of 64 segments, 8,412 uncovered fragments, 315,580 rows; `path_idx` 36 fragments, 5,588 rows. Of the content backlog, 572 fragments (94,769 rows) are over 8 MiB or 32,768 rows: index repair skips them and only relocation, which this manifest refuses, can split them, so after catch-up those rows are still brute-forced. Expected loop after catch-up: an attempt with new uncovered fragments succeeds (next in 60 s), the following one refuses at the compaction scan (next in 10 min), so the index refreshes about every 11 minutes. An attempt whose first 4,096 uncovered fragments are all oversized selects nothing; this store's fragments average 62 rows. Question: run the darwin-arm64 build and acceptance on the Pro over SSH or on Depot (both need the owner's word); the other route installs nothing. Done: (2) a refusal that repeats with the same reason backs off from 10 minutes to 1 h, doubling to 24 h, and a success or a new reason resets it (`boundedCleanupDelayMs`, `src/lib/daemon/daemon.ts`; test in `tests/daemon-bounded-maintenance.test.ts`). The table changes every few minutes from watcher commits, so the backoff keys on the reason, not the version. After the compaction (Q7) the store has 1,349 fragments, under the 4,096-fragment bound of the installed helper, and both indexes cover every row; whether the installed helper's `index-refresh` then keeps up without `0ee719d` is step 5 of the Compaction section.
- **Q7 (answered).** 1 supervised compaction of the P3 store runs, with a full copy of the store taken first, ruled 2026-11-07 in the host's session; the automatic full-table rewrites stay disabled. Plan: [Compaction](#compaction-q7).
