# gmax — Architecture & Operations Guide

Read this before making changes.

---

## Process Architecture

gmax runs as cooperating processes. Only `gmax-mcp` may have multiple instances.

```
gmax-daemon (singleton via lockfile)
  |-- gmax-worker (1-7 child processes, lazy-spawned, reaped after 60s idle)
  |-- [gmax-embed] (MLX GPU server on port 8100) ** SEE KNOWN BUG #1 **
  +-- Unix socket server (~/.gmax/daemon.sock)

gmax-mcp (N instances, one per Claude Code session)
```

### Who starts what

| Process | Started by | Lifecycle | Code |
|---------|-----------|-----------|------|
| gmax-daemon | `gmax watch --daemon -b` (SessionStart hook or manual) | Singleton. 30min idle timeout. | `src/commands/watch.ts` |
| gmax-worker | Daemon's WorkerPool, lazy on first task | Reaped after 60s idle, min 1 kept alive | `src/lib/workers/pool.ts` |
| gmax-embed | **`gmax serve` ONLY** | 30min idle timeout | `src/commands/serve.ts:45` |
| gmax-mcp | Claude Code (one per session) | Session lifetime | `src/commands/mcp.ts` |
| llama-server (LLM) | Daemon's LlmServer, on first `llm-start` IPC or `reviewCommit` | 10min idle timeout | `src/lib/llm/server.ts` |

### Singleton enforcement (daemon)

1. Read `~/.gmax/daemon.pid` — if PID alive, socket-ping it
2. If responsive, exit (another daemon is healthy)
3. If alive but unresponsive, SIGTERM/SIGKILL it
4. Acquire `~/.gmax/daemon.lock` (proper-lockfile, stale after 120s)
5. If ELOCKED, exit

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
  logs/
    daemon.log         Daemon + worker stdout/stderr (rotated at 5MB)
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
 3. Kill leftover per-project watchers (legacy migration)
 4. Write PID file
 5. Clean stale socket
 6. Open LanceDB + MetaCache (shared resources)
 7. Construct LlmServer (lazy, not started)
 8. Register daemon in watcher store
 9. Watch all "indexed" projects (subscribe + catchup)
 9b. Index all "pending" projects (background, async)
10. Start heartbeat (60s interval)
11. Start idle checker (30min timeout)
12. Start IPC socket server on daemon.sock

NOT IN STARTUP: MLX embed server. See Known Bug #1.
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
- Idle workers reaped after 60s back down to 1
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

MLX client (`mlx-client.ts`) caches availability for 30s. No mechanism to start the server or notify the daemon. `resetMlxCache()` exists but is never called by the daemon.

### Shutdown (`daemon.ts:shutdown()`)

```
 1. Set shuttingDown flag
 2. Clear heartbeat + idle intervals
 3. Close all batch processors (awaited)
 4. Stop LLM server
 5. Unsubscribe all file watchers
 6. Close socket server
 7. Unlink socket + PID files
 8. Release lock
 9. Unregister all watchers
10. Close MetaCache + VectorDB
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

## Known Issues

### Critical

1. **Daemon doesn't start MLX embed server.** `startMlxServer()` only exists in `src/commands/serve.ts:45`. The daemon has zero code to start or manage it. Workers fall back to CPU ONNX silently (~5x slower). Every project is configured for `embedMode: "gpu"` but GPU is never used in daemon mode. This has been the case since the daemon was introduced in v0.13.0.

2. **Error-status projects are never retried.** If `indexPendingProject` fails, the project stays in `"error"` status forever. The daemon only watches `"indexed"` and indexes `"pending"` — `"error"` is ignored. Requires manual `gmax add` or editing projects.json.

### Moderate

3. **Batch processor still sends unchanged files to workers.** The catchup scan has a fast in-process hash check for mtime-only changes, but the batch processor (live watcher path) still does the slow worker round-trip. Files with identical content but different mtime take ~220ms each through the worker when they could be resolved in <1ms.

4. **LLM server crash not handled.** If llama-server dies, PID file still points to dead process. `ensure()` checks `isAlive()` via kill(pid, 0) but doesn't restart on failure. No automatic recovery.

5. **No dead-letter tracking.** Files that repeatedly fail processing are dropped after 5 retries with a console.warn but not tracked anywhere persistent.

### Minor

6. **MLX availability cached 30s.** Workers cache `mlxAvailable=false` for 30s. If the embed server starts, workers won't notice for up to 30s. `resetMlxCache()` exists but daemon never calls it.

7. **Daemon.ts has duplicate step numbering.** Lines 121 and 124 are both labeled `// 7.` — steps 8-12 are misnumbered.

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
- `src/commands/serve.ts` — **The only place that starts the MLX embed server** (`startMlxServer()` line 45)

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
