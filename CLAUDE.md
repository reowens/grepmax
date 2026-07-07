# gmax — Architecture & Operations Guide

Read this before making changes.

---

## Process Architecture

gmax runs as cooperating processes. Only `gmax-mcp` may have multiple instances.

```
gmax-daemon (singleton via lockfile)
  |-- gmax-worker (1-7 child processes, lazy-spawned, reaped after 60s idle, min 1 kept alive)
  |-- [gmax-embed] (MLX GPU server on port 8100; daemon heartbeat respawns it if zombie or dead)
  +-- Unix socket server (~/.gmax/daemon.sock)

gmax-mcp (N instances, one per Claude Code session)
```

### Who starts what

| Process | Started by | Lifecycle | Code |
|---------|-----------|-----------|------|
| gmax-daemon | `gmax watch --daemon -b` (SessionStart hook or manual) | Singleton. 30min idle timeout. | `src/commands/watch.ts` |
| gmax-worker | Daemon's WorkerPool, lazy on first task | Reaped after 60s idle, min 1 kept alive | `src/lib/workers/pool.ts` |
| gmax-embed | Daemon's `ensureMlxServer()` (startup + 5min heartbeat health check) or `gmax serve` | 30min idle timeout. Spawned with `HF_HOME=~/.gmax/hf` (pinned local model cache) | `src/lib/daemon/mlx-server-manager.ts` |
| gmax-mcp | Claude Code (one per session) | Session lifetime | `src/commands/mcp.ts` |
| llama-server (LLM) | Daemon's LlmServer, on first `llm-start` IPC or `reviewCommit` | 10min idle timeout | `src/lib/llm/server.ts` |

### Singleton enforcement (daemon)

1. `killStaleProcesses()` — `pgrep -x gmax-daemon` finds every daemon process (not just whatever `daemon.pid` last named). For each:
   - Two independent liveness probes:
     - `isDaemonHeartbeatFresh()` — `daemon.lock` mtime within 150 s **and** the PID file points at a live process (the PID check defends against SIGKILL/OOM/panic leaving a fresh-mtime orphan)
     - Socket ping with 10 s timeout (covers a busy daemon whose event loop is blocked)
   - If either probe says alive → exit 0 (defer to the running peer)
   - Otherwise → kill it. Also kill any orphaned `gmax-worker` processes.
2. Acquire `~/.gmax/daemon.lock` (proper-lockfile, kernel-enforced, stale after 120 s). On `ELOCKED` → exit 0.
3. Unlink any stale socket file, then start listening on the socket **before** writing the PID file — so anyone who reads the PID can immediately ping and get a response.

---

## Data Architecture

All persistent state lives under `~/.gmax/`:

```
~/.gmax/
  config.json          Global config (embedMode, modelTier, vectorDim)
  projects.json        Project registry (root, status, chunkCount)
  daemon.pid           Current daemon PID
  daemon.lock          Singleton lock (proper-lockfile)
  daemon.sock          IPC Unix socket
  lancedb/
    chunks.lance/      Vector store (shared, all projects, scoped by path prefix)
  cache/
    meta.lmdb          File metadata cache: absolute path -> {hash, mtimeMs, size}
  models/              ONNX model files (downloaded on first use)
  hf/                  Pinned HF cache for the MLX embed model (never inherits
                       shell HF_HOME, which may point at an unmounted volume)
  logs/
    daemon.log         Daemon + worker stdout/stderr (rotated at 5MB, timestamped)
    mlx-embed-server.log
    llm-server.log
  llm-server.pid
```

### MetaCache (LMDB)

Maps absolute file paths to `{hash: string, mtimeMs: number, size: number}`. Used by:
- **Catchup scan**: skip files where mtime+size match cached entry; fast hash check if only mtime differs
- **Batch processor**: skip files where mtime+size match; update entry when hash matches after worker round-trip
- **Coherence check**: compare LMDB count vs LanceDB vector count (threshold: 80%)

### VectorDB (LanceDB)

One table (`chunks`), all projects share it, scoped by path prefix (`/absolute/path/to/project/`). Maintenance loop runs compaction periodically. Can spike memory during compaction after large writes.

### Project Registry (projects.json)

Status values: `"pending"` | `"indexed"` | `"error"`

- `indexed` — daemon watches this project, runs catchup on startup
- `pending` — daemon indexes in background on startup via `indexPendingProject()`
- `error` — **daemon ignores it**. Must be manually re-added or status edited.

---

## Daemon Lifecycle

### Startup (`daemon.ts:start()`)

```
 0. Set process title "gmax-daemon"
 1. Singleton check: PID file -> socket ping -> kill stale
 2. Acquire exclusive lock (daemon.lock, stale=120s)
 3. Kill any per-project `gmax watch` processes so the daemon can take over their projects
 4. Write PID file
 5. Clean stale socket
 6. Open LanceDB + MetaCache (shared resources)
 7. Construct LlmServer (lazy, not started)
 8. Register daemon in watcher store
 9. Watch all "indexed" projects (subscribe + catchup)
 9b. Index all "pending" projects (background, async)
10. Start heartbeat (60s interval; every 5 ticks probes MLX `/health` and respawns the embed server if it's zombie — port held but unresponsive — or dead — nothing on the port, e.g. crashed at model load)
11. Start idle checker (30min timeout)
12. Start IPC socket server on daemon.sock

6b. Start MLX embed server (GPU mode on Apple Silicon). Kills stale orphans on port first.
```

### Watch flow

```
watchProject(root)
  +-- Create ProjectBatchProcessor
  +-- Subscribe @parcel/watcher (native FS events)
  +-- Register watcher
  +-- catchupScan(root)
        +-- Walk all indexable files in project
        +-- For each file: stat -> compare mtime+size vs MetaCache
        |     Same mtime+size -> skip (cached)
        |     Same size, different mtime, have hash -> fast hash check in-process
        |       Hash matches -> update mtime in cache, skip worker
        |       Hash differs -> queue to batch processor
        |     No cache entry -> queue to batch processor
        +-- Purge deleted files from MetaCache
```

### Batch processor (`ProjectBatchProcessor`)

```
File event (from watcher or catchup) -> pending map -> debounce 2s -> processBatch()
  For each file (batches of 50):
    stat -> isFileCached? -> skip if mtime+size match
    Send to WorkerPool.processFile()
      Worker: read -> hash -> chunk (tree-sitter) -> embed (MLX or ONNX) -> return vectors
    If hash unchanged -> update meta only, no vector write ("0 reindexed")
    If hash changed -> delete old vectors, insert new, update meta
    If shouldDelete -> delete vectors, update meta
  Flush: insert vectors -> delete old paths -> update MetaCache
  Report reindex count
  If pending files remain, reschedule
```

### Worker pool

- Starts with 1 worker, scales up to `floor(cores * 0.5)` on demand in `dispatch()`
- Workers are child processes (not threads) — isolates ONNX Runtime segfaults
- Idle workers reaped after 60s back down to `MIN_KEEP_WORKERS = 1` (favors low resident memory over search warmth — an idle worker holds ~300MB–1GB; the rare search pays a one-off cold start). Reap sends SIGTERM, then escalates to SIGKILL after 5s if the worker is still alive (defends against a worker stuck inside a native ONNX matmul tight loop that won't service signals)
- Task timeout: 120s (env: `GMAX_WORKER_TASK_TIMEOUT_MS`) -> SIGKILL worker -> respawn if tasks pending
- Max consecutive respawns: 10, then pool stops spawning
- Respawn counter resets on each successful task completion

### Embedding pipeline (per worker)

```
processFile(path)
  Read file + SHA-256 hash
  isIndexableFile? (extension + size + binary check)
  Chunk via tree-sitter (parallel with skeleton generation)
  For each batch of 16 chunks:
    POST http://127.0.0.1:8100/embed (MLX GPU)
    If MLX unavailable -> ONNX CPU in-process (~5x slower)
    Run ColBERT on dense embeddings
  Return vectors + hash + meta
```

MLX client (`mlx-client.ts`) caches availability for 30s. The cache is module-level state inside each worker process, so the daemon cannot invalidate it directly — recovery relies on the TTL expiring and on `mlxEmbed` flipping `mlxAvailable = false` on POST failure to force a re-probe.

### Shutdown (`daemon.ts:shutdown()`)

```
 1. Set shuttingDown flag
 2. Drop external liveness markers FIRST: unlink socket + PID file,
    release lock. Done before the long-running cleanup below so that an
    interrupted shutdown (uncaught exception, second SIGTERM, OOM kill)
    still leaves clean state — otherwise a stale daemon.lock with a
    fresh mtime keeps the next start silently no-op'ing.
 3. Clear heartbeat + idle intervals
 4. Abort in-flight index/add operations (AbortController)
 5. Await pending project-lock operations
 6. Close all batch processors
 7. Stop LLM server
 8. Stop MLX embed server (also kills whoever owns port 8100)
 9. Destroy worker pool
10. Clear poll intervals + FSEvents recovery timers
11. Unsubscribe all file watchers
12. Close socket server (file already unlinked in step 2)
13. Unregister all watchers, unregister daemon entry
14. Close MetaCache + VectorDB
```

---

## IPC Protocol

Client connects to `~/.gmax/daemon.sock`, sends one JSON line, receives response(s).

**Simple commands** (request -> response -> close):
`ping`, `watch`, `unwatch`, `status`, `llm-start`, `llm-stop`, `llm-status`

**Streaming commands** (request -> progress lines -> done -> close):
`index`, `add`, `remove`, `summarize`, `review`

```
-> {"cmd":"index","root":"/path"}\n
<- {"type":"progress","processed":10,"total":500}\n
<- {"type":"progress","processed":11,"total":500}\n
<- {"type":"done","ok":true,"indexed":450}\n
```

---

## Debugging

### Enable debug logging

```bash
GMAX_DEBUG=1 gmax watch --daemon -b
```

### Log tags (in `~/.gmax/logs/daemon.log`)

| Tag | Source | What it logs |
|-----|--------|-------------|
| `[pool]` | pool.ts | Worker spawn/reap, task dispatch/complete/timeout/error, queue depth |
| `[worker]` | process-child.ts | Task recv/done/fail with timing and vector counts |
| `[orch]` | orchestrator.ts | processFile start/done, chunk count, embed batch timing, MLX vs ONNX |
| `[mlx]` | mlx-client.ts | HTTP timing, health checks, availability cache state |
| `[index]` | syncer.ts | Walk progress, file outcomes, flush stats, coherence check |
| `[daemon]` | daemon.ts + ipc-handler.ts | Lock, socket, IPC commands, indexPendingProject timing |
| `[catchup]` | daemon.ts | Per-file miss reasons (null cache, mtime mismatch), summary stats |

### Other debug env vars

- `GMAX_DEBUG_MODELS=1` — Model loading details in workers
- `GMAX_DEBUG_INDEX=1` — Per-file progress during initial sync

### Common diagnostics

```bash
ps aux | grep "gmax-"                              # Process state
gmax status                                        # Daemon responsive?
tail -f ~/.gmax/logs/daemon.log                    # Live log
cat ~/.gmax/projects.json | python3 -m json.tool   # Project registry
cat ~/.gmax/config.json | python3 -m json.tool     # Global config
curl -s http://127.0.0.1:8100/health               # MLX embed server up?
```

---

---

## File Index

### Daemon & Process Management
- `src/commands/watch.ts` — CLI entry, daemon background spawn, per-project watcher mode
- `src/lib/daemon/daemon.ts` — Daemon class: startup, shutdown, watchProject, catchupScan, indexPendingProject
- `src/lib/daemon/ipc-handler.ts` — IPC command routing
- `src/lib/utils/daemon-client.ts` — Client-side IPC: sendDaemonCommand, ensureDaemonRunning
- `src/lib/utils/daemon-launcher.ts` — spawnDaemon() for background mode

### Indexing Pipeline
- `src/lib/index/syncer.ts` — `initialSync()`: full project index (walk -> chunk -> embed -> flush)
- `src/lib/index/batch-processor.ts` — `ProjectBatchProcessor`: incremental reindex from watcher events
- `src/lib/index/walker.ts` — File tree walker with gitignore support
- `src/lib/index/chunker.ts` — Tree-sitter chunking
- `src/lib/utils/cache-check.ts` — `isFileCached()`: mtime+size comparison

### Worker Pool & Embedding
- `src/lib/workers/pool.ts` — `WorkerPool`: lazy-spawn child process pool with idle reaping
- `src/lib/workers/process-child.ts` — Child process message handler (worker entry point)
- `src/lib/workers/orchestrator.ts` — `WorkerOrchestrator`: chunk -> embed -> return vectors
- `src/lib/workers/embeddings/mlx-client.ts` — HTTP client for MLX embed server (port 8100)
- `src/lib/workers/embeddings/granite.ts` — ONNX CPU embedding (fallback)
- `src/lib/workers/embeddings/colbert.ts` — ColBERT late interaction model

### Embed Server
- `mlx-embed-server/server.py` — FastAPI, MLX GPU embeddings, idle timeout, Metal cache management
- `src/commands/serve.ts` — `startMlxServer()`: spawns MLX for the `gmax serve` standalone-HTTP path. The daemon spawns its own via `daemon.ts:ensureMlxServer()` (called at startup + by the 5-min heartbeat health check).

### Storage
- `src/lib/store/vector-db.ts` — LanceDB wrapper (insert, delete, search, maintenance loop)
- `src/lib/store/meta-cache.ts` — LMDB wrapper (path -> {hash, mtimeMs, size})

### Config
- `src/config.ts` — Constants: PATHS, CONFIG, INDEXABLE_EXTENSIONS, worker/memory limits
- `src/lib/index/index-config.ts` — Per-project + global config read/write
- `src/lib/utils/project-registry.ts` — projects.json CRUD

### Logging
- `src/lib/utils/logger.ts` — `log()`, `debug()`, `timer()`, `debugTimer()`, `debugEvery()`; gated on `GMAX_DEBUG=1`
- `src/lib/utils/log-rotate.ts` — Log rotation (5MB max, single .prev backup)
