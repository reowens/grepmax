# gmax — Architecture & Operations Guide

Read this before making changes.

The [review and verification budget in AGENTS.md](AGENTS.md#review-and-verification-budget)
applies to every agent. Older plan or evaluation review language cannot add
automatic review rounds or repeat test invocations beyond that budget.

---

## Documentation ownership

`AGENTS.md` and `CLAUDE.md` contain durable policy, architecture, invariants and
reusable procedures. They must never contain project status, progress logs,
release/deployment receipts, current versions, PIDs, snapshot IDs, test or benchmark
results, temporary holds, unfinished-work lists or next-action queues.

Put those records in the owning plan under `docs/plans/`; use
[the delivery plan](docs/plans/gmax-delivery.md) as the status entry point. Handoffs
and runbooks link to that plan rather than making the instruction files a second
status ledger. Exact dependency pins belong in dependency manifests; versioned
API compatibility facts may appear here when needed to explain a durable rule.
[Relocated history](docs/archived/architecture-operations-history.md) preserves the
status and incident context removed from this guide.

When updating status, edit the plan only. Change these instruction files only
when a durable rule, architecture or procedure changes. If status has leaked into
an instruction file, move it to the plan with its original context and date;
do not turn historical evidence into a current claim. Documentation relocation
requires diff inspection only and grants no execution or verification permission.

## Completion and release contract

[AGENTS.md](AGENTS.md#finish-every-approved-change-before-any-release) requires
ALL changes in the approved batch to be finished before versioning, publication,
deployment or a release announcement. This includes implementation, fixtures,
documentation and already-authorized verification. Do not release a completed
subset while leaving other in-scope work unfinished, or use an isolated worktree
to conceal it. Preserve unrelated pending work.

A release hold does not authorize more tests, profiles, reviews or acceptance
gates. A “go” does not reset a budget or authorize new before/after CPU rounds.
Complete only expressly approved actions, without repeated checkpoint questions.
Follow the user's execution mode: parent orchestration only when delegation is
required; direct work only when explicitly authorized. Delegation grants no
additional execution or verification permission.

**A docs/contract-only instruction pauses all implementation and execution.**
Do not start agents, tests, profiles, builds, maintenance, deployment or publication
under that restriction.

For explicitly approved FTS catch-up, use [the P3 runbook](docs/runbooks/p3-fts-catch-up.md).
Content-bounded catch-up can require multiple batches; positive remaining rows
are not a failure or another approval gate. Record completion in the owning plan
and do not rerun a completed operation because a separate profile hit a guard.
Host/process limits, rollback, owned-process cleanup, local-only checks and the
large-model restriction remain.

## Local checks and remote execution

[Ordinary repository retrieval](AGENTS.md#ordinary-repository-retrieval) is
separate from test/benchmark execution. Current-repo availability and actual
client tool attachment must be reported independently; explicit query, resource,
startup and model restrictions still apply.

All checks run locally in this repository. Do not send checks, tests, audits,
compilation or builds to Depot or any other remote builder without the user's
explicit approval for that run. Depot is not an approved verification path for
Gmax. A request to release does not authorize remote checks or remote builders.

The existing manually invoked `.github/workflows/release.yml` is the only CI
exception. Do not add or trigger other CI, remote qualification jobs or remote
verification stages. Do not expand the release workflow to run added checks.

The repo's `.claude/settings.json` denies Depot CLI commands for Claude Code.
All other agents must obey this rule directly; do not bypass it with another
shell, an absolute executable path, a shared project or a different provider.

---

## ⛔ HARD STOP — Never load the summarizer / large local LLMs without asking

**DO NOT, under any circumstances, start the summarizer server, load the
summarizer model, run `gmax summarize` in a way that loads a model, or launch
any multi-GB local LLM (llama-server, `mlx_lm`, `uv run python summarizer.py`,
etc.) without STOPPING FIRST and getting the user's explicit, in-the-moment
authorization.**

This is a hard rule with no exceptions — not for benchmarking, not for
"measuring a small sample," not because a plan/prompt seemed to ask for it, not
even if the user previously discussed it. The models involved are enormous
(Qwen3-Coder-30B-A3B ≈16GB, Qwen3.5-35B GGUF ≈21GB) and loading one has frozen
/ crashed this machine. A plan that says "run `gmax summarize`" is NOT
authorization to load a model — stop and ask.

Concretely, before doing ANY of the following, halt and ask the user:
- starting `mlx-embed-server/summarizer.py` or anything on port 8101
- starting `llama-server` / the LLM server (`src/lib/llm/server.ts`, port 8079)
  or issuing `llm-start` / `reviewCommit` / `investigate`
- `gmax summarize` (note: `generateSummaries` is intentionally stubbed to a
  no-op in `src/lib/index/syncer.ts` — do not "fix"/re-enable it)
- loading any local model over ~1GB for a benchmark or test

The summarizer is decommissioned on purpose. Leave it dead unless the user
explicitly, unambiguously tells you to bring it up in that exact session.

---

## Subagents

When spawning subagents, use the parent agent's model unless the user explicitly
requests a different model. Omit model overrides when inheritance is supported;
otherwise select the same model as the parent.

Agent worktrees land under `.claude/worktrees/` *inside* this repo. The directory is gitignored
and `vitest.config` excludes it, but a leftover worktree still shows in `git worktree list` and
can hold a merged branch — `git worktree remove <path>` and `git branch -d` once merged.

## Handoffs: `dotmd baton`

Read the owning plan under `docs/plans/` for current status and selected next work;
[the delivery plan](docs/plans/gmax-delivery.md) is the entry point.
`docs/future-sessions.md` holds local handoff notes, and
`docs/known-limitations.md` records consumer dependency audit caveats. Consume the
latest handoff before reusing old release or soak instructions.

"Baton" means save a resume prompt for the next session with `dotmd baton`, not a plan doc:

```bash
dotmd baton <slug> @/path/to/draft.md     # slug mode: saves resume-<slug>, touches nothing else
```

It writes `docs/prompts/resume-<slug>.md`, which is gitignored and session-local — do not
`git add` it, and never paste the resume text into chat. The next session consumes it with
`dotmd use`. Put the exact state in the draft: what is done and verified (with paths and numbers),
what is staged, why anything was deliberately not run, the exact next commands, and rollback.
Reference plan docs under `docs/plans/` from inside the draft rather than editing them. Plan mode
(`runlist baton @/tmp/resume.md` with an owned plan) also releases the plan; see `dotmd baton --help`.

---

## Process Architecture

gmax runs as cooperating processes. Only `gmax-mcp` may have multiple instances.

```
gmax-daemon (singleton via lockfile)
  |-- gmax-worker (1-4 child processes, spawned on backlog, reaped after 60s idle, min 1 kept alive)
  |-- [gmax-embed] (MLX GPU server on port 8100; daemon heartbeat respawns it if zombie or dead)
  +-- Unix socket server (~/.gmax/daemon.sock)

gmax-mcp (N instances, one per MCP client session)
```

### Who starts what

| Process | Started by | Lifecycle | Code |
|---------|-----------|-----------|------|
| gmax-daemon | `gmax watch --daemon -b` (SessionStart hook or manual); `gmax watch restart` | Singleton. 4h idle timeout; recycles at 24h age or 2.56 GB footprint. | `src/commands/watch.ts` |
| gmax-worker | Daemon's WorkerPool, lazy on first task | Reaped after 60s idle, min 1 kept alive | `src/lib/workers/pool.ts` |
| gmax-embed | Daemon's `ensureMlxServer()` (startup + 5min heartbeat health check) or `gmax serve` | 30min idle timeout. Spawned with `HF_HOME=~/.gmax/hf` (pinned local model cache) | `src/lib/daemon/mlx-server-manager.ts` |
| gmax-mcp | Codex and other clients with an explicit STDIO registration | Session lifetime | `src/commands/mcp.ts` |
| llama-server (LLM) | Daemon's LlmServer, on first `llm-start` IPC or `reviewCommit` | 30min idle timeout by default (`GMAX_LLM_IDLE_TIMEOUT`) | `src/lib/llm/config.ts`, `src/lib/llm/server.ts` |

### Local-only access

MCP exposes only stdin/stdout to its spawning client; it has no HTTP/SSE/TCP transport or host
option. A runtime regression exercises tools with server listeners forbidden. The daemon uses
only a Unix-domain socket in a 0700 home, with socket mode 0600; startup refuses if privacy cannot
be applied. HTTP serve and the Python embedding services bind 127.0.0.1. The optional LLM rejects non-loopback GMAX_LLM_HOST values without
starting a model. Preserve these boundaries:
never add a public MCP listener or wildcard bind. No MCP port needs a firewall rule.

### Session-scoped watching (watch leases)

The daemon watches a registered project only while something holds a lease on it
(`src/lib/daemon/watch-leases.ts`, persisted in `~/.gmax/watch-leases.json`).
Lease-gated subscriptions avoid background catchup and worker work for projects
without active consumers.

| Holder | Taken by | Ends when |
|---|---|---|
| `mcp:<pid>` | first index-reading tool use on a primary project, renewed by one timer every 5 min (15 min TTL) via `launchWatcher(root, lease)` | that process exits, or the TTL lapses |
| `session:<id>` | Claude SessionStart / CwdChanged, renewed on UserPromptSubmit and Bash PostToolUse (`plugins/grepmax/hooks/watch-lease.js`, 4h TTL) | SessionEnd releases it, CwdChanged releases the old root; idle leases expire |
| `cli` | `watch` IPC without a holder, and `add` / `ensure-project` / `index` (30 min TTL) | TTL |

- The heartbeat sweeps leases every minute and unwatches roots nobody holds. Vectors stay; the
  catchup scan on the next watch picks up what changed.
- Every re-watch after an index/rebuild/remove goes through `watchProjectWithinOperation`,
  which is gated on a lease, so an operation never leaves an unleased project watched.
- An indexed project without a lease is still searchable — `search` no longer answers
  `project not watched` for it.
- `unwatch` with a `holder` drops that lease; without one it drops every lease on the root.
  Older daemons ignore `holder`, so the hooks only release after `ping` reports
  `capabilities.watchLeases`.
- `GMAX_WATCH_ALL=1` restores watch-everything.
- `launchWatcher` only falls back to a per-project `gmax watch --path` when no daemon exists and
  none could be started. A live daemon that refuses or is still starting is reported instead;
  otherwise a lease renewal every few minutes would spawn a second writer beside it.
- Claude's CLI plugin has no bundled MCP server. Its shared hook helper reuses a lease-capable
  daemon and starts one only after `ENOENT`/`ECONNREFUSED`; live timeout/refusal/initialization
  never starts a second watcher. Hook startup polling is bounded, with later activity retrying
  ownership after cold startup. Hook-driven launches recheck quarantine in the child and
  leave a concurrently started daemon running, including when its version differs.
  Refresh the plugin after upgrading hook or installer behavior.

### Autostart kill switch

`~/.gmax/autostart-disabled` (or `GMAX_NO_AUTOSTART=1`) blocks every *implicit* daemon spawn — the
session/directory/activity hooks, `ensureDaemonRunning()`, and `launchWatcher()` — so a quarantined daemon stays
down instead of being revived by a plain `gmax add`. Gated callers degrade exactly as they already
do when the daemon is unavailable (in-process index/search); `add` and `index` print a one-line
notice naming the undo step. Explicit `gmax watch --daemon` is never gated. The semantics live in
`src/lib/utils/autostart.ts` and are mirrored in `plugins/grepmax/hooks/watch-lease.js` (a hook cannot
import from dist) — keep the two in sync.

### Singleton enforcement (daemon)

`ProcessManager.assertStartupAvailable()` checks this home's PID and draining
markers before taking the lock and again after acquiring it. A live peer or
unverifiable marker refuses startup; a draining predecessor must finish first.
Process names and registry PIDs never authorize terminating another owner.

The daemon takes the exclusive proper-lockfile lease (`stale: 120s`), starts its
private socket, then writes its PID before opening shared resources. Only its
owned control state may be removed during shutdown. Orphan-worker cleanup is
limited to this daemon's children and requires two consecutive suspicion samples.

A systemd-owned daemon's recycle/restart stays inside its unit. Default-home
startup recognizes user-config `gmax.service` / `hetchy-gmax.service` and starts
through systemctl. Failed or unverifiable service ownership cannot fall through
to a detached daemon or watcher; read-only startup cannot start a normal unit.

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

One table (`chunks`), all projects share it, scoped by path prefix
(`/absolute/path/to/project/`). A path btree accelerates scoped exact search.
IVF_FLAT is flag-gated by `GMAX_ANN=1` and disabled by default. Containment policy
schedules no maintenance loop and no speculative embedding warmup. Historical
maintenance fixtures explicitly mock off the immutable production policy;
that mock does not authorize production maintenance.

Compaction must take its snapshot **after** `drainWrites()`, and reopen the table
on each retry. `optimize()` caps calls at two attempts, updates the prune cutoff
each time to include earlier failed copies, and checks fresh available space
against twice the logical table size plus `DISK_CRITICAL_BYTES`. This estimate
includes overhead margin but reserves no space against other applications.
Use disposable stores for regression work; never rewrite the live store to
reproduce an incident.

Containment policy disables all full-table optimization and scheduled maintenance,
including force/doctor/startup paths, before native setup. There is no production
override. Retained copies require separately verified exclusive prune-only
recovery through `gmax recover` and its pinned Python helper. Live cleanup requires
fresh admission and exclusive ownership. Persistent host safety stops and
quarantine must survive hook launches, recycle, installation and explicit daemon
startup; do not remove them as routine troubleshooting. Legacy compaction
regressions use a test-only policy mock; that does not authorize live compaction.

New pressure stops retain optional bounded `diagnostics` inside the existing
`~/.gmax/safety-stop.json` schema-version-1 record. Review that original record
before later health samples: it identifies the admission source/phase, selected
policy, PID and requested reservation kind/size, together with triggering OS and
kernel measurements. Initial and refreshed OS probes retain their separate times,
durations, classifications and parsed sysctl flags (1 normal, 2 warning, 4 critical).
Kernel probes retain bytes, element count/size and timing. An early stop omits
probes that never ran; no extra probe is taken to manufacture an incident snapshot.
Strict resource admission retains its original aggregate/headroom/swap sample;
critical-only keeps these unavailable rather than introducing a footprint scan.
Evidence uses an allowlist and excludes argv, query text, source paths, process
inventories and raw probe output. Invalid optional evidence cannot prevent the
stop; older reason-only records remain valid. The first stop's cause and evidence
are preserved across later refusals. Guard thresholds, latch expiry/clear behavior
and ownership rules remain in force. Older events cannot be backfilled;
interpret optional evidence according to the runtime that produced it.

LanceDB 0.39 passes the absolute cleanup cutoff unchanged to native code; versions created during optimize can remain until later maintenance. Fresh unreferenced fragments newer than the latest retained manifest can also survive a no-rewrite optimize; see `docs/known-limitations.md`. Verify physical size/doctor rather than assuming success proves every copy was removed.

Compaction attempts and final outcomes are logged as bounded JSON records in `daemon.log`: `Compaction attempt:`, `Compaction attempt failed:`, and `Compaction result:`. Results distinguish completed/skipped/failed and carry timestamps, attempt counts, duration, logical size, physical bytes before/after, free bytes before/after and reclaimed bytes where known. Status IPC and `gmax status --json` retain the latest outcome without directory scans. `doctor --fix` releases its diagnostic reader before requesting compaction; only exact socket absence errors permit a fresh local repair connection. Failed/skipped/unverified repairs are not counted as fixes and exit nonzero. The existing five-minute recycle probe also logs periodic resource baselines; one-minute intervening heartbeats add no sampling, and the 30-minute settling window still protects young daemons from recycling.

#### LanceDB cache bounds and the daemon's footprint

`lancedb.connect()` without a `Session` gets a 6 GB index cache and a 1 GB metadata
cache, held for the connection's life. `VectorDB` connects with a Session capped at
1 GB / 256 MB (`GMAX_LANCE_INDEX_CACHE_MB`, `GMAX_LANCE_METADATA_CACHE_MB`). Pass the
Session in `ConnectionOptions.session`: SDK 0.38 silently ignores the legacy
positional third argument despite retaining its type declaration.
`VectorDB.cacheSizeBytes()` reports what the caches currently hold.

The recycle watermark (`GMAX_DAEMON_RSS_WATERMARK_MB`, 2560) is compared against
physical footprint from `footprint -p` (`src/lib/utils/process-footprint.ts`). RSS
can omit compressed and swapped pages. The footprint trigger waits for 30 min of
uptime so a fresh daemon cannot recycle in a loop. Once a recycle is due it is
rechecked every heartbeat; after `GMAX_DAEMON_RECYCLE_FORCE_AFTER_MS` (1h) it proceeds
over in-flight project work, while still waiting out compaction.

#### The FTS optimize panic guard

The development dependency supplies the official LanceDB SDK. Build preparation
copies its unmodified JS runtime into `dist/vendor/lancedb`; exact optional
platform packages supply the native binary. This avoids resolving unused SDK
provider dependencies for consumers. Preserve runtime/native pin compatibility,
licenses and provenance. Dependency manifests own exact pins; do not maintain a
second version ledger here. Postinstall must not overlay another native build.

Preserve the terminal-failure guard in `vector-db.ts`:
`createFTSIndexUnsafe()` **throws** on terminal failure, and
`disabling auto-rebuild until an optimize succeeds` is transient. A native panic
must be reported upstream rather than treated as an expected retry cost. This
does not lift the prohibition on production optimization.

#### Building a missing FTS index once: `gmax repair --fts`

Containment leaves `createFTSIndex()` adopt-only, so a store rebuilt from scratch (or a table that
lost its index) has no full-text index and every search warns `Full-text search unavailable`.
`gmax repair --fts` (ping capability `ftsBuild: 1`) is the one narrow way to build it. The
daemon's `fts-build` shared operation calls `VectorDB.buildMissingFTSIndex()`, which runs inside the
write gate, returns `exists` when an index already covers `content`, requires disk pressure `ok`, and
makes a single `createIndex(..., { replace: false })` attempt; it never replaces or drops an index.
The daemon refuses it while paused, while a bulk index operation runs, or while any project is
`pending`; version cleanup and bounded maintenance defer while it runs. Rows written after the build
stay searchable through FTS's unindexed-row scan (`fastSearch` off), so no later rebuild is needed.
It does not lift containment: compaction and automatic index builds stay disabled.

#### Abandoned `.tmp*` files

An interrupted optimize can strand a scratch file with no manifest entry.
`optimize({deleteUnverified: true})` cannot prove such files are garbage, and the
leading dot hides them from a plain `ls`. Do not prescribe a whole-table rewrite
to reclaim scratch bytes.

`findStaleLanceTempFiles` / `sweepStaleLanceTempFiles` in `vector-db.ts` collect them, and both the
maintenance loop and `doctor --fix` sweep **before** measuring bloat, so any ratio left afterwards
is real. Two things to preserve:

- The **age gate** (`STALE_TEMP_FILE_AGE_MS`, 1 h) is the entire safety argument. An in-flight write
  keeps bumping its temp file's mtime, so anything staler has no writer — which is why the sweep
  needs none of the single-writer routing that `optimize` does, and is safe from the CLI while the
  daemon runs.
- `doctor` excludes stale temp bytes from the ratio that sets `needsOptimize`. Counting them there
  prescribes a whole-table rewrite for bytes a rewrite cannot free.

### Project Registry (projects.json)

Status values: `"pending"` | `"indexed"` | `"error"`

- `indexed` — searchable; the daemon watches it (and runs catchup) while a session holds a lease
- `pending` — daemon indexes in background on startup via `indexPendingProject()`
- `error` — **daemon ignores it**. Must be manually re-added or status edited.

A shutdown, recycle or version handover that aborts `indexPendingProject` leaves the status as it
was (normally `pending`), so the next daemon resumes it.
An `initialSync` that returns `degraded` (walk errors or an incomplete root) stays `pending` and is
retried 30 s later, up to five times.

#### A missing root is not necessarily a dead project

`fs.existsSync(root)` collapses two different situations: an external drive that is unplugged (or a
network share that is down), and a directory that was genuinely deleted. `classifyRoot()` in
`src/lib/utils/root-availability.ts` separates them by checking whether the *mount point* under a
container (`/Volumes`, `/run/media`, `/media`, `/mnt`, `/net`) exists — if the volume itself is
absent, the project is `unavailable`, not `missing`.

This matters because `removeProject()` only drops the registry entry. Deregistering a project whose
drive is merely unplugged strands its vectors in the shared table with no owning project — invisible
to every cache-coherence check, since those all iterate the registry — and reconnecting the drive
does not undo it. `doctor --fix` therefore only removes roots classified `missing`; `unavailable`
ones are reported as `INFO  Offline projects` and kept. The daemon already did the safe thing
(skip and keep), and now names the reason in its log line.

`mountDepth` in `MOUNT_CONTAINERS` deliberately errs high on ambiguous platforms, because a wrong
`unavailable` only declines to auto-remove a dead project, while a wrong `missing` silently
deregisters a live one.

---

## Daemon Lifecycle

### Startup (`daemon.ts:start()`)

```
 0. Set process title and evaluate host resource admission / paused service.
 1. Register read verbs; preflight this home's daemon/draining markers and standalone watchers.
 2. Create private IPC home, acquire exclusive lock, then repeat ownership preflight.
 3. Start the private socket (0600), then publish the PID file.
 4. Open shared stores and initialize managers; optional LLM remains lazy.
 5. Restore eligible leased watches / pending indexing when service admission permits.
 6. Run heartbeat, idle/recycle handling and eligible embedding-server supervision.
```

A live or unverifiable predecessor refuses startup; this path does not terminate
processes by name. Paused service retains its bounded-read restrictions.

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

#### FSEvents gaps and subscription failures

FSEvents client/kernel drop notices mean events were lost and the filesystem must
be reconciled. Globs alone filter after delivery, but current gmax also passes a
bounded set of existing, policy-excluded literal directories to Parcel's native
subscription through `subscribeWithNativeExclusions`. This reduces generated-artifact
traffic before delivery; it does not guarantee that the host never drops events.
Unsupported project rules remain in file policy rather than being translated
into exclusions that could hide source.

- Known gap errors (`isFSEventsGap`) keep the native stream attached. The daemon
  marks the root recovering and requests reconciliation, coalescing scans with
  `FSEVENTS_GAP_SCAN_INTERVAL_MS` (30 seconds). A gap during a scan retains a later
  scan because already-visited paths could have changed. The interval controls
  scan scheduling, not a guarantee that scans or embedding finish within 30 seconds.
- Terminal subscription errors use resubscription backoff; more than three failures
  enter five-minute polling. Native recovery probes run every 15 minutes. This
  fallback is separate from the attached-stream gap path.
- `handleFileEvent` drops never-indexed paths that loaded policy already ignores.
  Paths with metadata still flow through so changed policy can retire their
  vectors; forced repairs and deletes bypass the early check.

Status exposes cumulative `overflowCount`, watcher mode, catchup/reconciliation
state and queues. The counter includes watcher callback errors; inspect the error
kind before calling every increment an FSEvents drop. Per-root error logs are
throttled to one per minute, so missing intermediate totals do not mean missing
counter increments. Completed reconciliation timestamps indicate scan completion;
verify embedding queues and failed files separately before claiming catchup.
Historical overflow measurements are snapshots, not current guarantees. Watching
remains owned by standalone gmax; Hetchy Developer is optional.

The optional `watcherRecovery` health record separates FSEvents `gapCount` from
`terminalErrorCount`. A scan captures both counts when it starts; only a complete
scan advances `coveredGapCount`. A later gap stays in `outstandingGapCount` until
a subsequent complete scan covers it. `lastScan` retains its ID, start/end times
and outcome; `lastCompleteScan` survives failed, incomplete or aborted attempts.
Admission failure before scan execution is recorded without inventing a scan.
`reconciliationNeeded` includes incomplete scans and outstanding errors; scan
coverage still does not establish that queued ingestion has drained.

Attached exclusions are summarized with literal/filter counts and a SHA-256
fingerprint of the accepted subscription policy, including fallback. Health reads
do not repeat directory discovery or disclose excluded paths. This is bounded,
process-local evidence, reset when a watch lifecycle is removed; historical
callback errors cannot be backfilled. `gmax watch status` displays it when present.
Standalone `WatcherHandle.health` exposes the same record; its registry snapshot
updates on the existing 60-second heartbeat with a separate `indexStateAt`
timestamp. Legacy entries and older runtimes can omit these optional fields.
Interpret health evidence using the serving runtime's capabilities.

Recovery qualification checks committed rows and metadata against current file
bytes, in addition to scan coverage and queue drainage. The focused recovery
fixtures cover dropped creates/deletes, atomic saves, repeated and late gaps,
terminal subscription replacement and refused admission. Local packed-consumer
acceptance uses `scripts/test-watcher-consumer.cjs` with real native watchers,
LanceDB and LMDB. FSEvents coverage requires a local macOS run. These fixtures
use tiny temporary homes/stores and deterministic vectors, with subprocess
startup forbidden.
They also check native edits and exclusion re-inclusion/retirement. Gap callbacks
are deliberately injected after muted delivery; this proves recovery convergence,
not that the OS will never drop events or that production has recovered. Keep
natural-gap live acceptance separate. Run these native fixtures locally against
disposable stores, outside the development machine's live store.

### Batch processor (`ProjectBatchProcessor`)

```
File event (from watcher or catchup) -> pending map -> debounce 2s -> processBatch()
  For each file (batches of 50, bounded parallelism reserving one worker for search):
    stat -> isFileCached? -> skip if mtime+size match
    Send to WorkerPool.processFile()
      Worker: read -> hash -> chunk (tree-sitter) -> embed (MLX or ONNX) -> return vectors
    If hash unchanged -> update meta only, no vector write ("0 reindexed")
    If hash changed -> delete old vectors, insert new, update meta
    If shouldDelete -> delete vectors, update meta
  Flush once after all file tasks settle: insert vectors -> delete old paths -> update MetaCache
  Report reindex count
  If pending files remain, reschedule
```

A batch waits for the project lock (`watch-batch` through `runProjectOperation`) with a per-batch
start signal that `close()` and `pause()` abort, leaving its files pending. Callers that unwatch
while holding that lock (`indexPendingProject`, `indexProject`, remove) would otherwise wait on a
batch that is waiting on them. Preserve this abortable lock wait to avoid deadlock.

### Worker pool

- Starts with 1 worker and scales up to `CONFIG.WORKER_THREADS` (`min(4, max(2, floor(effective CPUs/2)))`, capped at effective CPUs; `workerThreads` in `~/.gmax/config.json` (`gmax config --worker-threads`) overrides it and `GMAX_WORKER_THREADS` overrides both; read once at daemon start). `dispatch()` adds a worker only when the pool is empty, a search task is waiting, more than 4 queued tasks per live worker are waiting, or the oldest queued task has waited 2s (`GMAX_WORKER_SCALE_UP_WAIT_MS`).
- Automatic CPU capacity uses affinity and the tightest readable cgroup-v2 ancestor quota, rounded down with a one-CPU floor. Explicit worker overrides retain their existing precedence and validation.
- Background files share a pool-wide admission limit across projects: `max(1, min(effective CPUs - 1, max workers - 1))`, with foreground query priority. Cancellation settles the caller but retains native file ownership until completion or confirmed exit. Timed-out/error children remain tracked through shutdown.
- `ProjectBatchProcessor` runs at most `ceil(batch.size / 4)` files of a batch at once
- Workers are child processes (not threads) — isolates ONNX Runtime segfaults
- IPC uses Node's advanced serialization so Buffer and typed-array payloads retain their binary types and view offsets
- Idle workers reaped after 60s back down to `MIN_KEEP_WORKERS = 1` (favors low resident memory over search warmth — an idle worker holds ~300MB–1GB; the rare search pays a one-off cold start). Reap sends SIGTERM, then escalates to SIGKILL after 5s if the worker is still alive (defends against a worker stuck inside a native ONNX matmul tight loop that won't service signals)
- Workers over 1536MB RSS for consecutive post-task samples are recycled
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
    If MLX unavailable -> compatible ONNX CPU in-process
    Run ColBERT on dense embeddings
  Return vectors + hash + meta
```

MLX client (`mlx-client.ts`) caches availability for 30s. The cache is module-level state inside each worker process, so the daemon cannot invalidate it directly. A failed POST marks the cache unavailable; recovery probes health after the TTL expires.

MLX transport errors, deadlines, HTTP 408/429, and 5xx responses are temporary backend failures. Invalid JSON, vector/model mismatches, and other 4xx responses are deterministic errors. Workers preserve `EMBED_BACKEND_UNAVAILABLE` through IPC; incremental batches back off 5–60s without consuming per-file retries or deleting existing rows. New file events cannot bypass that backoff. The initial compatible ONNX fallback remains available; an operation cannot switch embedding identity midway.

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
`ping`, `watch`, `unwatch`, `status`, `search`, `search-v2`, `llm-start`, `llm-stop`, `llm-status`

MCP search-backed tools prefer `search`/`search-v2` so concurrent MCP sessions share the daemon's worker pool. They fall back to an in-process searcher only for daemon availability, readiness, size, or protocol-compatibility failures; search correctness and scope errors remain visible.

**Streaming commands** (request -> progress lines -> done -> close):
`index`, `add`, `remove`, `summarize`, `review`

```
-> {"cmd":"index","root":"/path"}\n
<- {"type":"progress","processed":10,"total":500}\n
<- {"type":"progress","processed":11,"total":500}\n
<- {"type":"done","ok":true,"indexed":450}\n
```

### Read verbs

The daemon is meant to be the only process that opens the store while it runs, so every read-only
command is a thin IPC client: one request line, one response line, render. Verbs sit at the
*library-function* boundary, not the row boundary — the daemon runs `findTests`, `GraphBuilder`,
`analyzeSurprisingConnections` and returns the finished answer, because proxying rows would ship
megabytes per call and turn a multi-hop trace into dozens of round trips.

| Family | Verbs | Serves |
|---|---|---|
| graph | `graph.resolve`, `graph.tests`, `graph.dependents`, `graph.trace`, `graph.peek`, `graph.dead`, `graph.audit` | `test`, `impact`, `trace`, `peek`, `dead`, `audit`, `extract`'s tests footer |
| graph (MCP-only) | `graph.neighbors`, `graph.paths`, `graph.subgraph`, `graph.risk` | `get_neighbors`, `find_paths`, `subgraph_for_files`, `review_risk` |
| rows | `rows.symbols`, `rows.project`, `rows.locate`, `rows.skeleton` | `symbols`, `project`, `extract`, `related`, `log`, `skeleton`, `context` |
| vector | `vector.similar`, `vector.surprises` | `similar`, `surprises` |

The MCP-only four are GraphBuilder entry points with no CLI command behind them:
`getNeighbors`, `findPaths`, `subgraphForFiles`, and the graph half of `gatherRiskInputs` (the
git half — diff and churn — stays with the caller, as `extract`'s body read does). Each has its own
hop or size bound, which is why they are separate verbs rather than options on `graph.trace`.

Verbs register in `src/lib/daemon/read-verbs.ts` instead of adding a `case`: `ipc-handler`'s
`default:` looks the name up there before answering `unknown command`, which keeps the router from
becoming a merge magnet as handler files land. Each runs through
`Daemon.runSharedOperation(<verb>, ...)`, so an exclusive rebuild answers `DAEMON_BUSY` naming the
verb rather than racing it, and the abort signal is bound to socket close exactly like `search`.
`ping.capabilities.readVerbs` carries `READ_VERBS_PROTOCOL`.

Heavy verbs (`HEAVY_READ_VERBS` in `read-verbs.ts`: audit, dead, risk, subgraph, trace,
`rows.project`, `vector.similar`, `vector.surprises`) queue on a global semaphore before admission,
2 at a time by default (`GMAX_HEAVY_READ_CONCURRENCY`), so N MCP sessions cannot run N full-table
scans at once. A client that disconnects while queued never touches the store.

**Fallback rule** — `withStoreRead` in `src/lib/utils/store-access.ts` owns it, and it is
deliberately narrow:

- `ENOENT` / `ECONNREFUSED` — nothing is listening, so no daemon exists. The **only** case that
  permits opening the store in-process.
- `unknown command` — an outdated or incompatible live daemon. Report it with `gmax watch restart`;
  never open a second reader. Use `ping.capabilities.readVerbs` for protocol compatibility.
- `EPERM` / `EACCES` — a sandbox blocked the socket. Refuse with exit code 2 and the one settings
  line; never open the store.
- Anything else (`DAEMON_BUSY`, timeouts, scope rejections, store failures) — a *live* daemon said
  no. Report it. Falling back here would put a second opener on the store while the first is
  working, which is the exact failure the routing exists to prevent.

An in-process lease failure with `EPERM`/`EACCES`/`EROFS` gets the same refusal, naming
`sandbox.filesystem.allowWrite` instead of the socket key.

**MCP is the one caller with a wider fallback set.** Its read tools pass `fallbackOnOversize` plus
an `extraFallback` for `project not watched` and `daemon not ready` (`MCP_STORE_FALLBACK` in
`mcp.ts`). The reason is that an MCP tool call has no user at a prompt to wait or re-run, so it
degrades to its own short-lived store read; a CLI command reports instead, because falling back
there would put a second opener on the store while the daemon is working. `mcp.ts` holds no
`VectorDB` of its own — the only store it may open is the one `withLocalStore` opens and closes
inside a fallback — so an MCP session leaves no marker under `~/.gmax/lancedb.lease/readers/`
while a daemon serving the verbs is up.

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
| `[daemon]` | daemon.ts + ipc-handler.ts | Lock, socket, IPC commands, indexPendingProject timing, lease unwatches, recycle deferrals |
| `[catchup]` | daemon.ts | Per-file miss reasons (null cache, mtime mismatch), summary stats |

### Other debug env vars

- `GMAX_DEBUG_MODELS=1` — Model loading details in workers
- `GMAX_DEBUG_INDEX=1` — Per-file progress during initial sync
- `GMAX_NO_DAEMON=1` — Skip the daemon on read commands and run in-process (for
  comparing the two paths' output; it does not relax the sandbox refusal)

### Sandbox behaviour

`scripts/sandbox-smoke.sh` runs the read commands under the two `sandbox-exec` profiles that
reproduce Claude Code's Bash sandbox and prints an exit-code/first-line table. macOS only and
manual; pass `--root <indexed project>` when running from another directory.

The two profiles, for reproducing one command by hand. They are the smallest thing that recreates
the two walls Claude Code puts up — writes under `~/.gmax` denied (the store lease is a `mkdir`, so
a read is a writer) and Unix sockets denied (the daemon is unreachable):

```bash
# 1. Writes denied, sockets allowed — the daemon path must still work.
sandbox-exec -p '(version 1)(allow default)(deny file-write* (subpath "'"$HOME"'/.gmax"))' \
  gmax status

# 2. Writes and sockets denied — Claude Code's default. Every read command must
#    exit 2 with one line naming a settings key, and never a stack trace.
sandbox-exec -p '(version 1)(allow default)(deny file-write* (subpath "'"$HOME"'/.gmax"))(deny network*)' \
  gmax test resolveTargetSymbols
```

`(deny network*)` is broader than the real profile — it takes out TCP as well — but Unix sockets
are what matters here, and no read verb touches the network. Under profile 2 the socket connect
surfaces as `EPERM` from `sendDaemonCommand`, which is the wire shape `classifyDaemonError` keys on.
`gmax doctor` reports the same gap from settings, before anything is run.

### Common diagnostics

Search/status/MCP health includes failed files even when no batch is running. Native watcher recovery and polling remain visible separately from index work; polling may lag by five minutes. `lastReconciledAt` records the last complete filesystem scan, not completion of queued embeddings. Same-file test expansion is labeled `file-candidate` rather than direct coverage. Builtin member names such as `get`, `add`, and `now` remain unresolved unless there is a free call or a same-file definition; cross-file receiver binding is still approximate.

Recycle threshold crossings and handoffs log `[daemon] Resource snapshot:` with the sampled footprint, RSS, heap, external/ArrayBuffer counters, Lance cache, workers, pending files, active operations, and maintenance state. `gmax status --json` exposes the most recent snapshot (or null before any capture). Snapshots do not scan process tables or store directories. Compare several recycle cycles under a repeatable workload to distinguish JS heap growth from native/cache growth; these diagnostics do not establish a memory leak's cause by themselves. Watcher drop messages are throttled to one per root per minute while every event still increments the overflow counter and triggers recovery.

```bash
ps aux | grep "gmax-"                              # Process state
gmax status                                        # Daemon responsive?
gmax status --json                                 # Health + last resource snapshot
gmax watch status                                  # Watcher mode, failures, reconciliation
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
- `src/lib/utils/daemon-launcher.ts` — spawnDaemon() for background mode; spawnDaemonProcess() spawns the daemon itself
- `src/lib/utils/daemon-restart.ts` — `gmax watch restart`: stop, wait for exit (IPC, then SIGTERM), start or adopt a successor; never two daemons

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
- `src/lib/workers/colbert-math.ts` — MaxSim + cosine over ColBERT vectors, using `inner` from `numkong`

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
- `src/lib/utils/root-availability.ts` — `classifyRoot()`: unplugged volume vs deleted directory
- `pnpm-workspace.yaml` — **dependency overrides live here**, next to the other pnpm 10 settings.
  Do not move them to `package.json`'s top-level `overrides`: pnpm does not read that field, and
  npm ignores a *dependency's* overrides entirely, so it is inert both locally and for consumers.

### Release
Checks run locally only when selected by the user. `package.json` exposes
`release:check`; its existence does not authorize a new verification round or a
remote run. `npm version patch` stages version metadata and invokes the version
hook, so do not use it as a read-only readiness command.

Publication uses the existing manually dispatched `.github/workflows/release.yml`
for the reviewed archive and source receipt. This is the sole CI exception;
additional checks and Depot builds are not part of publication. The hook pushes
versions without publishing or installing. Installation and normal daemon
handover use the explicit `scripts/postrelease.sh --install` path.

The Python audit uses Python 3.11+ standard-library TOML/HTTP support and OSV; it installs
no packages and loads no models. Network failures or incomplete responses fail the gate.
It checks registry packages in `mlx-embed-server/uv.lock`; the local project and explicitly
pinned `mlx-embeddings` Git source are reported outside that audit. Preserve advisory floors
in `pyproject.toml` when refreshing the lock. Opt-in HTTP compatibility tests run with
`GMAX_TEST_MLX=1 <locked-venv>/bin/python -m unittest discover -s tests/python` and do not
run the model-loading lifespan. Only the cached small embedding model may be used for
the separate real embedding smoke; the large-model hard stop still applies.

The daemon restart is the step that makes a release actually live. The global install only updates
the binary on PATH; a daemon spawned from the old one keeps serving the socket, so every command
still talks to the previous build until something forces a handoff. `postrelease.sh` runs
`gmax watch --daemon -b` (the graceful path — the new binary asks the old daemon to exit over IPC,
logged as `reason=version-mismatch`), then confirms the result with a `ping` IPC call. It checks the
**daemon's** reported version, not `gmax --version`, which reads the freshly-installed binary and
would report success even against a stale daemon. It only restarts a daemon that is already
running, and never fails the release — the publish is irreversible by then, so a restart problem is
a warning, not an exit code.

Before the global install, `postrelease.sh` polls the abbreviated packument that `npm install`
reads (not `npm view`'s full document, which can go live first) and installs with
`--prefer-online`, so a stale cached packument cannot fail every retry with `ETARGET`.

`postrelease.sh` is not in the package's `files` list, so changes to it take effect on the next
`npm version patch` without needing a release of their own.

Note that `postrelease.sh` ends with a real `npm install -g`, which **replaces an `npm link`
symlink**. If the global `gmax` is linked to this working tree, re-run `npm link` afterward — and
be aware that while it is linked, any dependency change plus a daemon restart reaches the live
shared store.

#### Checking which lance binary the daemon actually loaded

After any global install, `lsof -p $(cat ~/.gmax/daemon.pid) | grep lancedb.*\.node` should point
at the `@lancedb/lancedb-darwin-arm64` platform package under the global grepmax.
An unexpected SDK-local native binary can indicate a stale overlay. Resolve the
installation through the approved reinstall procedure rather than mixing binaries.

Also: a same-version reinstall does **not** restart the daemon. `gmax watch --daemon -b` only
hands off on a version mismatch, so after fixing an install in place run `gmax watch restart`
(graceful IPC shutdown, waits for the old process to exit, then starts one); otherwise the old process keeps
serving from npm's deleted staging directory.

### SDK packaging

Exact dependency pins are reproducibility choices, not a user-imposed version
freeze. When an upgrade is requested, refresh the stable SDK, matching native
platform packages, lockfile and generated official runtime together. Align
maintenance writers with the embedded storage engine using versioned upstream
format/API evidence; document any actual compatibility constraint instead of
attributing an old pin to the user. Do not relabel older qualified native
artifacts or enable automatic upgrades or additional checks.

`src/lib/store/lance-sdk.ts` loads the generated official SDK runtime for compiled consumers and the exact development pin for source tests. `scripts/prepare-lance-runtime.cjs` preserves licenses and checks native/runtime dependency pins. `pnpm run audit:consumer` packs the built distribution, resolves a fresh npm consumer without workspace overrides, audits it, and exercises the native store with synthetic vectors. It never loads a model.

### Logging
- `src/lib/utils/logger.ts` — `log()`, `debug()`, `timer()`, `debugTimer()`, `debugEvery()`; gated on `GMAX_DEBUG=1`
- `src/lib/utils/log-rotate.ts` — Log rotation (5MB max, single .prev backup)
