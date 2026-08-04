---
type: doc
status: reference
created: 2026-07-09
updated: 2026-08-04
surfaces:
  - daemon
  - workers
  - index
  - store
  - search
  - serve
  - config
  - security
modules:
  - src/commands/serve.ts
  - src/lib/daemon/daemon.ts
  - src/lib/daemon/mlx-server-manager.ts
  - src/lib/daemon/watcher-manager.ts
  - src/lib/index/batch-processor.ts
  - src/lib/index/index-config.ts
  - src/lib/index/syncer.ts
  - src/lib/index/walker.ts
  - src/lib/store/vector-db.ts
  - src/lib/utils/file-utils.ts
  - src/lib/utils/project-registry.ts
  - src/lib/utils/scope-filter.ts
  - src/lib/workers/pool.ts
domain: repository audit (security, correctness, lifecycle, and data integrity)
audience: internal
summary: Audit findings and remediation status for gmax security, lifecycle, scope, and index integrity.
related_plans:
  - docs/plans/embedding-reembed-atomic-cutover.md
  - archived/2026-07-09-repository-audit-fixes.md
related_docs:
  - docs/embedding-layout-decision.md
  - docs/known-limitations.md
  - archived/stability-cycle-v0.26.2.md
  - docs/archived/2026-06-28-repo-audit-hardening.md
  - docs/2026-08-04-performance-review.md
current_state: >
  Audit and remediation Phases 1 through 8 are complete and released through v0.26.2,
  with follow-up stability fixes through v0.26.5. Current HEAD passes 124 test files /
  1035 tests, both typechecks, and Biome across 308 files.
next_step: >
  None for this audit. Recurring LanceDB FTS panic work, embedding migration, and
  semantic-ranking experiments are tracked in focused plans.
---

# Repository Audit - 2026-07-09

## Executive Summary

The repository has broad unit coverage and passes its current automated checks. The audit
nevertheless found important gaps below those tests, concentrated in five areas:

1. Network and project-scope boundaries are not consistently enforced.
2. Destructive global rebuilds are not isolated from live daemon resources and writers.
3. Worker cancellation and daemon-managed model lifecycle contain concurrency and cleanup races.
4. Initial scans, catchup scans, and live watcher events apply different ingestion policies.
5. Several persistence and error paths silently convert corruption or transient failure into
   apparently valid state.

No production files were changed during the audit. The pre-existing modification to
`docs/docs.md` was left untouched. No summarizer, local LLM server, or multi-GB local model was
started.

## Remediation Status - 2026-07-11

| Findings | Status |
|---|---|
| F1, F4-F7, F10-F14 | Remediated in Phases 1-4A with regression coverage. |
| F9 | Preference preservation and exact configured-versus-built identity separation are remediated. |
| F2-F3 | Remediated through exclusive daemon/store admission, immutable resource replacement, durable rebuild journaling, strict drop/schema checks, and per-project completion stamps. |
| F8 | Remediated in Phase 7 with explicit ownership states, strict health identity, single-flight lifecycle operations, and bounded owned-process cleanup. |
| Additional Phase 4B risks | Remediated across v0.26.0-v0.26.2 with migration-aware exact hashing, vector/tombstone metadata, per-path coherence, deletion-only critical-pressure batches, ENOSPC metadata preservation, and watcher restoration. |

The remediation gate passes with 118 test files / 968 tests, both TypeScript configurations, Biome
across 301 files, production dependency audit, direct build, tarball inspection, and
`git diff --check`. No MLX server or model was started. The detailed findings below remain the
historical audit evidence; this status table records their current disposition.

## Scope and Method

The review covered:

- CLI and HTTP surfaces
- daemon startup, shutdown, IPC, locks, and recovery
- worker-pool dispatch, cancellation, timeout, and process cleanup
- initial indexing, catchup scans, watcher events, and cache coherence
- LanceDB and LMDB update paths
- project and search scoping
- global and index configuration persistence
- security-sensitive path, symlink, and process handling
- existing tests relevant to each finding

The review was read-only except for this document. Findings were traced through call sites and
checked against existing tests. Automated verification used installed local binaries to avoid a
dependency reinstall.

## Initial Audit Verification Snapshot

| Check | Result |
|---|---|
| `./node_modules/.bin/tsc --noEmit` | Passed |
| `./node_modules/.bin/biome lint .` | Passed, 255 files checked |
| `./node_modules/.bin/vitest run` | Passed, 83 files / 686 tests |
| `pnpm audit --prod` | Passed, no known vulnerabilities |

The normal `pnpm typecheck`, `pnpm lint`, and `pnpm test` wrappers did not run because pnpm 11
attempted to purge/reinstall `node_modules` and aborted without a TTY. The same underlying tools
passed when invoked directly. pnpm also warned that the `pnpm.overrides` field in `package.json`
is no longer read by pnpm 11; the current lockfile still pins `mathjs` to 15.2.0.

## Severity Model

- **High:** can expose source or local files, corrupt or misrepresent the shared index, crash
  native worker/model state, or leak a large model process.
- **Medium:** can silently lose preferences or registrations, retain stale data, cross an intended
  local project boundary, or mask an operational failure.

## Confirmed Findings

### F1 - `gmax serve` exposes indexed source beyond localhost

**Severity:** High

**Evidence:**

- `src/commands/serve.ts:243-375` creates unauthenticated `/health`, `/stats`, and `/search`
  endpoints.
- `src/commands/serve.ts:312-340` accepts `body.path` and `body.limit` without containment or
  range validation.
- `src/commands/serve.ts:410` calls `server.listen(port)` without a host, which binds all available
  interfaces on Node rather than loopback only.

**Trigger:** Run `gmax serve` on a network-reachable machine. A client can submit a search with an
absolute path such as `/`, an escaping relative path such as `../other-project`, and a very large
numeric `limit`.

**Impact:**

- remote disclosure of indexed source snippets and absolute paths
- cross-project disclosure from the shared LanceDB table
- disclosure of index/model metadata through `/stats`
- excessive CPU, memory, and result-window work through an unbounded limit

**Recommended direction:** Bind `127.0.0.1` by default, make non-loopback binding explicit, enforce
canonical project containment, reject non-finite/negative limits, and cap the result limit.

**Test gap:** `tests/serve-command.test.ts` tests registry behavior but not server binding, HTTP
authentication assumptions, path containment, or request limits.

### F2 - Model-tier rebuild uses stale daemon resources

**Severity:** High

**Evidence:**

- `src/lib/daemon/daemon.ts:248` constructs `VectorDB` once during daemon startup.
- `src/lib/store/vector-db.ts:82-90` captures `vectorDim` in the constructor.
- `src/lib/workers/pool.ts:126-164` reads model configuration when each worker process is spawned.
- `src/lib/workers/pool.ts:939-945` retains the singleton pool and existing workers.
- `src/lib/daemon/daemon.ts:797-843` reads the new global config during `repairRebuild()` but reuses
  the existing DB, worker pool, and MLX service.

**Trigger:** Start the daemon on the small tier, change to the standard tier, and run
`gmax repair --rebuild` without restarting the daemon.

**Impact:** Depending on worker state, the rebuild can recreate an old-width table and stamp it as
the new width, or produce new-width vectors that the old-width `VectorDB` rejects. The repair
command intended to resolve a dimension change therefore cannot reliably do so in a live daemon.

**Recommended direction:** Treat a model-tier change as a resource-generation change. Rebuild must
recreate or restart the worker pool, `VectorDB`, and MLX service after rereading configuration, then
verify the physical table schema before updating project registry metadata.

**Test gap:** `tests/model-tier-wiring.test.ts` constructs fresh resources under a mocked tier. It
does not exercise an already-running daemon across a tier change.

### F3 - Global rebuild is not isolated from active writers

**Severity:** High

**Evidence:**

- `src/lib/daemon/daemon.ts:780-846` drops the shared table before taking per-project locks and
  then locks only one project at a time.
- Existing `ProjectBatchProcessor` instances and other index/add requests remain active.
- `src/lib/store/vector-db.ts:944-950` performs `dropTable()` outside `withWriteGate()` and catches
  every error as though the table were merely absent.

**Trigger:** Run `gmax repair --rebuild` while watcher batches or another indexing request are
writing.

**Impact:** Concurrent writers can retain stale table handles, race table recreation, encounter
commit conflicts, or write partial data into the rebuilding table. A real drop failure can be
suppressed and followed by a misleading rebuild result.

**Recommended direction:** Add a daemon-wide exclusive operation barrier. Quiesce processors and
drain reads/writes before dropping or swapping global storage. Route drop through the store's
exclusive gate and ignore only a verified table-not-found error.

**Test gap:** No test invokes `repairRebuild()` with a live processor, search, or competing index
request.

### F4 - An aborted task can make one worker run two tasks concurrently

**Severity:** High

**Evidence:**

- `src/lib/workers/pool.ts:549-559` rejects a running task immediately and records its ID in
  `abortedTasks` while allowing the child operation to continue.
- `src/lib/workers/pool.ts:411-420` treats the next message for an aborted ID as terminal cleanup,
  marks the worker idle, and dispatches more work.
- The heartbeat branch is checked only afterward at `src/lib/workers/pool.ts:426-440`.
- `src/lib/workers/process-child.ts:48-95` uses an asynchronous message handler and has no one-task
  serialization inside the child.

**Trigger:** Abort a running `processFile` task after it starts but before its next progress
heartbeat. The heartbeat enters aborted-task cleanup, and the pool can assign another task while
the first operation is still running.

**Impact:** Concurrent ONNX or MLX operations can run through one worker and shared native model
state. Pool accounting becomes incorrect, memory usage can spike, and native runtimes can crash.

**Recommended direction:** Keep the worker busy until a terminal result or process exit. Ignore
heartbeats for an aborted task without completing it, or terminate the worker when cancellation of
a running task is required.

**Test gap:** `tests/worker-pool-resilience.test.ts` covers heartbeats, deadlines, and recycling but
does not combine an abort signal with a subsequent heartbeat and queued follow-up task.

### F5 - Watcher events bypass sensitive and generated-file exclusions

**Severity:** High

**Evidence:**

- `src/lib/index/ignore-patterns.ts:3-102` defines full-scan exclusions, including generated files,
  fixtures, private keys, `secrets.*`, and `credentials.*`.
- `src/lib/index/walker.ts:41-66` applies those defaults plus `.gitignore` and `.gmaxignore` during
  a walk.
- `src/lib/index/watcher.ts:20-45` applies only a smaller fixed watcher list.
- `src/lib/index/batch-processor.ts:67-75` checks only extension/basename and ignored directory
  segments before queueing a live event.

**Trigger:** Create or modify an indexable file excluded from the initial scan, such as
`secrets.ts`, `credentials.json`, a generated TypeScript file, or an indexable file ignored by a
repository ignore file.

**Impact:** A file that is deliberately absent after a full index can enter the shared index after
a live event. Sensitive content can then be exposed through CLI, MCP, or HTTP search.

**Recommended direction:** Build one shared ignore-policy evaluator for full walks, catchup scans,
and watcher events. Changes to ignore files should trigger reconciliation and removal of newly
excluded paths.

**Test gap:** `tests/watcher-ignore.test.ts` only asserts that a few fixed directory strings are
present. It does not test parity with full-scan policy or sensitive filenames.

### F6 - Transient scan errors are interpreted as file deletions

**Severity:** High

**Evidence:**

- `src/lib/index/walker.ts:75-80` silently returns from a directory on any `readdir` error.
- `src/lib/daemon/watcher-manager.ts:387-433` swallows all per-file stat/read errors.
- `src/lib/daemon/watcher-manager.ts:440-447` queues unlink events for every cached path not seen.
- `src/lib/index/syncer.ts:545-563` similarly computes stale paths from an incomplete walk and
  removes them.

**Trigger:** A directory becomes temporarily unreadable, a mount is unavailable, or an I/O error
interrupts a full or catchup scan.

**Impact:** Existing vectors and cache entries for still-present files can be deleted. A root-level
failure can make most or all of a project's index appear stale.

**Recommended direction:** Track failed or incomplete subtrees. Never perform stale cleanup below a
failed directory, and suppress all cleanup if the root scan cannot be completed. Surface the scan
error to the caller and daemon status.

**Test gap:** `tests/syncer-logic.test.ts` tests set subtraction but not permission failures,
incomplete walks, or cleanup suppression.

### F7 - Symlinks can index files outside the project

**Severity:** High

**Evidence:**

- `src/lib/index/walker.ts:82-115` yields a symlink as a non-directory entry.
- `src/lib/index/syncer.ts:405-422` detects a symlink with `lstat()` and resolves it for deduplication,
  but then checks `stats.isFile()` on the original symlink stat and skips it.
- `src/lib/daemon/watcher-manager.ts:387-418` uses `stat()`, which follows the symlink.
- `src/lib/index/batch-processor.ts:193-233` also follows the path and sends it to a worker without
  checking the target realpath against the project root.

**Trigger:** An indexed repository contains an indexable symlink such as
`project/leak.ts -> /outside/project/private.ts`.

**Impact:** Full sync and incremental paths behave inconsistently. Catchup or live events can read
and store arbitrary user-readable files outside the selected project under the symlink's in-project
path.

**Recommended direction:** Choose one explicit symlink policy. At minimum, canonicalize both root
and target and reject any target outside the canonical project root in every ingestion path.

**Test gap:** No test covers an external file symlink through full sync, catchup, and live watcher
processing.

### F8 - MLX startup success and timeout leak resources

**Severity:** High

**Evidence:**

- `src/lib/daemon/mlx-server-manager.ts:128-152` opens a rotated log descriptor and passes it to a
  detached child.
- `src/lib/daemon/mlx-server-manager.ts:180-200` returns on successful readiness without closing the
  parent's descriptor.
- `src/lib/daemon/mlx-server-manager.ts:202-207` handles startup timeout by clearing `mlxChild`
  without closing the descriptor or terminating and waiting for the detached process group.

**Trigger:** Repeated successful starts leak parent descriptors. A model that takes longer than 30
seconds to load is reported as failed while the detached process can continue loading and later
bind the port.

**Impact:** File-descriptor exhaustion, orphan model processes retaining many gigabytes, and port
collisions during recovery or restart.

**Recommended direction:** Close the parent descriptor immediately after a successful spawn. On
timeout, terminate and await the verified detached process group before discarding ownership.

**Test gap:** `tests/mlx-server-manager.test.ts` covers only the asynchronous spawn-error path.

### F9 - Full indexing deletes global preferences

**Severity:** Medium

**Evidence:**

- Global and index configuration both use `~/.gmax/config.json` through `src/config.ts:266-290` and
  `src/lib/index/index-config.ts:39`.
- `GlobalConfig` includes `queryLog` and `llmEnabled` at
  `src/lib/index/index-config.ts:30-37`.
- `writeIndexConfig()` reconstructs the object without either field at
  `src/lib/index/index-config.ts:90-110`.
- Full sync calls `writeIndexConfig()` at `src/lib/index/syncer.ts:580-583`.

**Trigger:** Enable query logging or the local LLM, then complete a full index.

**Impact:** Indexing silently removes the preference. Query logging or LLM functionality appears
to disable itself after otherwise successful maintenance.

**Recommended direction:** Separate global preferences from index identity, or preserve all global
fields during index writes. Per-project model identity belongs in project-specific registry state,
not one global index stamp.

**Test gap:** Configuration tests do not run a full sync after setting `queryLog` or `llmEnabled`.

### F10 - Short reads can hash and embed uninitialized memory

**Severity:** Medium

**Evidence:**

- `src/lib/utils/file-utils.ts:54-75` allocates `before.size` bytes with `Buffer.allocUnsafe()`.
- It issues one `handle.read()` call and ignores the returned `bytesRead` value.
- The final stat check verifies only mtime and size, not that the buffer was filled.

**Trigger:** A filesystem or mocked file handle returns a legal short read without changing file
size or mtime. Network, FUSE, and unusual filesystems make this more plausible than ordinary local
files.

**Impact:** Unfilled bytes can affect hashes, UTF-8 decoding, chunks, skeletons, and embeddings.
Because the buffer is unsafe, stale process memory can be included in indexed content.

**Recommended direction:** Loop until the requested byte count is filled, use a complete-read API,
or reject unexpected EOF. Do not decode an incompletely filled unsafe buffer.

**Test gap:** No test exercises `readFileSnapshot()` with a short-reading file handle.

### F11 - Transient per-file errors are permanently dropped

**Severity:** Medium

**Evidence:**

- `src/lib/index/batch-processor.ts:262-280` logs a non-`ENOENT` error, but marks the path completed
  whenever the worker pool still reports healthy.
- `src/lib/index/batch-processor.ts:283-289` requeues only paths not marked complete.
- `src/lib/index/batch-processor.ts:321-323` clears retry state for every path in the batch.

**Trigger:** A worker, read, or snapshot operation fails once while the pool as a whole remains
healthy.

**Impact:** The changed file is removed from the pending queue. Existing vectors remain stale until
another filesystem event or later catchup happens to revisit the path.

**Recommended direction:** Mark completion only after success or confirmed deletion. Requeue
transient errors with bounded per-path retries and backoff.

**Test gap:** `tests/project-batch-processor.test.ts` covers abort requeueing but not an isolated
transient failure while the pool remains healthy.

### F12 - Search scopes can escape the selected project

**Severity:** Medium

**Evidence:**

- `src/lib/utils/scope-filter.ts:33-40` returns arbitrary absolute scopes unchanged.
- Relative values are joined and normalized without checking that the result remains under
  `projectRoot`.
- The shared table means a resulting prefix can select another indexed project.

**Trigger:** From project A, use `--in ../project-b`, an absolute project-B path, or an equivalent
scope supplied through an agent-facing surface.

**Impact:** A command presented as project-scoped can return rows from another indexed project.
This is particularly important for MCP and HTTP callers that rely on project selection as a data
boundary.

**Recommended direction:** Resolve and canonicalize every include and exclusion path. Reject any
scope that is not equal to the canonical project root or beneath its slash-terminated prefix,
unless the caller has explicitly entered a cross-project mode.

**Test gap:** `tests/scope-filter.test.ts:49-55` currently asserts acceptance of an absolute path.
It checks an in-project absolute path but has no rejection case for an out-of-project absolute or
`..` path.

### F13 - `--all-projects` means unfiltered shared table

**Severity:** Medium

**Evidence:**

- `src/lib/utils/cross-project.ts:38-40` excludes error-status projects from the metadata list.
- `src/lib/utils/cross-project.ts:84-90` deliberately omits a `project_roots` predicate for
  `--all-projects`.
- The search therefore reads every row in the physical shared table, including rows not represented
  by the filtered registry set.

**Trigger:** Leave partial rows from a failed/error project or orphan rows from stale registry
state, then run a search with `--all-projects`.

**Impact:** Results can include data from error, removed, or otherwise out-of-scope projects. The
display layer may not be able to assign those rows to one of the advertised project roots.

**Recommended direction:** Always build an explicit OR predicate from the canonical roots selected
from the registry. Do not represent "all registered projects" as no filter.

**Test gap:** `tests/cross-project.test.ts:32-39` explicitly asserts that `--all-projects` has no
project-root predicate.

### F14 - A malformed project registry can be silently overwritten

**Severity:** Medium

**Evidence:**

- `src/lib/utils/project-registry.ts:31-37` converts every read or JSON parse failure into an empty
  registry.
- `src/lib/utils/project-registry.ts:65-75` and `:86-90` then save mutations based on that empty
  result.

**Trigger:** `~/.gmax/projects.json` is truncated, malformed, or temporarily unreadable when a
project is registered, updated, or removed.

**Impact:** The next successful mutation replaces the registry with only the new state, silently
dropping all prior registrations.

**Recommended direction:** Distinguish a missing registry from an unreadable or invalid one. Abort
mutations on parse/read failures, preserve the original file, and report a recovery instruction.

**Test gap:** `tests/project-registry.test.ts` does not cover malformed, truncated, or unreadable
registry files.

## Additional Risks for Fix-Plan Triage

These risks were identified during the broader pass but were not promoted into the primary list
above. They should be revalidated and either included or explicitly deferred during fix planning.

### Daemon and process lifecycle

- `src/lib/daemon/daemon.ts:1040-1042` returns immediately from a second concurrent `shutdown()`
  call instead of returning the first shutdown promise. A second signal handler can proceed to
  process exit before the first shutdown finishes.
- `src/commands/watch.ts:137-164` installs signal handlers only after `await daemon.start()`, leaving
  long startup work vulnerable to default signal termination and partial cleanup.
- `src/lib/daemon/daemon.ts:1108-1124` does not await socket-server closure and `VectorDB.close()`
  does not drain ordinary active reads/writes.
- Search, review, repair, warmup, and MLX recovery work are not all tracked by one daemon-wide
  in-flight operation set, so shutdown can race untracked work.
- A streaming add/index request can disconnect while waiting on a project lock before its close
  listener is attached, allowing unwanted work to start later.

### Watcher lifecycle

- `src/lib/daemon/watcher-manager.ts:196-284` creates an untracked recovery `setTimeout`; unwatch
  clears poll timers but not that backoff timer. A delayed callback can resubscribe a removed
  project with a closed processor.
- Full, catchup, and watcher paths also differ on same-size/same-mtime change detection. Explicit
  watcher events can be discarded solely from metadata equality.

### Model-server ownership

- `src/lib/daemon/mlx-server-manager.ts:93-110,209-235` adopts an already healthy service without
  recording ownership, but shutdown and recovery can kill whichever PID owns the port.
- Port-owner discovery is not restricted to a verified listening process or executable identity.
- The standalone `serve` MLX lifecycle has separate detached-process and failure-cleanup logic,
  increasing the chance of orphan behavior diverging from the daemon manager.
- LLM server start/stop is not single-flight, and concurrent start/review/idle-stop paths need a
  dedicated lifecycle serialization review. No local LLM was started to test this.

### Store and index consistency

- LanceDB row writes and LMDB metadata writes are separate operations rather than one transaction.
  Aggregate coherence checks cannot reliably identify isolated per-path divergence.
- Disk-pressure checks block deletion as well as insertion. Under critical pressure, deleted or
  sensitive rows can remain searchable precisely when cleanup is needed.
- Markdown frontmatter is removed from the change hash but is still passed to chunking and
  embeddings (`src/lib/utils/file-utils.ts:32-43`, `src/lib/workers/orchestrator.ts:279-312`). A
  frontmatter-only edit can leave indexed content stale.
- Search converts every `ensureTable()` error into an empty result at
  `src/lib/search/searcher.ts:500-505`, masking corruption and schema failures as "no matches."
- Cache coherence compares all LMDB entries with vector-bearing files even though generated,
  binary, or otherwise rejected files intentionally have metadata but no vectors. A project with
  enough tombstones can repeatedly invalidate a healthy cache.

### Security-sensitive command surfaces

- The generated OpenCode tool accepts arbitrary gmax argv and has no allowlist separating search
  operations from administrative or arbitrary-file-reading commands.
- The post-commit hook generator interpolates the binary and repository paths directly into a Bash
  script inside double quotes. Paths containing command substitution syntax can become stored
  shell injection when the hook runs.
- Git refs supplied by agent-facing surfaces should reject leading `-` values or use
  `--end-of-options`; passing refs before an option terminator permits Git option injection.
- MCP path and project scoping needs a per-tool containment audit. Search, symbol listing, graph
  tracing, and skeleton operations do not all apply the same default project boundary.

## Cross-Cutting Root Causes

The findings should not be fixed as fourteen unrelated patches. The next planning pass should
group them around these shared causes:

1. **No single containment primitive.** HTTP, CLI, MCP, walker, watcher, and symlink paths each
   resolve scope differently.
2. **No daemon-wide operation barrier.** Per-project locks are insufficient for global storage or
   model-generation changes.
3. **Lifecycle ownership is implicit.** Workers and model servers do not always distinguish
   running, cancelling, adopted, owned, stopping, and stopped states.
4. **Ingestion policy is duplicated.** Walk, catchup, and live-event code independently decide
   what is indexable and ignored.
5. **Errors collapse into valid empty state.** Registry parsing, table opening, directory walks,
   file processing, and drop operations suppress failures that should block mutation or cleanup.
6. **Global and per-project state are mixed.** Preferences, model identity, and shared-table schema
   are represented in overlapping configuration records.

## Fix-Plan Questions

The next pass should explicitly answer these before implementation:

1. Is `gmax serve` intended to be loopback-only, or should remote serving have an authenticated
   opt-in mode?
2. Are `--in` and equivalent MCP paths strictly subpaths, or is arbitrary absolute path access an
   intentional compatibility requirement?
3. Should repository symlinks be rejected entirely, or allowed only when the canonical target is
   inside the project?
4. Should `repair --rebuild` restart the daemon, recreate resources in-process, or build a new table
   generation and atomically swap it?
5. Should cancellation of a running native worker task kill the worker, or should callers receive
   early cancellation while the pool waits for terminal child cleanup?
6. Where should per-project embedding identity live once global preferences and physical table
   schema are separated?
7. Which cleanup operations must remain available under critical disk pressure, and what reserved
   headroom is needed to make them reliable?

## Suggested Planning Order

This is a triage order only, not an approved implementation plan:

1. Contain the remotely reachable `serve` surface and all project/path escape routes.
2. Fix worker abort accounting and MLX process cleanup to protect machine stability.
3. Put rebuild behind a daemon-wide barrier and make model-resource generations explicit.
4. Unify ingestion and containment policy across walk, catchup, watcher, and symlink handling.
5. Make scan and per-file errors fail safe rather than delete or silently complete.
6. Separate global preferences, per-project identity, and physical store schema state.
7. Harden registry/config persistence and remaining error-reporting paths.

## Acceptance Baseline for the Future Plan

Any eventual fix plan should preserve the current passing baseline and add focused regressions for:

- loopback-only serving, path containment, and bounded request limits
- live daemon tier changes and physical schema verification
- rebuild concurrent with watchers, searches, and index requests
- abort followed by heartbeat and queued worker work
- ignore parity across initial and live indexing
- permission failures and incomplete scan cleanup suppression
- inside-root and outside-root symlink behavior
- MLX successful start, timeout, shutdown, and ownership handling
- preference preservation after full indexing
- short file reads
- transient per-file retry behavior
- out-of-project include/exclude rejection
- explicit all-project root predicates
- corrupt registry mutation refusal
