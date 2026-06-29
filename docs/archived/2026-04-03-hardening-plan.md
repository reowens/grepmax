---
type: doc
status: archived
created: 2026-04-03
updated: 2026-04-03
summary: Historical hardening plan from 2026-04-03. All items shipped in v0.14.x.
audience: internal
---

# gmax Hardening Plan

**Date:** 2026-04-03
**Status:** In progress
**Context:** Persistent index corruption, silent failures, and broken observability made gmax unreliable for the primary consumer (platform). This plan addresses every known failure mode.

## Background

The platform project (~7400 files) suffered from:
- Batch processor timeouts (pre-#75) that wrote MetaCache entries without flushing vectors to LanceDB, leaving the index in a phantom state where `gmax index` thought everything was cached
- MLX embed server crashing silently on startup due to macOS TCC blocking detached process access to external volumes, with no timestamps in logs making it impossible to distinguish old crashes from new ones
- Catchup scan not detecting files deleted while daemon was offline
- `gmax index` walking thousands of files, embedding zero, and exiting with no error

### Already Fixed (v0.14.2, PR #76)
- Coherence check now compares distinct file counts (not just existence) — clears cache when LanceDB has <80% of cached files
- Catchup scan now detects and purges files deleted while daemon was offline
- Removed stale `search_all` from README MCP tools table
- Hook and skill docs updated to reference `gmax index` for self-healing repair

---

## Tier 1: CRITICAL — Silent Data Loss / Broken Index

### 1. `gmax index` exits silently when embed server is down
- **File:** `src/lib/index/syncer.ts`, `src/lib/workers/embeddings/mlx-client.ts`
- **Problem:** Walks 7000 files, embeds 0, reports success. User sees "0 new, 7390 cached, 0 failed" and thinks everything is fine.
- **Fix:** Pre-flight embed check before walking. If embed server is unreachable, abort with clear error: "Embedding server not running. Start it with `gmax watch --daemon -b` or check `gmax doctor`."
- **Acceptance:** `gmax index` errors out immediately when embed server is down, never walks files.

### 2. chunkCount in projects.json never updated by watcher
- **File:** `src/lib/daemon/daemon.ts:197-202`, `src/commands/status.ts:114,147`
- **Problem:** `onReindex` callback updates `lastIndexed` but not `chunkCount`. `gmax status` shows stale/zero counts forever.
- **Fix:** After each batch, query LanceDB for actual chunk count for the project and update the registry. `gmax status` should also query LanceDB directly as the source of truth.
- **Acceptance:** `gmax status` shows correct chunk count immediately after watcher reindexes files.

### 3. Worker pool task timeout has no context
- **File:** `src/lib/workers/pool.ts:231-234`
- **Problem:** Logs "timed out" with no file path, method, or duration. Impossible to debug.
- **Fix:** Include the file path, task type, and elapsed time in the timeout log message.
- **Acceptance:** Timeout log line includes file path and duration.

### 4. MLX client silently sets `mlxAvailable = false`
- **File:** `src/lib/workers/embeddings/mlx-client.ts:110-111`
- **Problem:** When embed server fails, `mlxAvailable` flips to false with no log. All subsequent embeds silently skip.
- **Fix:** Log the failure reason when `mlxAvailable` transitions from true to false. Log a warning on every embed attempt when server is known-down.
- **Acceptance:** First failure logs the error. Subsequent attempts log a warning (rate-limited, not per-file).

### 5. Batch processor swallows worker pool errors
- **File:** `src/lib/index/batch-processor.ts:184`
- **Problem:** Worker pool errors logged to console but batch continues with unhealthy pool, potentially producing garbage.
- **Fix:** Check `pool.isHealthy()` after each error. If unhealthy, abort the batch immediately and surface the error.
- **Acceptance:** Batch aborts cleanly when worker pool is unhealthy, with clear log message.

### 6. Search on unindexed project returns empty silently
- **File:** `src/commands/search.ts:624`, `src/commands/mcp.ts:492-496`
- **Problem:** No error, no warning, just empty results. User thinks their query was bad.
- **Fix:** Check project status before searching. If pending/unindexed, return error: "Project not indexed. Run `gmax add` first." If partially indexed, warn with coverage percentage.
- **Acceptance:** Search on unindexed project returns an error, not empty results.

---

## Tier 2: HIGH — Stale State / Consistency

### 7. Index config model mismatch not logged clearly
- **File:** `src/lib/index/syncer.ts:265-270`
- **Problem:** If embed model changes between runs, old embeddings from a different model coexist with new ones. The reset happens silently.
- **Fix:** Log a prominent warning when model mismatch is detected: "Embedding model changed from X to Y. Clearing index and re-embedding all files."
- **Acceptance:** Model change triggers a visible warning in logs and CLI output.

### 8. Daemon adopts stale LLM server process
- **File:** `src/lib/llm/server.ts:58-62`
- **Problem:** Checks PID existence but not model/config. Can serve answers from wrong model if llama-server restarted externally.
- **Fix:** Health check should verify the model name matches config, not just that the process is alive.
- **Acceptance:** Daemon detects model mismatch and restarts LLM server.

### 9. Project registry `registerProject` calls not serialized
- **File:** `src/lib/utils/project-registry.ts`
- **Problem:** Concurrent adds can interleave reads and writes to `projects.json`, corrupting the registry.
- **Fix:** Add file-level locking or atomic write (write to temp file, rename) for project registry operations.
- **Acceptance:** Concurrent `gmax add` from multiple terminals doesn't corrupt projects.json.

### 10. Coherence check should log what it finds
- **File:** `src/lib/index/syncer.ts:242-260`
- **Problem:** When the 80% threshold passes or fails, no context logged. Hard to debug after the fact.
- **Fix:** Always log the comparison: "Coherence: 7396 cached files, 7200 in LanceDB (97%) — OK" or "... 2000 in LanceDB (27%) — clearing cache".
- **Acceptance:** Every `gmax index` run logs the coherence comparison.

### 11. Remove dead `search_all` handler
- **File:** `src/commands/mcp.ts:2133`
- **Problem:** Unreachable handler for a tool that was removed from the tool definitions.
- **Fix:** Delete the case branch.
- **Acceptance:** Handler removed, no regression in MCP tool dispatch.

---

## Tier 3: HIGH — Logging & Observability

### 12. MLX embed server logs have no timestamps
- **File:** `mlx-embed-server/server.py`
- **Problem:** Can't tell old crashes from new ones. The log is a wall of tracebacks with no time context.
- **Fix:** Configure Python logging with ISO timestamp format on every line. Add startup/shutdown timestamps.
- **Acceptance:** Every log line has a timestamp. Startup prints "Started at <time>", shutdown prints "Stopped at <time>".

### 13. Embed server startup hook doesn't verify health
- **File:** `plugins/grepmax/hooks/start.js:112-114`
- **Problem:** Spawns detached and returns immediately. No verification that the server actually started.
- **Fix:** After spawn, poll `/health` up to 5 times (1s interval). Log success or failure. Don't block the hook — log async.
- **Acceptance:** Hook log shows "MLX embed server started (port 8100)" or "MLX embed server failed to start: <reason>".

### 14. Embed server crash counter
- **File:** `plugins/grepmax/hooks/start.js`
- **Problem:** If server crashes on startup, the next session tries again with no memory of past failures. Could loop forever.
- **Fix:** Write crash count to `~/.gmax/mlx-embed-crashes.json` with timestamp. After 3 consecutive crashes, log error and don't attempt restart. Reset counter on successful health check.
- **Acceptance:** After 3 crashes, hook logs "MLX embed server failed 3 times, not retrying. Run `gmax doctor` to diagnose."

### 15. Daemon startup logs no paths on failure
- **File:** `src/lib/daemon/daemon.ts:80-89`
- **Problem:** "Failed to open shared resources" with no indication which path or why.
- **Fix:** Log the specific path that failed (LanceDB dir, LMDB path) and the error message.
- **Acceptance:** Failure log includes the path and OS error.

### 16. MLX health check retry is silent
- **File:** `src/lib/workers/embeddings/mlx-client.ts:88-91`
- **Problem:** Cold start retries happen with zero logging.
- **Fix:** Log each retry attempt: "MLX embed server not ready, retrying (attempt 2/5)..."
- **Acceptance:** Retry attempts are visible in logs.

### 17. Catchup should log stale purge count separately
- **File:** `src/lib/daemon/daemon.ts:293-305` (already partially fixed in v0.14.2)
- **Problem:** Changed and deleted counts should be clearly separated in log output.
- **Fix:** Already implemented in v0.14.2. Verify format is "Catchup: X changed, Y deleted file(s) while offline".
- **Acceptance:** Log clearly distinguishes changed vs deleted files.

---

## Tier 4: MEDIUM — Validation & Preconditions

### 18. `gmax doctor` should test actual embedding
- **File:** `src/commands/doctor.ts:92-105`
- **Problem:** Only pings `/health`. Doesn't verify embedding actually works.
- **Fix:** Send a test text to `/embed`, verify response has correct dimensions (384 for small model).
- **Acceptance:** `gmax doctor` shows "Embedding: ok (384d, 12ms)" or "Embedding: FAIL — server returned wrong dimensions".

### 19. `gmax doctor` should report MetaCache vs LanceDB divergence
- **File:** `src/commands/doctor.ts`
- **Problem:** No way to detect cache/vector mismatch without running `gmax index`.
- **Fix:** For each project, compare MetaCache key count vs LanceDB distinct file count. Report divergence.
- **Acceptance:** `gmax doctor` shows "platform: 7396 cached, 7200 indexed (97%)" or "WARN platform: 7396 cached, 2000 indexed (27%) — run gmax index to repair".

### 20. Add `gmax verify <project>` command
- **File:** New command: `src/commands/verify.ts`
- **Problem:** No read-only way to check index integrity.
- **Fix:** Compare MetaCache entries to LanceDB rows. Report: files in cache but not in LanceDB, files in LanceDB but not on disk, dimension mismatches. Never modify anything.
- **Acceptance:** `gmax verify` reports integrity issues without changing the index.

### 21. `gmax index` should pre-flight check embed server
- **File:** `src/lib/index/syncer.ts`
- **Problem:** Walks 7000 files before discovering embed server is down.
- **Fix:** Send a test embedding before starting the walk. Fail fast with actionable message.
- **Acceptance:** `gmax index` fails within 2 seconds if embed server is unreachable.

### 22. `gmax add` should verify embed server before starting
- **File:** `src/commands/add.ts`
- **Problem:** Starts indexing and silently produces 0 chunks when server is down.
- **Fix:** Same pre-flight check as #21.
- **Acceptance:** `gmax add` fails fast with clear error when embed server is down.

### 23. Doctor HTTP errors swallowed
- **File:** `src/commands/doctor.ts:92-105`
- **Problem:** `.catch(() => false)` on health checks hides the actual error.
- **Fix:** Catch the error, log/display it: "MLX Embed: FAIL (connection refused on port 8100)".
- **Acceptance:** `gmax doctor` shows specific failure reason, not just "not running".

---

## Tier 5: MEDIUM — Resource Leaks & Process Management

### 24. MCP background `gmax add` spawned with no timeout
- **File:** `src/commands/mcp.ts:441-447`
- **Problem:** If indexing hangs, orphaned process lives forever.
- **Fix:** Set a timeout (e.g., 10 minutes) on the spawned process. Kill if exceeded.
- **Acceptance:** Background add is killed after timeout with log message.

### 25. Detached server spawns accumulate orphaned processes
- **File:** `src/commands/serve.ts:64-70`, `src/commands/watch.ts:58-64`
- **Problem:** Each daemon restart spawns new MLX/embed servers without killing old ones.
- **Fix:** Before spawning, check if port is already in use. Kill existing process if PID is known (from pid file or port check).
- **Acceptance:** Only one MLX embed server process runs at a time.

### 26. LLM server log fd leaks on crash
- **File:** `src/lib/llm/server.ts:83-105`
- **Problem:** Opens file descriptor for log, doesn't close on process crash.
- **Fix:** Track fd and close in cleanup/shutdown handler.
- **Acceptance:** No leaked file descriptors after daemon shutdown.

### 27. Worker exit doesn't always clear task timeout
- **File:** `src/lib/workers/pool.ts:172-205`
- **Problem:** Timeout can fire after task already resolved via worker exit.
- **Fix:** Clear timeout in both the resolve and reject paths.
- **Acceptance:** No spurious timeout fires after task completion.

### 28. Daemon socket buffer unbounded
- **File:** `src/lib/daemon/daemon.ts:138-151`
- **Problem:** Reads chunks into buffer with no size limit. Malformed client can OOM the daemon.
- **Fix:** Cap buffer at 1MB. If exceeded, close connection with error.
- **Acceptance:** Oversized payloads are rejected, daemon stays healthy.

---

## Tier 6: MEDIUM — User Experience

### 29. "syncing" vs "indexing" status ambiguous
- **File:** `src/commands/status.ts:138-139`
- **Problem:** User can't tell fresh index from incremental watcher update.
- **Fix:** Use distinct labels: "indexing" for initial sync, "syncing" for watcher updates, "watching" for idle.
- **Acceptance:** `gmax status` shows the correct state for each project.

### 30. Search results "may be incomplete" too vague
- **File:** `src/commands/mcp.ts:492-496`
- **Problem:** No indication of how incomplete.
- **Fix:** Include coverage: "Warning: platform is 27% indexed. Results may be incomplete."
- **Acceptance:** Incomplete search results include coverage percentage.

### 31. Model tier fallback no validation
- **File:** `src/commands/doctor.ts:60`
- **Problem:** Silently falls back to `small` if config has unknown tier.
- **Fix:** Log a warning: "Unknown model tier 'X' in config, falling back to 'small'."
- **Acceptance:** Invalid config produces a visible warning.

### 32. Hooks pass `HF_TOKEN_PATH` to spawned servers
- **File:** `plugins/grepmax/hooks/start.js:66-71`
- **Problem:** Detached python processes lose macOS TCC permissions for external volumes. `HF_TOKEN_PATH` override prevents the token read from hitting the external volume.
- **Fix:** Set `HF_TOKEN_PATH` to `~/.cache/huggingface/token` in the spawn env if not already set.
- **Acceptance:** MLX embed server starts successfully even when HF_HOME points to an external volume.

---

## Tier 7: LOW — Cleanup & Polish

### 33. Remove `.osgrep` references from walker
- **File:** `src/lib/index/syncer.ts:381`, `src/lib/daemon/daemon.ts:273`
- **Problem:** Dead code from the osgrep rename. Confusing in tracebacks.
- **Fix:** Remove `**/.osgrep/**` from ignore patterns.
- **Acceptance:** No osgrep references remain in the codebase.

### 34. Plugin installer `marketplace remove` has no timeout
- **File:** `src/commands/claude-code.ts:56-59`
- **Problem:** If Claude CLI hangs, install hangs forever.
- **Fix:** Add a 30s timeout to the spawned process.
- **Acceptance:** Hung marketplace command times out and reports error.

### 35. JSON parse errors in daemon client silently skipped
- **File:** `src/lib/utils/daemon-client.ts:163-165`
- **Problem:** Stream corruption goes unnoticed.
- **Fix:** Log a warning with the raw line content when JSON parse fails.
- **Acceptance:** Malformed daemon responses produce a visible warning.

---

## Execution Order

**Phase 1 — Critical (items 1-6):** Fix silent data loss. Single PR.
**Phase 2 — High (items 7-17):** Fix consistency and observability. Single PR.
**Phase 3 — Medium (items 18-32):** Validation, resource management, UX. 1-2 PRs.
**Phase 4 — Low (items 33-35):** Cleanup. Bundle with Phase 3 or separate.

Each phase should be followed by a `gmax index` on platform to verify the fixes work end-to-end.
