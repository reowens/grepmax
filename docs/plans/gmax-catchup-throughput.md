---
type: plan
status: awaiting
created: 2026-11-05T17:30:00Z
updated: 2026-11-05
surfaces:
  - daemon
  - watcher
  - workers
modules:
  - src/lib/index/batch-processor.ts
  - src/lib/workers/pool.ts
  - src/lib/daemon/process-manager.ts
  - src/lib/daemon/daemon.ts
  - src/index.ts
domain: Catch-up throughput under a CPU-quota service, stale daemon markers and false startup warnings
audience: internal
parent_plan: docs/plans/gmax-delivery.md
related_plans:
  - docs/plans/gmax-delivery.md
  - docs/plans/gmax-p3-container.md
current_state: "Planned from source and the P3 journal of 2026-11-05; no code, release, install, restart or reindex."
next_step: "Owner go on steps 1-6 as one batch; then one release and one same-unit handover."
summary: "Catch-up embeds 1 file per batch because the 2 s background window cuts every slow batch and the pool admits 1 background file at 2 CPUs."
---

# Catch-up throughput and daemon startup on the P3

Planned 2026-11-05 from source at `ff4941d` and the P3 service journal. Installed: 0.26.110 under the user systemd unit with `CPUQuota=200%`, `CPUWeight=10`, `Nice=10`, `WorkingDirectory=%h`; config Small/384d/CPU, `workerThreads` 4. `gmax status` reports 2 effective CPUs, 4 configured workers (automatic default 2) and a background indexing allowance of 1 file. The P3's largest project (`<repo>`, about 2,140 catch-up files pending at 16:56) is the subject.

## Findings

### 1. Catch-up runs 1 file per batch

4 limits stack; the first 2 do most of the damage:

- **The 2 s background window cuts every slow batch.** `src/lib/index/batch-processor.ts:808-813` stops dispatching background work once 1 file has settled and 2 s (`BACKGROUND_DISPATCH_WINDOW_MS`, :54) have passed, whether or not live work is waiting. A changed file takes 3-170 s to embed, so each batch embeds exactly 1 file.
- **Catch-up batches hold at most 4 files** (`MAX_CATCHUP_BATCH_SIZE`, :53, applied at :491-495) against 50 for live and cleanup (:52).
- **Catch-up runs at concurrency 1** (:785-788, `kind === "live" ? this.concurrency : 1`).
- **The pool admits 1 background file across all projects** at 2 CPUs: `fileCpuLimit = effectiveCpus - 1` (`src/lib/workers/pool.ts:351`), `backgroundIndexingLimit = min(fileCpuLimit, maxWorkers - 1)` (:382-384), enforced in `canDispatch` (:436-443). Half the quota is held back for queries.

Each ONNX session is single-threaded (`ONNX_THREADS = 1`, `src/lib/workers/embeddings/granite.ts:10`, `colbert.ts:7`), so 1 file in flight uses at most 1 of the 2 CPUs the unit allows.

**Origin.** Limits 1-3 arrived together in `bad7365` (2026-10-07, 0.26.63, "prioritize live edits over watcher catchup and cleanup"); before it, catch-up shared the 50-file batch at the live concurrency. README.md:519 documents the behaviour as intended. The aim was live-edit latency, not thermal containment or lock cancellation. Limit 4 arrived in `b7066b8` (2026-10-28, 0.26.105, "honor CPU quotas and share background worker admission"). The `601cdda` root on `main` is grafted; the full history is reachable with `git log --all`. Retained rollback installs 0.26.103 to 0.26.109 all carry limits 1-3.

**Journal, 2026-11-05 boot (55 batches, 16:33 to 16:56):** 46 batches reported "4 files, 1 reindexed", 4 reported 2, 2 reported 0. Mean batch time 23.4 s, about 2 s between batches. The last 12 batches cleared 13 files in about 212 s, 16 s per file.

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

## Plan

One batch; each step lists its tests. Live-edit priority from `bad7365` stays.

1. **Measure before tuning, from existing logs only.** Add per-file elapsed and reused-chunk counts to the `Processing`/`Batch complete` lines, and query queue-wait vs encode time to the search handler's debug line. No new diagnostics surface.
2. **Catch-up batching** in `batch-processor.ts`:
   - Remove the elapsed-time half of the break (:811); background work yields only when live work is ready (`hasReadyLiveWork`), on pause, or on abort.
   - Raise catch-up to `MAX_BATCH_SIZE` and commit to the store every N settled files or every 30 s inside the batch, so a long batch still publishes progress and a pause loses at most one file of work.
   - Run catch-up at the pool's background allowance instead of 1 (:786).
   - Log settled, reindexed and requeued counts separately.
   - Tests: extend `tests/project-batch-processor.test.ts` (fake clock, mocked worker): a slow first file no longer requeues the rest; a live save still preempts between files; pause mid-batch requeues only unsettled files.
3. **Background admission at low CPU counts** in `pool.ts`: when no query or live task is queued, admit background files up to `effectiveCpus` (2 here); return to `effectiveCpus - 1` as soon as a query or live task arrives, and keep a warm worker for queries while background work runs so a query never cold-spawns. Tests: admission with 2 and 4 effective CPUs, query arriving mid-catch-up.
4. **Workers vs quota:** cap the effective `maxWorkers` at effective CPUs and log once when config asks for more; `gmax status` shows configured and effective. Tests: config 4 with 2 CPUs gives 2 and a warning.
5. **Stale marker:** write `daemon.pid` by temp file and rename. In `assertStartupAvailable`, an empty or unparsable regular-file marker gets a connect probe of the daemon socket: an answer refuses as today; `ENOENT` or `ECONNREFUSED` renames the marker to `daemon.pid.unverified-<timestamp>`, logs it, and continues. No unlink and no signal, consistent with "Neither a PID nor a title permits termination" (:77). Symlinks, non-files and unreadable markers still refuse. Tests: empty marker with no socket starts; empty marker with a live socket refuses; symlink refuses.
6. **Legacy warning:** skip when `realpath(<cwd>/.gmax)` equals the configured home store; keep it for a real project-local `.gmax`. Tests: cwd at home is silent; a project with its own `.gmax/lancedb` warns.

Then one release and one same-unit handover, per the delivery plan's procedure.

## Expected catch-up time

At 16 s per file (this boot's last 12 batches) and about 2,140 files:

| Setting | Files in flight | Estimate |
|---|---:|---:|
| Today | 1, plus about 2 s between batches | about 10 h |
| Steps 2-3 at 200% | 2 | about 5 h |
| Steps 2-3 at 400% | 3 to 4 | about 2.5 to 3.5 h |

Batching alone saves only the gap between batches; the gain comes from 2 files in flight. If step 1 shows chunk reuse is not working on these edits, fixing it shortens every row.

## Open questions for the owner

- **Q1:** keep 200% and accept about 5 h for a backlog this size, or allow 400% while catch-up runs (about 2.5 to 3.5 h, fans louder)?
- **Q2:** cap workers at effective CPUs silently with a log line (step 4), or refuse a config above the quota at startup?
