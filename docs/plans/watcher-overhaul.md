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

## Phase 1: Gate all auto-index paths on registration

**Goal:** Make `gmax add` the single entry point. Remove all other auto-index paths.

### 1.1 `search --sync` must not auto-index unregistered projects
- **File:** `src/commands/search.ts`
- **Current:** `--sync` skips the registration check and runs `initialSync()` directly
- **Fix:** `--sync` only reindexes registered projects. If unregistered, print "run gmax add" regardless of `--sync`

### 1.2 Watcher must not `initialSync()` unregistered projects
- **File:** `src/commands/watch.ts:100-116`
- **Current:** If no indexed data found, watcher runs `initialSync()` directly
- **Fix:** Check project registry. If not registered, log warning and exit

### 1.3 SessionStart hook must check registration before starting watcher
- **File:** `plugins/grepmax/hooks/start.js:60-66`
- **Current:** Unconditionally calls `gmax watch -b`
- **Fix:** Read `projects.json` (or LMDB after Phase 3), check if CWD is registered. Only start if registered. MCP handles unregistered projects via `gmax add` on first search.

### 1.4 MCP `ensureWatcher` must check registration
- **File:** `src/commands/mcp.ts:340-348`
- **Current:** Spawns watcher without checking registration
- **Fix:** Check `getProject(projectRoot)` before spawning. Skip if not registered.

---

## Phase 2: Separate registration from indexing

**Goal:** `registerProject()` is explicit in callers, not a hidden side effect of `initialSync()`.

### 2.1 Remove `registerProject()` from `initialSync()`
- **File:** `src/lib/index/syncer.ts:540-554`
- **Current:** `registerProject()` called at end of `initialSync()` as side effect
- **Fix:** `initialSync()` returns `{ processed, indexed, total, failedFiles }`. Callers register explicitly.

### 2.2 Update all callers
| Caller | Current | After |
|--------|---------|-------|
| `add.ts` | Registers "pending" before, syncer registers "indexed" after | Registers "pending" before, updates to "indexed" after sync returns |
| `index.ts` | Relies on syncer side effect | Updates existing entry (lastIndexed, chunkCount) after sync |
| `watch.ts` | Relies on syncer side effect | Updates existing entry after sync |
| `search.ts --sync` | Relies on syncer side effect | Updates existing entry after sync |

---

## Phase 3: Move watcher registry from JSON to LMDB

**Goal:** Atomic watcher state, no race conditions, crash-safe.

### 3.1 Create `src/lib/utils/watcher-store.ts`
New LMDB-backed watcher registry replacing `watchers.json`:
- **Location:** `~/.gmax/cache/watchers.lmdb` (alongside `meta.lmdb`)
- **Schema:** key = project root, value = `WatcherInfo`
- Uses the same `lmdb` package as MetaCache
- All reads/writes are transactional — no more load→filter→push→save races

```typescript
export class WatcherStore {
  register(info: WatcherInfo): void       // atomic put
  unregister(projectRoot: string): void   // atomic remove
  get(projectRoot: string): WatcherInfo | undefined
  getAll(): WatcherInfo[]                 // prunes dead PIDs on read
  getCovering(dir: string): WatcherInfo | undefined
}
```

### 3.2 Add heartbeat
- `WatcherInfo` gains `lastHeartbeat: number`
- Watcher updates heartbeat every 60s
- `get()` treats heartbeat >5min stale as dead (even if PID alive — catches deadlocks)

### 3.3 Migrate existing code
- Replace all `watcher-registry.ts` imports with `watcher-store.ts`
- Delete `watchers.json` on first use of new store
- Files affected: `watch.ts`, `mcp.ts`, `index.ts`, `add.ts`, `search.ts`, `status.ts`, `start.js`

---

## Phase 4: Centralize watcher spawn logic

**Goal:** One function, one pattern, consistent behavior.

### 4.1 Create `src/lib/utils/watcher-launcher.ts`
```typescript
export function launchWatcher(projectRoot: string): { pid: number } | null
```

1. Checks project is registered → null if not
2. Checks no watcher already running (via WatcherStore) → returns existing PID if so
3. Spawns `gmax watch --path <root> -b`
4. Logs success or failure
5. Returns `{ pid }` or null

### 4.2 Replace all spawn sites
- `src/commands/add.ts` — after indexing
- `src/commands/mcp.ts` — ensureWatcher
- `src/commands/index.ts` — restart after reindex
- `src/commands/search.ts` — start after sync
- `plugins/grepmax/hooks/start.js` — SessionStart

---

## Phase 5: Single daemon architecture (future)

**Goal:** One watcher process for all projects instead of N per-project processes.

> **Note:** This is a larger architectural change. Phases 1-4 fix the immediate bugs with the current per-project model. Phase 5 is the future-state redesign.

### 5.1 Convert watcher to multi-project daemon
- Single `gmax watch` process watches all registered projects
- Uses chokidar's `watcher.add()` / `watcher.unwatch()` for dynamic project management
- On `gmax add`: daemon picks up new project automatically (via LMDB watch or IPC)
- On `gmax remove`: daemon unwatches project
- SessionStart hook starts daemon if not running (not per-project watcher)

### 5.2 Daemon lifecycle
- Started by first `gmax add` or SessionStart hook
- Idle timeout: shuts down after 30min if NO registered projects have activity
- Single PID in LMDB, multiple project roots tracked
- Health endpoint or heartbeat for liveliness detection

### 5.3 Why defer this
- Phases 1-4 fix all critical bugs with minimal risk
- Single daemon requires IPC or LMDB-based signaling for add/remove
- Per-project model works fine for <10 projects
- Daemon makes sense when users have 20+ projects

---

## Phase 6: MCP ensureWatcher coverage

**Goal:** Watcher stays alive during any MCP tool use, not just search.

### 6.1 Call ensureWatcher from all tool handlers
- **Current:** Only called in `handleSemanticSearch()` (line 363)
- **Fix:** Call at top of every handler — skeleton, trace, symbols, related, recent, etc. It's cheap (one LMDB read).

---

## Phase 7: Logging consolidation

### 7.1 Move MLX server logs to `~/.gmax/logs/`
- **Current:** `/tmp/mlx-embed-server.log` and `/tmp/mlx-summarizer.log`
- **Fix:** `~/.gmax/logs/mlx-embed-server.log` with 5MB rotation

### 7.2 Unified log rotation
- Apply watch.ts rotation logic (5MB, keep `.prev`) to all log files

---

## Phase 8: Watcher resilience

### 8.1 Handle worker pool failure
- Clear pending files on pool failure (don't accumulate forever)
- Log the error
- Files re-detected on next change via mtime

### 8.2 Stop hook with verification
- Check PID after `gmax watch stop`
- SIGKILL if still alive after 3s

### 8.3 Chokidar crash recovery
- Chokidar re-emits `add` events on restart for files that changed during downtime (if mtime differs from initial scan)
- No need to persist pending queue — chokidar handles this via `ignoreInitial: false` on restart
- On watcher restart, `ready` event fires after full re-scan, catching missed changes

---

## Implementation Order

| Phase | Effort | Impact | Dependencies | Ship separately? |
|-------|--------|--------|-------------|-----------------|
| 1. Gate auto-index | Small | Critical | None | Yes — immediate fix |
| 2. Separate registration | Medium | High | Phase 1 | Bundle with Phase 1 |
| 4. Centralize spawn | Small | High | Phase 1 | Bundle with Phase 1 |
| 3. LMDB watcher store | Medium | High | Phase 4 | Yes — own PR |
| 6. MCP coverage | Trivial | Medium | Phase 4 | Bundle with Phase 3 |
| 7. Log consolidation | Trivial | Low | None | Yes — own PR |
| 8. Watcher resilience | Small | Medium | Phase 3 | Bundle with Phase 3 |
| 5. Single daemon | Large | High | Phase 3 | Future — own PR |

**PR 1:** Phases 1 + 2 + 4 — gate auto-index, separate registration, centralize spawn
**PR 2:** Phases 3 + 6 + 8 — LMDB watcher store, MCP coverage, resilience
**PR 3:** Phase 7 — log consolidation
**Future:** Phase 5 — single daemon

---

## Verification

After PR 1:
1. `gmax add .` → indexes, starts watcher, `.gmax.json` created
2. `gmax status` → shows project as "indexed" with "watching"
3. `gmax search "query" --sync` on unregistered project → "run gmax add" (not auto-index)
4. `gmax watch -b` on unregistered project → refuses to start
5. MCP search on new project → runs `gmax add`, watcher starts
6. `gmax remove . --force` → watcher stopped, data cleaned, entry gone
7. `gmax index` on registered project → reindexes, updates registry entry

After PR 2:
8. Open two Claude sessions on same project → only one watcher (LMDB atomic)
9. Kill watcher process → next `gmax status` shows "idle" (heartbeat stale)
10. Next search → watcher auto-relaunched
11. All MCP tools (skeleton, trace, etc.) keep watcher alive

After PR 3:
12. MLX logs in `~/.gmax/logs/` not `/tmp/`
13. All logs rotate at 5MB
