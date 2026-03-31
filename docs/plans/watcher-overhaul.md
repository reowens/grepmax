# Watcher System Overhaul Plan

## Problem

The watcher system has grown organically across 9+ files with no unified lifecycle. Auto-indexing bypasses `gmax add` in 3 places, watchers spawn without registration checks, race conditions exist on multi-session startup, and stale state accumulates silently. The watcher registry uses a JSON file with no atomicity guarantees despite LMDB already being a dependency.

## Design Decisions from Research

1. **Use LMDB for watcher registry** (not JSON) — we already depend on `lmdb` (kriszyp/lmdb-js) which provides ACID transactions. This eliminates the race condition on concurrent reads/writes that plagues `watchers.json`. One `put()` in a transaction is atomic.

2. **Single daemon, not per-project processes** — chokidar v5 supports `watcher.add()` to dynamically add directory trees to a single instance. One daemon watching all registered projects uses fewer resources than N separate processes and eliminates the coordination problem entirely.

3. **`gmax add` is the only entry point for new projects** — no silent auto-indexing. MCP calls `gmax add` for unregistered projects. CLI search refuses. Watcher only watches registered projects.

## Principles

1. **`gmax add` is the only entry point** — no auto-indexing anywhere else
2. **One daemon, many projects** — single watcher process, dynamic add/remove
3. **LMDB for all state** — watcher registry moves from JSON to LMDB (atomic, crash-safe)
4. **Watcher requires registration** — won't watch unregistered projects
5. **Fail loud** — log errors, don't swallow spawn failures
6. **Registration is explicit** — not a side effect buried in `initialSync()`

---

## Status

| Phase | Status | Notes |
|-------|--------|-------|
| 1. Gate auto-index | **Done** | All 4 paths gated on registration |
| 2. Separate registration | **Done** | `initialSync()` no longer calls `registerProject()` |
| 3. LMDB watcher store | **Done** | `watcher-store.ts` with migration from JSON |
| 4. Centralize spawn | **Done** | `watcher-launcher.ts` with `LaunchResult` type; MCP uses it |
| 5. Single daemon | **Not started** | Main remaining work |
| 6. MCP coverage | **Done** | 7 handlers call `ensureWatcher()` |
| 7. Log consolidation | **Done** | `~/.gmax/logs/` with shared `openRotatedLog()` |
| 8. Watcher resilience | **Done** | Pool failure requeue + verified stop with SIGKILL |

---

## Phase 1: Gate all auto-index paths on registration ✅

**Goal:** Make `gmax add` the single entry point. Remove all other auto-index paths.

### 1.1 `search` gates on registration ✅
- `src/commands/search.ts` — `getProject(checkRoot)` check exits early with "run gmax add" before any `initialSync()` or `--sync` path is reached.

### 1.2 Watcher gates on registration ✅
- `src/commands/watch.ts` — `getProject(projectRoot)` check at top of foreground mode exits with error. Background mode re-spawns into foreground, hitting the same check.

### 1.3 SessionStart hook checks registration ✅
- `plugins/grepmax/hooks/start.js` — `isProjectRegistered()` reads `projects.json` and checks `cwd.startsWith(p.root)` before calling `gmax watch -b`.
- **Note:** The hook reads `projects.json` directly rather than calling a gmax command. This is acceptable — it's a fast path check that avoids spawning a process, and the format is stable. If the registry moves away from JSON, this hook must be updated.

### 1.4 MCP `ensureWatcher` checks registration ✅
- `src/commands/mcp.ts` — `ensureWatcher()` delegates to `launchWatcher()`, which checks registration internally.

---

## Phase 2: Separate registration from indexing ✅

**Goal:** `registerProject()` is explicit in callers, not a hidden side effect of `initialSync()`.

### 2.1 `registerProject()` removed from `initialSync()` ✅
- `initialSync()` returns `{ processed, indexed, total, failedFiles }`. Callers register explicitly.

### 2.2 Callers updated ✅
All callers (`add.ts`, `index.ts`, `watch.ts`, `search.ts`) now call `registerProject()` explicitly after `initialSync()` returns.

---

## Phase 3: LMDB watcher store ✅

**Goal:** Atomic watcher state, no race conditions, crash-safe.

### 3.1 `src/lib/utils/watcher-store.ts` ✅
Implemented with:
- Location: `~/.gmax/cache/watchers.lmdb`
- API: `register()`, `unregister()`, `get()`, `getAll()`, `getCovering()`
- Migration from `watchers.json` on first use

**Design note:** Uses a separate LMDB environment from `meta.lmdb` rather than named databases in a shared environment. Tradeoff: slightly more file handles, but simpler lifecycle — each store opens/closes independently. Acceptable given we have only 2 LMDB stores.

### 3.2 Heartbeat ✅
- `WatcherInfo.lastHeartbeat` updated every 60s via `setInterval`
- Stale threshold: 5 minutes (miss 5 consecutive beats)

**Known risk:** The heartbeat timer runs on the main event loop. If `processBatch()` blocks the loop during a large reindex (heavy synchronous LMDB writes or Tree-sitter parsing), heartbeats can be delayed. In practice, the async pipeline yields frequently enough that this hasn't been a problem, but Phase 8 should add a defensive check: if the batch took longer than the heartbeat interval, fire an immediate heartbeat after the batch completes.

### 3.3 Migration ✅
- `migrateFromJson()` reads `watchers.json`, writes live entries to LMDB, deletes JSON file.

---

## Phase 4: Centralize watcher spawn logic ✅

**Goal:** One function, one pattern, consistent behavior.

### 4.1 `src/lib/utils/watcher-launcher.ts` ✅
`launchWatcher()` returns a discriminated union so callers can distinguish outcomes:

```typescript
type LaunchResult =
  | { ok: true; pid: number; reused: boolean }
  | { ok: false; reason: "not-registered" | "spawn-failed"; message: string };
```

### 4.2 All spawn sites migrated ✅
- `add.ts` — uses `launchWatcher()`, logs spawn failures
- `index.ts` — uses `launchWatcher()`, logs spawn failures
- `search.ts` — uses `launchWatcher()`, logs spawn failures
- `mcp.ts` — `ensureWatcher()` delegates to `launchWatcher()` (no more inline spawn)

---

## Phase 5: Single daemon architecture

**Goal:** One watcher process for all projects instead of N per-project processes.

### 5.1 IPC via Unix domain socket

**Socket:** `~/.gmax/daemon.sock`

The daemon listens on a Unix domain socket. CLI commands send JSON messages
and receive JSON responses. This gives us:
- Immediate feedback ("added" / "error") back to CLI
- Automatic crash detection (ECONNREFUSED = daemon dead)
- Clean concurrent handling from multiple Claude sessions
- ~130µs latency vs 2-10s for polling

**Protocol:**
```
→ {"cmd": "watch", "root": "/path/to/project"}
← {"ok": true}

→ {"cmd": "unwatch", "root": "/path/to/project"}
← {"ok": true}

→ {"cmd": "status"}
← {"ok": true, "projects": [{"root": "...", "status": "watching"}]}

→ {"cmd": "ping"}
← {"ok": true, "pid": 12345, "uptime": 3600}
```

**Stale socket cleanup:** On daemon startup, try connecting to existing socket.
If ECONNREFUSED, unlink and recreate. If connected, another daemon is alive — exit.

**Security model:** The socket inherits `~/.gmax/` directory permissions (default umask, typically 0755 on macOS). Since it's inside the user's home directory, only the owning user can connect. No additional authentication is needed — this matches the threat model (local single-user tool).

**Filesystem compatibility:** Unix domain sockets require a local filesystem. If `~/.gmax/` is on NFS or another filesystem that doesn't support sockets, `net.createServer()` will fail with EOPNOTSUPP. Fallback: if socket creation fails, log a warning and fall back to per-project watcher mode (Phase 4 path). The daemon client's `ensureDaemon()` should catch this and degrade gracefully.

### 5.2 Daemon process (`gmax watch --daemon`)

**File:** `src/commands/watch.ts` (extend existing)

New `--daemon` flag starts multi-project mode:
1. Read all registered projects from `projects.json`
2. Create single chokidar instance with `watcher.add()` for each root
3. Listen on `~/.gmax/daemon.sock` for IPC commands
4. Register in LMDB watcher store (single entry, PID + "daemon" flag)
5. Heartbeat every 60s
6. Idle timeout: 30min with no **file-change events** across ALL projects → shutdown

**Idle timeout definition:** Only file-change events from chokidar count as activity. Search queries, IPC pings, and status checks do NOT reset the idle timer. Rationale: if no files are changing, there's no indexing work to do — the daemon should release resources. On next search, `ensureDaemon()` restarts it.

On IPC `watch` command:
- Call `chokidar.add(root)` on the existing watcher instance
- Update LMDB store

On IPC `unwatch` command:
- Call `chokidar.unwatch(root)`
- Update LMDB store

### 5.3 Daemon client utility

**New file:** `src/lib/utils/daemon-client.ts`

```typescript
export async function sendDaemonCommand(
  cmd: DaemonCommand,
): Promise<DaemonResponse>

export async function isDaemonRunning(): Promise<boolean>

export async function ensureDaemon(): Promise<void>
// If daemon not running, spawn gmax watch --daemon
// If running, return immediately
```

Uses `net.createConnection({ path: SOCKET_PATH })` to connect.
ECONNREFUSED → daemon is dead, spawn a new one.
EOPNOTSUPP → filesystem doesn't support sockets, fall back to per-project mode.

### 5.4 Update callers

| Caller | Current | After |
|--------|---------|-------|
| `gmax add` | `launchWatcher(root)` | `ensureDaemon()` then `sendDaemonCommand({cmd: "watch", root})` |
| `gmax remove` | kills watcher PID, unregisters | `sendDaemonCommand({cmd: "unwatch", root})` |
| `gmax index` | stop/restart per-project watcher | `sendDaemonCommand({cmd: "unwatch", root})`, index, then `sendDaemonCommand({cmd: "watch", root})` |
| MCP `ensureWatcher` | `launchWatcher()` | `ensureDaemon()` (daemon watches all registered) |
| SessionStart hook | `gmax watch -b` | `gmax watch --daemon` (if not already running) |
| `gmax watch status` | list per-project watchers | `sendDaemonCommand({cmd: "status"})` |
| `gmax watch stop` | kill per-project PID | `sendDaemonCommand({cmd: "shutdown"})` or kill daemon PID |

### 5.5 Mutual exclusion: daemon vs. per-project watchers

Running both a daemon and per-project watchers for the same root causes duplicate file events and double-indexing. The system must enforce mutual exclusion:

**Daemon startup:**
1. Read all entries from `WatcherStore.getAll()`
2. For each registered project, check if a per-project watcher is already running (PID alive, not a daemon)
3. If found: send SIGTERM, wait up to 5s, then SIGKILL if still alive
4. Only then `chokidar.add(root)` for that project
5. Log: `[daemon] Took over watching ${root} from per-project watcher (PID ${pid})`

**Per-project watcher startup (fallback mode):**
1. Check if a daemon is running via `isDaemonRunning()`
2. If daemon is running: send `{cmd: "watch", root}` to daemon instead of starting a per-project watcher — return the daemon's PID
3. If daemon is not running: proceed with per-project spawn as today

**`launchWatcher()` updated logic:**
```
1. Try IPC: isDaemonRunning()?
   → yes: sendDaemonCommand({cmd: "watch", root}), return daemon PID
   → EOPNOTSUPP: sockets not supported, skip to step 2
   → ECONNREFUSED: daemon dead, skip to step 2
2. Spawn per-project watcher (existing behavior)
```

This means `launchWatcher()` remains the single entry point. Callers don't need to know whether a daemon or per-project watcher is active.

### 5.6 Worker pool sharing

One worker pool (piscina) serves all projects. File processing results
are tagged with the project root (already the case — vectors store
absolute paths). No change to the embedding pipeline.

### 5.7 Files to create/modify

| File | Action |
|------|--------|
| `src/lib/utils/daemon-client.ts` | NEW — IPC client |
| `src/commands/watch.ts` | MODIFY — add `--daemon` mode with socket server |
| `src/lib/utils/watcher-launcher.ts` | MODIFY — prefer daemon, fallback to per-project |
| `src/commands/add.ts` | MODIFY — use daemon client |
| `src/commands/remove.ts` | MODIFY — use daemon client |
| `src/commands/index.ts` | MODIFY — use daemon client for stop/restart |
| `src/commands/mcp.ts` | MODIFY — ensureWatcher uses ensureDaemon |
| `plugins/grepmax/hooks/start.js` | MODIFY — start daemon, not per-project watcher |
| `src/lib/index/watcher.ts` | MODIFY — support multiple project roots |

### 5.8 Verification

1. `gmax add ~/proj1 && gmax add ~/proj2` → one daemon, two projects watched
2. `gmax watch status` → shows daemon PID with both roots
3. Kill daemon → next `gmax search` restarts it automatically
4. `gmax remove ~/proj1` → daemon unwatches, continues watching proj2
5. `gmax watch stop` → daemon shuts down cleanly, socket removed
6. Two Claude sessions → both connect to same daemon
7. `ps aux | grep gmax` → only one watcher process regardless of project count
8. Start per-project watcher, then start daemon → daemon takes over, old PID gone
9. Start daemon on NFS home dir → falls back to per-project mode with warning

---

## Phase 6: MCP ensureWatcher coverage ✅

All 7 MCP tool handlers call `ensureWatcher()`:
- `handleSemanticSearch`, `handleCodeSkeleton`, `handleTraceCalls`, `handleListSymbols`, `handleRelatedFiles`, `handleRecentChanges`, `handleSummarize`

---

## Phase 7: Logging consolidation ✅

- All logs consolidated to `~/.gmax/logs/` (was `/tmp/` for MLX server + droid hook)
- Shared `openRotatedLog()` utility in `src/lib/utils/log-rotate.ts` (5MB rotation, keep `.prev`)
- `PATHS.logsDir` constant added to `src/config.ts`

---

## Phase 8: Watcher resilience ✅

### 8.1 Requeue on pool failure ✅
- `watcher.ts` tracks attempted files in a Set during batch processing
- After early abort (pool unhealthy or signal aborted), unprocessed files are requeued to `pending`
- Files will be retried on next batch cycle

### 8.2 Post-batch heartbeat — N/A
- `processBatch()` is fully async; the event loop is never blocked. Heartbeat `setInterval` fires normally during batch processing. No fix needed.

### 8.3 Verified stop with SIGKILL ✅
- Shared `killProcess()` in `src/lib/utils/process.ts`: SIGTERM → poll 3s → SIGKILL → poll 1s
- Used by `watch stop`, `watch stop --all`, and `remove`

### 8.4 Chokidar crash recovery — N/A
- Already handled via `ignoreInitial: false` on restart. No fix needed.

---

## Implementation Order

| Phase | Effort | Impact | Status | Ship as |
|-------|--------|--------|--------|---------|
| 1. Gate auto-index | Small | Critical | **Done** | — |
| 2. Separate registration | Medium | High | **Done** | — |
| 3. LMDB watcher store | Medium | High | **Done** | — |
| 4. Centralize spawn | Small | High | **Done** | — |
| 6. MCP coverage | Trivial | Medium | **Done** | — |
| 7. Log consolidation | Trivial | Low | **Done** | — |
| 8. Watcher resilience | Small | Medium | **Done** | — |
| 5. Single daemon | Large | High | TODO | **Future — own PR** |

---

## Verification

Phases 1–4, 6 (all done):
1. `gmax search "query"` on unregistered project → "run gmax add" (not auto-index) ✅
2. `gmax search "query" --sync` on unregistered project → same ✅
3. `gmax watch -b` on unregistered project → refuses to start ✅
4. MCP `ensureWatcher()` uses `launchWatcher()` — no inline spawn ✅
5. `launchWatcher()` returns `LaunchResult` with distinct error reasons ✅
6. All 7 MCP tool handlers call `ensureWatcher()` ✅

Phases 7–8 (all done):
7. MLX logs in `~/.gmax/logs/` not `/tmp/` ✅
8. All logs rotate at 5MB via shared `openRotatedLog()` ✅
9. Pool failure mid-batch → unprocessed files requeued to pending ✅
10. `gmax watch stop` → SIGTERM, poll 3s, SIGKILL if needed ✅
11. `gmax remove` → same verified kill via shared `killProcess()` ✅

After daemon PR:
12. `gmax add ~/proj1 && gmax add ~/proj2` → one daemon, two projects watched
13. `gmax watch status` → shows daemon PID with both roots
14. Kill daemon → next `gmax search` restarts it
15. `gmax remove ~/proj1` → daemon unwatches, continues watching proj2
16. Per-project watcher running → daemon startup takes over cleanly
17. Two Claude sessions → both connect to same daemon
18. `ps aux | grep gmax` → only one watcher process
