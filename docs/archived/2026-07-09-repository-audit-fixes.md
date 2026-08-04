---
type: plan
status: archived
created: 2026-07-09
updated: 2026-08-04T11:07:44Z
surfaces:
  - daemon
  - workers
  - index
  - store
  - search
  - serve
  - mcp
  - config
  - security
modules:
  - src/commands/serve.ts
  - src/commands/mcp.ts
  - src/lib/daemon/daemon.ts
  - src/lib/daemon/ipc-handler.ts
  - src/lib/daemon/mlx-server-manager.ts
  - src/lib/daemon/watcher-manager.ts
  - src/lib/index/batch-processor.ts
  - src/lib/index/index-config.ts
  - src/lib/index/syncer.ts
  - src/lib/index/walker.ts
  - src/lib/search/searcher.ts
  - src/lib/store/meta-cache.ts
  - src/lib/store/store-lease.ts
  - src/lib/store/vector-db.ts
  - src/lib/utils/daemon-client.ts
  - src/lib/utils/file-utils.ts
  - src/lib/utils/keyed-mutex.ts
  - src/lib/utils/operation-coordinator.ts
  - src/lib/utils/project-registry.ts
  - src/lib/utils/scope-filter.ts
  - src/lib/workers/pool.ts
domain: repository audit remediation (containment, lifecycle, and index integrity)
audience: internal
summary: Implementation plan and closeout record for the 2026-07-09 repository audit findings.
related_plans:
  - ../plans/embedding-reembed-atomic-cutover.md
related_docs:
  - ../2026-07-09-repository-audit.md
  - ../embedding-layout-decision.md
  - ../known-limitations.md
  - stability-cycle-v0.26.2.md
  - 2026-06-28-repo-audit-hardening.md
current_state: >
  All fourteen audit findings and Phases 1 through 8 are implemented and released through
  v0.26.2, with follow-up stability fixes through v0.26.5. Current HEAD passes 124 test files /
  1035 tests, production and test-source typechecks, and Biome across 308 files.
next_step: >
  None. Audit remediation is closed. Atomic re-embedding remains a separate,
  model-and-layout-gated plan.
---

# Repository Audit Fix Plan

## Goal

Resolve the confirmed 2026-07-09 audit findings without turning them into unrelated local patches
or introducing a second migration architecture. The target shape is:

1. one path-containment primitive for every user, agent, HTTP, and ingestion path
2. one project file policy for full scans, catchup scans, and watcher events
3. one daemon-owned writer/model runtime for indexing and search
4. explicit shared versus exclusive daemon operations
5. immutable embedding-resource generations during a model/config generation
6. fail-safe cleanup: incomplete observation never deletes known-good data
7. separate global preferences, per-project built identity, and physical table schema

Every phase starts with a failing regression test, keeps the current full suite green, and has a
bounded rollback point. No phase may start a summarizer, llama-server, or other large local model.

## Finding Map

| Finding | Summary | Primary phase |
|---|---|---|
| F1 | `serve` exposes source and accepts escaping/unbounded requests | Phase 1 |
| F2 | Tier rebuild reuses stale DB/workers/model resources | Phase 8 |
| F3 | Rebuild races active writers and suppresses drop failures | Phases 6 and 8 |
| F4 | Aborted worker heartbeat releases a still-busy worker | Phase 2 |
| F5 | Watcher bypasses full-scan ignore policy | Phase 3 |
| F6 | Incomplete scans purge valid indexed data | Phase 3 |
| F7 | Symlinks can ingest files outside the project | Phase 3 |
| F8 | MLX startup and timeout leak descriptors/processes | Phase 7 |
| F9 | Full indexing deletes global preferences | Phases 2 and 5 |
| F10 | Short reads can expose uninitialized buffer bytes | Phase 2 |
| F11 | Transient per-file errors are dropped | Phase 4 |
| F12 | Project scopes can escape the selected project | Phase 1 |
| F13 | `--all-projects` searches the unfiltered physical table | Phase 1 |
| F14 | Invalid project registry can be overwritten as empty | Phase 2 |

## Recenter - 2026-07-11

The verified completed baseline is now Phases 1-3, Phase 4A, Phase 5A/B, and Phases 6-8. The current
gate passes with 114 test files / 942 tests, production and test-source typechecks, Biome across 296
files, direct build, syntax checks, and `git diff --check`.

Phase 6 foundation now implemented:

1. `OperationCoordinator` provides open, exclusive-pending, exclusive, closing, and closed admission
   states; shared overlap, immediate exclusive intent, quiescence-before-drain, one-exclusive
   admission, cancellation, and close are covered by focused tests.
2. `KeyedMutex` replaces promise-tail serialization with cancellable queued waiters and a drainable
   close operation.
3. `StoreLease` provides filesystem shared/exclusive ownership with PID, process-start identity,
   nonce, role, stale-owner checks, exclusive intent, bounded timeout, and blocker reporting.
4. `VectorDB` automatically acquires a shared store lease before opening LanceDB and releases it only
   after the connection closes; an explicit supplied lease supports the later exclusive upgrade path.
5. Focused gates pass: coordinator/mutex 7 tests, store lease 5 tests, and VectorDB/store integration
   17 tests.

Phase 6 daemon integration completed:

- project operations acquire the keyed mutex before shared admission and pass the admitted signal
  through indexing; internal watcher handoffs do not reacquire either primitive
- search, watch transitions, pending indexing, live batches, catchup, maintenance, warmup, stats, and
  LLM/review requests are visible to coordinator shutdown
- IPC returns stable `DAEMON_BUSY` and `DAEMON_CLOSING` codes; direct search fallback remains limited
  to genuine socket absence/refusal
- `WatcherManager.quiesceAll()` and `resumeAll()` provide an exclusive-operation handoff surface
- signal handlers are installed before daemon startup, startup checks shutdown after awaited phases,
  and shutdown returns one promise while draining IPC, watchers, coordinator, mutex, workers, models,
  and stores in order
- lifecycle tests cover queued disconnect, busy/closing responses, watcher quiescence, single-flight
  shutdown identity, and shutdown drain ordering

Phase 4B cache integrity, Phase 5B persistent identity stamping, Phase 7 MLX ownership cleanup, and
Phase 8 guarded resource replacement are complete after this foundation.

Phase 5B identity cutover completed:

- `initialSync()` resolves one generation before work, uses the corresponding vector dimension and
  worker runtime, returns that generation and the registry start-state expectation, and no longer
  writes `IndexConfig`
- worker replacement processes receive a validated serialized generation; Granite, MLX, ColBERT,
  and ColBERT skiplist selection consume its exact model IDs and MLX validates model/dimension
- daemon add/index/pending paths own their successful stamp; direct add/index/watch/search/skeleton
  fallbacks use the same returned-generation helper and authoritative row counts
- `stampProjectFullSync()` performs a locked compare-and-set on fingerprint/rebuild identity and
  preserves a competing registry update on conflict
- config/list/status/serve stats/MCP report configured versus built identity and current, legacy,
  stale, or unbuilt state; CLI, daemon/serve, and MCP search reject stale exact generations

## Remaining Work - Decision Scope

The audit critical path is complete. Remaining items are independent evidence/product-gated work.

| Work item | Size | Required for audit closure | Dependencies | Destructive/data migration |
|---|---:|---:|---|---|
| Phase 5B persistent identity cutover | Complete | Yes | Phase 5A, Phase 6 complete | No eager migration; successful full sync stamps identity |
| Phase 7 MLX ownership and cleanup | Complete | Yes | Phase 5A identity available; Phase 6 shutdown complete | No store mutation; process-lifecycle behavior changes |
| Phase 8 guarded whole-corpus rebuild | Complete | Yes for F2/F3 completion | Phase 5B and Phase 7 | Yes; explicit CLI operation only |
| Phase 4B cache metadata migration | Complete | No, independent integrity slice | Focused coherence and disk-pressure regressions complete | Lazy LMDB metadata migration shipped |
| Background atomic re-embed/cutover | XL | No, separate product plan | Better model selected and table layout chosen | New staging/cutover architecture |

### Recommended critical path

1. **Phase 7 - process ownership (complete).** MLX ensure/stop is single-flight, health validates
   model identity, adopted services are never killed, owned process groups receive bounded
   TERM-to-KILL cleanup, and process behavior is covered with mocks.
2. **Phase 8 - guarded rebuild (complete).** Immutable daemon resource generations, exclusive store
   mutation, durable registry transitions, capability negotiation, and post-drop recovery semantics
   are implemented and mock/fake-resource verified.

### Phase 5B bounded surface

Expected production touch points:

- `src/lib/index/embedding-generation.ts`, `src/lib/index/index-config.ts`, and
  `src/lib/index/syncer.ts`: resolve one generation before work, return it with sync results, and stop
  writing preference/config bytes from indexing
- `src/lib/utils/project-registry.ts`: add one locked batch/compare-and-set mutation for exact built
  identity and future `rebuildId` checks
- daemon add/index/pending paths plus direct CLI add/index/watch/search-auto-sync/doctor paths: stamp
  only after a successful non-degraded full sync, using the returned generation rather than rereading
  global config
- worker construction, MLX expected-model checks, and ColBERT construction: consume the same frozen
  generation; runtime CPU/GPU fallback must not alter semantic identity
- config/list/status/serve/MCP output: display desired global identity separately from project built
  identity and report stale/legacy state without eagerly rewriting it

Exit checkpoint: all successful full-sync paths stamp the same exact identity; failed/degraded syncs
preserve the previous stamp; model/dimension mismatch still returns an actionable unavailable-rebuild
error with no deletion.

### Phase 7 bounded surface

Expected production touch points are `src/lib/daemon/mlx-server-manager.ts`, daemon status/shutdown,
and `src/lib/workers/embeddings/mlx-client.ts`. No real model process is needed or permitted for the
test gate. The main design decision is whether a process-group handle is sufficient; add a persisted
ownership sidecar only if tests prove crash recovery cannot validate ownership without it.

Exit checkpoint: an adopted matching service is never killed, an unhealthy/wrong-model port never
causes arbitrary process termination, owned startup timeout is fully reaped, and concurrent lifecycle
calls are single-flight.

### Phase 8 go/no-go boundary

Phase 8 is a safe, explicit **whole-corpus destructive repair** for the existing shared-table layout.
It is not the background zero-downtime migration in `embedding-reembed-atomic-cutover.md`. Phase 8 can
be implemented and tested with existing model tiers and fake resources; it does not require choosing
a new embedding model or a new table layout. It should still begin only after an explicit approval
because it re-enables table drop and materially expands recovery-state complexity.

### Independent deferral

- **Atomic re-embed:** retain its double gate. A chosen better model and migration granularity/table
  layout decision are still absent. Phase 6 leasing reduces prerequisites but does not justify
  speculative staging, a second MLX instance, or a new `reembed-manager`.

### Decision options

1. **Run the v0.26.2 stability cycle:** observe the completed integrity work before selecting another
   feature target.
2. **Keep atomic re-embed gated:** the required audit remediation is complete; retain the independent
   model-and-layout deferral.

## Decisions

These decisions are supported by current README/help behavior and avoid speculative compatibility
layers.

### Network serving

- `gmax serve` binds `127.0.0.1` only.
- This remediation does not add remote serving or authentication. A future authenticated remote
  mode requires a separate product decision and threat model.
- `serve` becomes a thin HTTP-to-daemon adapter. It no longer opens LanceDB/LMDB, starts workers or
  MLX, performs indexing, or owns a watcher.
- The daemon remains the only normal long-lived writer/model owner.
- `--cpu` is deprecated for `serve`; runtime embedding mode is configured through
  `gmax config --embed-mode cpu`. During one release, accepting `--cpu` prints that actionable
  message and exits before startup rather than silently ignoring the flag.

This is smaller and safer than building a second ownership-aware `ServeRuntime`. It also closes the
cross-process writer race between standalone serving and the daemon.

### Project scopes

- `--in`, `--exclude`, positional search paths, HTTP `path`, and MCP file/path arguments are paths
  inside the selected project.
- Absolute paths remain accepted when they are inside the selected project.
- `--root`, named projects, `--projects`, and `--all-projects` are the only project-selection
  mechanisms.
- Explicit cross-project selection always produces an explicit inclusion predicate. An empty
  selected root set fails closed.

### Symlinks

- Reject symlinked files and directories below the project root, even when the target remains
  inside the project.
- A project root itself may be reached through a symlink; capture its canonical root once and use
  the lexical registered root for stored paths.
- Full sync already effectively skips file symlinks, so this makes current behavior consistent
  rather than introducing new symlink support.

### Rebuild

- Reserve `repair --rebuild` for the eventual destructive whole-corpus operation, but keep it
  fail-closed before persistent-state access until its prerequisites land.
- Make it available only after a daemon-wide exclusive barrier, interprocess store lease, and
  in-process resource-generation replacement exist.
- Do not implement second-table background re-embedding or dual-vector columns here. That remains
  gated in `embedding-reembed-atomic-cutover.md`.
- Before the destructive drop, client disconnect may cancel. After a successful drop, loss of the
  progress client does not abandon the rebuild halfway through; daemon shutdown remains
  authoritative.

### Worker cancellation

- Cancelled callers receive `AbortError` immediately.
- A running child task continues to terminal result, timeout, or child exit while its worker remains
  busy.
- Heartbeats are never terminal events.
- The child serializes task handlers as defense in depth.

### Configuration identity

- `~/.gmax/config.json` stores current global preferences only.
- `ProjectEntry` stores each project's last successfully built embedding identity.
- The physical LanceDB schema is inspected from the table and is never inferred from either config
  record.

## Non-Goals

- authenticated remote HTTP serving
- background or atomic dual-generation embedding migration
- transactional journaling across LanceDB and LMDB
- automatic salvage of a corrupt registry
- indexing repository symlinks
- persistent per-file retry queues across daemon restarts
- physical compaction under critical disk pressure
- broad ranking or graph changes
- starting a local LLM or summarizer during implementation or tests

## Global Invariants

The final implementation must maintain all of these:

1. No code-returning surface reads outside its selected registered project unless explicit
   cross-project mode is active.
2. No unfiltered query is used to represent "all registered projects."
3. No scan deletes data beneath a directory it failed to observe.
4. No transient file failure mutates known-good vectors or metadata.
5. One worker process executes at most one native model task at a time.
6. A worker remains busy until a terminal child event or process exit.
7. No daemon or external-process store user overlaps a table drop.
8. No old-generation `Searcher`, processor, DB, worker, or MLX handle survives generation rotation.
9. Only a verified owned MLX process group may be terminated.
10. Project built identity is stamped only after successful indexing and physical schema
    verification.
11. Shutdown is single-flight and drains or cancels every daemon-started operation before closing
    stores.
12. Cleanup remains possible under disk pressure even when growth operations are suspended.

## Phase 0 - Regression Harness

**Purpose:** Make the later concurrency and persistence changes deterministic before production
behavior changes.

### Work

1. Add `tsconfig.tests.json` that extends the production config, overrides `rootDir` to `.`, and
   typechecks `tests/**/*.ts` without emitting. Fix only test typing exposed by this gate; do not
   change production semantics.
2. Add a `test:typecheck` script.
3. Add small local test helpers only after repeated use:
   - deferred promise
   - fake socket
   - fake child process
4. Preserve `tests/setup.ts` as the default worker/model mock. Suites that unmock the real pool must
   mock `child_process` before constructing it.
5. Add a CI check for test types after production typecheck.

### Regression gate

```bash
pnpm run typecheck
pnpm run test:typecheck
pnpm run format:check
pnpm run test
pnpm run build
```

### Exit criteria

- Existing 83 files / 686 tests remain green.
- Tests typecheck independently of production source.
- No test launches an embedding or LLM process.

This phase is non-blocking for Phase 1 containment. If existing test typing needs broad cleanup,
land the containment regressions under Vitest first and finish test-typecheck before Phase 2.

## Phase 1 - Project and HTTP Containment

**Status:** Complete in the working tree on 2026-07-09. Full gate: 87 test files / 720 tests,
production typecheck and build, changed-file Biome, and git diff checks.

**Findings:** F1, F12, F13; related MCP scope risks.

### 1. Shared containment primitive

Add `src/lib/utils/path-containment.ts` with a small API:

```ts
class PathContainmentError extends Error {}

function isPathWithin(root: string, candidate: string): boolean;

function resolveContainedPath(
  root: string,
  input: string,
  options?: { allowRoot?: boolean; verifyExistingTarget?: boolean },
): string;
```

Rules:

- use `path.resolve()` and `path.relative()`, never raw prefix matching
- reject `..`, absolute outside paths, and sibling-prefix collisions
- allow absolute in-project paths
- when an existing target will be read, verify its canonical target under the canonical root
- preserve lexical registered roots for indexed path prefixes
- use `PathContainmentError` for stable CLI, HTTP, and MCP errors

Add `tests/path-containment.test.ts` for relative paths, absolute in-root paths, root equality,
nonexistent descendants, sibling prefixes, outside absolute paths, `..`, and symlink traversal.

### 2. CLI scopes

Change `src/lib/utils/scope-filter.ts` to use `resolveContainedPath()` for every include and exclude.
Preserve single-include collapse, multi-include OR behavior, and valid absolute in-project paths.

Change `src/commands/search.ts` so positional path, `--in`, and `--exclude` use the selected project
root. In explicit cross-project mode, reject single-project path options instead of warning that
they were ignored.

All existing command users of `resolveScope()` gain the same boundary. Review direct path lookups
in `related`, `context`, `skeleton`, and symbol commands and apply the same primitive before any
filesystem read.

Update `tests/scope-filter.test.ts` and command tests with outside absolute, `..`, sibling-prefix,
and escaping-exclude cases.

### 3. Explicit cross-project predicates

Change `src/lib/utils/cross-project.ts`:

- always produce the exact included root list in active cross-project mode
- remove error projects before constructing the list
- apply exclusions before constructing the list
- represent an empty list explicitly

Change `SearchFilter` and `buildWhereClause()` in `src/lib/store/types.ts` and
`src/lib/search/searcher.ts`:

- accept `projectRoots: string[]`
- build one OR group from exact slash-terminated roots
- emit a false predicate for an explicit empty array
- retain legacy CSV fields for one daemon/CLI transition release

Add a new `search-v2` IPC command with the array filter shape. Old daemons return unknown-command
without executing it, so capability negotiation cannot race a daemon replacement into an
unfiltered legacy search. `ping` may advertise the capability for diagnostics, but safety comes
from the command name. New clients use `search-v2` for explicit cross-project search and require a
daemon restart if it is unsupported. Legacy `search` remains only for legacy non-empty CSV scopes;
the new daemon gives v2 arrays one unambiguous interpretation and never evaluates both forms.

Direct search fallback must distinguish daemon unavailability from daemon `busy`, `rebuilding`,
`protocol_mismatch`, and scope errors. Those structured responses never fall back to an uncoordinated
direct store query.

Reverse the unsafe expectation in `tests/cross-project.test.ts` and extend
`tests/searcher-filters.test.ts` for orphan, error, empty, and special-character roots. Add a daemon
replacement race test proving an old daemon can only reject `search-v2`, never execute it unscoped.

### 4. Make `serve` a daemon adapter

Refactor `src/commands/serve.ts`:

- retain command parsing, background process management, status, stop, idle timeout, server
  registry, and HTTP lifecycle
- delete direct MLX startup, setup/grammar work, initial sync, VectorDB, MetaCache, Searcher, and
  watcher ownership
- call `ensureDaemonRunning()` and invoke one streaming daemon-owned `ensure-project` operation
  before listening
- `ensure-project` resolves the exact root, creates pending registration when needed, indexes or
  recovers pending/error state, stamps the current validated tier/dimension identity, and establishes
  the watcher under one top-level operation context; Phase 5 replaces that provisional identity
  snapshot with the complete immutable fingerprint
- for an already indexed project it only verifies generation compatibility and establishes the
  watcher
- never split pending registration and successful identity stamping between `serve` and daemon
- validate all requests before IPC
- bind `server.listen(port, "127.0.0.1")`, including retry binds
- accept only JSON objects
- require a non-empty string query
- accept integer limits from 1 through 50; default 10; return 400 otherwise
- resolve optional `path` through `resolveContainedPath()`
- forward search through a cancellable daemon client call
- use an explicit search timeout at least as long as the current 60-second daemon search allowance
- map daemon failures to stable HTTP errors without exposing internal stack details
- implement `/stats` through a narrow daemon `project-stats` IPC command
- make shutdown single-flight, await HTTP close, abort active IPC requests, clear idle timers, and
  unregister once

Change both `sendDaemonCommand()` and `sendStreamingCommand()` in
`src/lib/utils/daemon-client.ts` to accept an optional abort signal and destroy their socket on
abort. The daemon binds socket close before any project mutex/admission wait.

Revalidate exact registered project root, contained `pathPrefix`, finite bounded limit, and explicit
cross-project roots in `src/lib/daemon/ipc-handler.ts`; the HTTP adapter is not the protocol trust
boundary. Map `busy`/`rebuilding` to HTTP 503 without local fallback.

Extract only the HTTP handler/listen helper needed for tests; do not create another resource-owning
runtime class.

Keep `ServerInfo` wire-compatible. Add an optional host field if useful for display, defaulting old
records to loopback. Never persist credentials because remote mode is out of scope.

Add `tests/serve-http-security.test.ts` with fake daemon IPC. Cover loopback binding, retry host,
malformed JSON, oversized body, limits, path escapes, aborted clients, daemon failures, and
single-flight shutdown. Cover `ensure-project` for indexed, unregistered, pending, and error states,
including cancellation while waiting. No test invokes the command action or starts a model.

### 5. MCP containment

Use shared project selection and containment helpers in `src/commands/mcp.ts`:

- code-returning tools default to the registered current project
- a `root` override must select an exact registered root or unique registered name
- arbitrary absolute roots are rejected
- file/path targets must remain inside the selected project
- explicit cross-project search uses the same exact root list as CLI search
- unknown-only project selections fail closed
- `trace_calls`, `list_symbols`, related-file secondary queries, and similar-symbol source lookups
  always include the selected root predicate
- validate DB-returned paths before any filesystem read
- keep `list_projects` and global index metadata intentionally global

Add `tests/mcp-scope.test.ts` with mocked DB/graph/filesystem dependencies. Update MCP schema text to
describe registered project roots and in-project paths.

### Phase gate

- Existing in-project relative and absolute scopes remain valid.
- Every outside-project negative case fails before query or filesystem access.
- `serve` has no import or construction path to MLX, WorkerPool, VectorDB, MetaCache, or watcher.
- Full Phase 0 gate passes.

## Phase 2 - Leaf Safety and Worker Accounting

**Status:** Complete in the working tree on 2026-07-09. Full gate: 90 test files / 747 tests,
production typecheck and build, changed-file Biome, and git diff checks.

**Findings:** F4, F9 immediate preservation, F10, F14; additional search error masking.

This phase handles changes that are small, independently testable, and prerequisites for later
authority and lifecycle work. It follows the urgent Phase 1 containment slice.

### 1. Worker cancellation accounting

Change `src/lib/workers/pool.ts`:

- Remove the `abortedTasks` fast-cleanup path.
- Distinguish caller settlement from worker lifecycle settlement.
- Queued abort removes the task and rejects immediately.
- Running abort rejects the caller but retains task assignment, timeout, and worker busy state.
- Heartbeats for caller-aborted tasks continue to reset only the no-progress timeout.
- Terminal result/error performs normal cleanup; safe promise wrappers prevent double settlement.
- Store the abort listener on `PendingTask` and remove it from `completeTask()`.
- Snapshot worker embedding environment in the `WorkerPool` constructor rather than rereading config
  for every replacement worker. Full resource-generation replacement comes in Phase 8.

Change `src/lib/workers/process-child.ts`:

- Route messages through a promise chain so task handlers cannot overlap even if parent accounting
  regresses.

Change `src/lib/index/syncer.ts`:

- Pass the active abort signal into `pool.processFile()` so an in-flight caller can stop waiting.

Tests in `tests/worker-pool-resilience.test.ts`:

- abort task A, emit A heartbeat, queue B, and prove B is not sent
- emit A terminal result and prove B is then sent
- prove A's caller received `AbortError`
- destroy the pool while caller-aborted A is still running and prove child termination
- prove a pool's worker environment does not change when config changes

Add a focused process-child serialization test with mocked worker functions.

### 2. Complete file snapshots

Change `readFileSnapshot()` in `src/lib/utils/file-utils.ts`:

- loop until `before.size` bytes have been read
- advance offset by `bytesRead`
- throw on zero-byte read before completion
- preserve the before/after stat consistency check
- always close the handle

Tests in `tests/file-utils.test.ts` cover multiple short reads, premature EOF, file mutation, and
handle closure on every path.

### 3. Strict registry reads

Change `src/lib/utils/project-registry.ts`:

- return an empty registry only for `ENOENT`
- throw a descriptive error for unreadable bytes, invalid JSON, or non-array JSON
- validate the minimum entry shape before returning it
- abort register/remove mutations before writing when load fails
- preserve atomic temp-file rename

Tests in `tests/project-registry.test.ts` prove malformed, truncated, non-array, and mocked `EACCES`
inputs fail without changing original bytes.

### 4. Preference-preserving global config writes

Change `writeGlobalConfig()` and `writeSetupConfig()` in
`src/lib/index/index-config.ts` to merge known preference fields with the current valid config. No
caller may reconstruct global config while dropping `queryLog` or `llmEnabled`.

This is the immediate F9 containment. Removing index identity from this file happens in Phase 5.

Tests extend `tests/config-command.test.ts` for every combination of model tier, embed mode,
`queryLog`, and `llmEnabled`.

### 5. Propagate store failures from search

Remove the broad catch around `ensureTable()` in `src/lib/search/searcher.ts`. A genuinely empty
store is handled inside `ensureTable()`; corruption, schema, permission, and connection errors must
reach the caller as `search_failed` rather than "no matches."

Add `tests/searcher-table-errors.test.ts`.

### Phase gate

- Focused tests above pass.
- Full Phase 0 gate passes.
- No output format or successful search behavior changes.

## Phase 3 - Unified File Policy

**Status:** Complete in the working tree on 2026-07-10. Full sync, daemon catchup, standalone
watching, live batches, and worker reads share fail-safe containment and deletion authority.

**Findings:** F5 and F7.

### ProjectFilePolicy

Add `src/lib/index/file-policy.ts`:

```ts
class ProjectFilePolicy {
  constructor(projectRoot: string);
  isPolicyFile(absPath: string): boolean;
  invalidateIgnoreCache(): void;
  classifyFile(absPath: string): Promise<
    | { status: "indexable"; stat: Stats }
    | { status: "excluded"; reason: string }
    | { status: "missing" }
    | { status: "error"; error: unknown; protectedPath: string }
  >;
  classifyDirectory(absPath: string): Promise<
    | { status: "traverse" }
    | { status: "excluded"; reason: string }
    | { status: "missing" }
    | { status: "error"; error: unknown; protectedPath: string }
  >;
}
```

The policy owns:

- lexical and canonical project containment
- reject-all-symlinks behavior, including symlinked ancestors
- default ignore patterns
- root and nested `.gitignore` and `.gmaxignore` filters
- extension/basename checks
- regular-file, non-empty, and maximum-size checks
- explicit incomplete/error results for unreadable paths and ignore files

Generated-content banner detection remains in the worker because it requires content bytes.

For symlinked ancestors, compare the candidate realpath with the canonical project root plus the
candidate's lexical relative path. A mismatch means some descendant component traversed a symlink.
Unlink events cannot be canonicalized and are allowed only when lexically contained.

Store or derive each registration's canonical root and reject a second registration for the same
canonical directory while retaining the original lexical root for indexed path compatibility. The
realpath-before-read check is best-effort against concurrent hostile path replacement; where Node
and the platform permit it, open without following symlinks and verify the opened file before read.
Document the remaining TOCTOU limit rather than claiming a sandbox guarantee.

Only deterministic policy exclusion and confirmed `ENOENT` may remove cached rows. `EACCES`,
`EIO`, unreadable ignore files, and incomplete ancestor state return `error` and protect the affected
path or subtree.

### Wire every ingestion path

Change `src/lib/index/walker.ts`:

- receive a shared policy
- do not yield or traverse symlinks
- preserve current additive nested-ignore semantics
- report root and nested traversal errors instead of silently returning
- stop and protect a subtree when its ignore policy cannot be read authoritatively

Change `src/lib/index/syncer.ts`:

- create one policy per sync
- replace duplicate `lstat`/extension/size logic with policy classification
- remove symlink realpath deduplication, which is unnecessary under reject-all policy
- remove eager project-prefix deletion from ordinary `--reset`; reset forces every authoritative
  observed file through replacement and deletes stale paths only after protected reconciliation

Change `src/lib/index/batch-processor.ts`:

- receive the project's shared policy
- reject outside-root events before queueing, including unlink events
- classify change events through policy
- treat a newly excluded cached path as a confirmed delete
- recognize ignore policy-file changes before extension filtering
- preserve old vectors/meta for every policy `error` result

Change `src/lib/daemon/watcher-manager.ts` and `src/lib/index/watcher.ts`:

- maintain one policy per watched root
- keep Parcel watcher ignores to immutable structural directories only
- do not ignore `.gitignore` or `.gmaxignore` events
- invalidate policy caches and run one single-flight catchup after policy changes
- reconciliation queues newly included files and removes newly excluded cached paths

Add a final read-side containment check in `WorkerOrchestrator.processFile()`. Pass `projectRoot` in
`ProcessFileInput`; reject outside-root or symlink-traversing input immediately before snapshot read.

### Complete-scan cleanup

Implement F6 in this phase, before policy reconciliation can delete rows:

- collect incomplete directory roots from walker and policy errors
- protect exact per-file stat/read failures
- never delete a cached path equal to or beneath an incomplete directory
- suppress all stale cleanup after a root scan failure
- commit successful work outside failed subtrees
- report the overall scan as degraded after safe reconciliation

`--reset` must follow the same completeness rule as incremental/full sync. An unreadable root or
subtree retains old vectors there; reset never means "delete first, discover whether source is
readable later."

Add watcher status `degraded` plus `lastError`; do not set `ProjectEntry.status = "error"` because
error projects are skipped at daemon startup.

### Tests

Add `tests/file-policy.test.ts` and `tests/symlink-containment.test.ts`. Replace shallow constant
assertions in `tests/watcher-ignore.test.ts` with a table run through full-scan, catchup, and live
event policy.

Cover sensitive files, generated names, fixtures, nested ignore files, policy invalidation,
ordinary source, internal symlink files, external symlink files, symlink directories, broken links,
outside events, unreadable ignore files/directories, root scan failure, protected-subtree cleanup,
ordinary `--reset` against an unreadable subtree, and cached-row removal after a deterministic
policy change.

### Phase gate

- One table of paths produces the same classification in every ingestion path.
- Existing non-symlink source behavior is unchanged.
- Root scan failure performs zero stale deletes; nested failure protects only its subtree.
- The first reconciliation intentionally removes previously leaked ignored/sensitive/symlink rows.
- Full Phase 0 gate passes.

## Phase 4 - Fail-Safe Scan and Cache Integrity

**Finding:** F11; additional frontmatter, disk-pressure, and coherence risks.

**Status:** Complete and released. Phase 4A shipped bounded transient retries. Phase 4B shipped
migration-aware exact hashing and cache/vector coherence in v0.26.0, the policy-orphan loop fix in
v0.26.1, and deletion-only critical-pressure behavior in v0.26.2.

Phase 4A's verified gate is 98 test files / 804 tests plus production/test-source typechecks, Biome,
build, and diff checks. Terminal failures remain visible in daemon and standalone watcher health;
later material events can revisit them without duplicate events resetting the retry budget.

The phase landed as separate bounded slices. Phase 4A remained independent of cache schema work;
Phase 4B added focused regressions before each persisted-metadata and disk-pressure behavior change.

### 4A. Bounded per-file retries

Change `ProjectBatchProcessor.processBatch()`:

- mark completion only after success or confirmed `ENOENT`
- retain known-good vectors and metadata after transient failure
- requeue failed paths with per-path exponential backoff capped at 30 seconds
- use the existing retry map with a five-attempt cap
- preserve a newer pending event over an older failed event
- clear retry state only for terminal paths
- do not consume retry budget for disk pressure, shutdown cancellation, or store-wide corruption

At the cap, log and leave existing state untouched. A later event or restart catchup revisits it.

### 4B. Exact markdown hashing

Change `computeContentHash()` to hash the exact bytes passed to chunking and embedding. Keep
`stripMarkdownFrontmatter()` only if another explicit consumer needs it; it must no longer define
index cache identity.

Add optional `hashVersion` to `MetaEntry`. Markdown entries without the current version are not
metadata-only cache hits and are reprocessed once. This repairs frontmatter-only edits previously
missed without forcing all non-Markdown files through workers.

### 4B. Explicit vector/tombstone metadata

Add optional `hasVectors` to `MetaEntry`:

- `true` when a result inserted vectors
- `false` for a deliberate metadata-only tombstone

Replace the aggregate 80 percent coherence heuristic with exact path reconciliation:

- vector expected and present: healthy
- vector expected but absent: remove metadata and reprocess
- tombstone and no vector: healthy
- tombstone with vector: reprocess to remove/replace orphan data
- legacy with vector: lazily stamp vector-bearing
- legacy without vector: reprocess and classify

Stale cleanup uses the union of metadata paths and physical vector paths.

### 4B. Deletions under disk pressure

Keep the critical-space gate on inserts and growth operations. Remove it from logical exact-path and
project-prefix deletion methods. Under critical pressure, batch processing drains unlink events and
leaves change/add events queued with environmental backoff. Do not compact until pressure improves.

If LanceDB itself reports `ENOSPC` during deletion, do not mutate LMDB; requeue the deletion.

### Tests

- extend `tests/project-batch-processor.test.ts`
- extend `tests/watcher-batch.test.ts`
- extend `tests/file-utils.test.ts`
- add `tests/cache-coherence.test.ts`
- add disk-pressure delete tests against fake and temporary stores

### Phase gate

- Transient file failure never changes old vectors/meta.
- Phase 4A may ship once retry regressions and the full gate pass.
- Markdown migration is one-time and exact-byte hashes stabilize.
- Healthy tombstones do not invalidate the project cache.
- Full Phase 0 gate passes.

## Phase 5 - Separate Preferences and Built Identity

**Finding:** Complete F9 and prepare F2/F3 remediation.

### 5A. Immutable generation contract - complete

**Status:** Complete in the working tree on 2026-07-10. The resolver is pure, returns a frozen
canonical identity, rejects unknown tiers, width contradictions, malformed IDs, and incoherent exact
registry fields, and locks fingerprint serialization with a golden v1 digest. No record is stamped or
migrated. Full gate: 99 test files / 826 tests plus production/test-source typechecks and Biome.

Land only the pure contract and backward-compatible data shape first:

- validated `EmbeddingGenerationConfig` resolution from the authoritative tier
- deterministic fingerprint over tier, dimension, ONNX, MLX, and ColBERT IDs
- rejection of persisted tier/dimension contradictions
- optional exact built-identity fields in `ProjectEntry`
- legacy records remain readable and derive identity without being rewritten

Do not change persistent stamping in 5A. This keeps the slice independently testable and avoids
creating another out-of-band registry race.

#### 5A data shape

Keep `GlobalConfig` preferences-only:

```ts
interface GlobalConfig {
  modelTier: string;
  vectorDim: number;
  embedMode: "cpu" | "gpu";
  mlxModel?: string;
  queryLog?: boolean;
  llmEnabled?: boolean;
}
```

Extend `ProjectEntry` with optional exact built identity:

```ts
embedModel?: string;
mlxModel?: string;
colbertModel?: string;
embeddingFingerprint?: string;
rebuildId?: string;
```

Retain existing `modelTier`, `vectorDim`, `embedMode`, `lastIndexed`, and `chunkerVersion` fields for
compatibility. `embedMode` remains an execution preference/history field, not part of semantic
embedding identity. Old entries derive exact IDs from their tier until their next successful full
sync.

Add a validated immutable `EmbeddingGenerationConfig` resolved from `modelTier`:

```ts
interface EmbeddingGenerationConfig {
  tier: string;
  vectorDim: number;
  onnxModel: string;
  mlxModel: string;
  colbertModel: string;
  fingerprint: string;
}
```

`modelTier` is authoritative; reject a persisted `vectorDim` that contradicts the tier instead of
feeding inconsistent values to VectorDB and workers. ONNX and MLX IDs are transports/implementations
of the same tier identity, so runtime CPU fallback does not create a new built identity.
The deterministic fingerprint covers tier, dimension, ONNX ID, MLX ID, and ColBERT ID.

#### 5A tests and gate

- resolver returns one immutable canonical generation for each tier
- any tier/dimension/ONNX/MLX/ColBERT change changes the fingerprint
- contradictory tier/dimension input fails without fallback
- legacy `ProjectEntry` records remain readable
- no persistent bytes or indexing behavior change in 5A
- full Phase 0 gate passes

### 5B. Persistent identity cutover

**Status:** Complete in the working tree on 2026-07-11. Phase 8 rebuild refusal remains intact and
legacy project records remain readable without eager migration. Full gate: 104 test files / 850
tests, production and test-source typechecks, Biome across 285 files, direct build, and diff checks.

The stamping, `IndexConfig` removal, and status-display work below requires Phase 6's top-level
operation admission and shared store lease. Indexing must stamp the immutable generation it actually
used inside the daemon-owned operation, not reread mutable global config afterward.

#### Work

- Remove production writes through `writeIndexConfig()` from `initialSync()`.
- Make project registration the only successful-full-sync identity stamp.
- Update add, index, watch initial sync, search auto-sync, daemon pending indexing, doctor repair, and
  rebuild callers to stamp exact project identity after success.
- Stamp the immutable generation identity returned by the indexing operation; never reread mutable
  global config after indexing and infer what produced the rows.
- Move pending registration and final identity stamping into the same daemon-owned top-level
  operation and shared store lease as indexing. CLI commands consume the result but do not perform a
  later out-of-band registry stamp.
- Update config/list/status/serve stats/MCP status to display configured identity separately from
  current project's built identity.
- Compare a project's built identity with current config before sync:
  - chunker-only change may reset one project
  - any dense model/tier identity change is a whole-corpus migration because one query embedding
    cannot search rows from different embedding spaces, even at the same width
  - dimension or model change fails before deletion, reports rebuild unavailable, and preserves the
    current generation until Phase 8 enables guarded rebuild
- Never stamp identity after incomplete/degraded scan or failed maintenance.
- Inject the complete immutable generation into worker construction, MLX expected-model checks, and
  ColBERT construction; do not leave ColBERT hard-coded outside the fingerprint contract.
- Add one locked batch-registry mutation API with optional expected `rebuildId`/fingerprint checks;
  global rebuild never rewrites project statuses through a loop of independent registry writes.

#### Tests

Add `tests/index-config.test.ts` and two-project identity scenarios. Verify global preferences survive
every indexing path, all projects in one physical generation share one embedding identity, runtime
CPU/GPU fallback preserves that identity, and stale projects are detected without being searched as
compatible. Verify the fingerprint changes for any tier/dimension/ONNX/MLX/ColBERT change and an
index operation stamps the generation it actually used, not a later config value.

#### Phase gate

- No full index writes global preferences.
- Every successful indexing path stamps identical project identity fields.
- Failed indexing preserves prior built identity.
- Existing registry entries remain readable without eager migration.
- Full Phase 0 gate passes.

## Phase 6 - Daemon Operation and Shutdown Foundation

**Finding:** F3 foundation; required support for F2/F8 and additional lifecycle risks.

**Status:** Complete in the working tree on 2026-07-11. Coordinator, keyed mutex, store lease,
automatic `VectorDB` shared leasing, daemon admission, structured IPC errors, watcher quiescence, and
single-flight ordered shutdown are implemented. Full gate: 103 test files / 843 tests, production and
test-source typechecks, Biome across 283 files, direct build, and diff checks.

### Operation coordinator

Add `src/lib/utils/operation-coordinator.ts` with shared, exclusive, and closing states.

```ts
class OperationCoordinator {
  runShared<T>(name: string, signal: AbortSignal | undefined, fn: (signal: AbortSignal) => Promise<T>): Promise<T>;
  runExclusive<T>(name: string, quiesce: () => Promise<void>, fn: (signal: AbortSignal) => Promise<T>): Promise<T>;
  close(reason?: Error): Promise<void>;
}
```

Semantics:

- shared work overlaps while open
- requesting exclusive immediately blocks new shared admission
- quiesce runs before waiting for admitted shared work to drain
- only one exclusive request is admitted
- searches receive a structured busy response during rebuild instead of waiting indefinitely
- close rejects new work, aborts daemon-owned work, and awaits active work

Admission occurs only at top-level operations. Pass an operation context/token through internal
calls; internal helpers such as re-watch after indexing must not reacquire coordinator admission or
the same project mutex. This prevents exclusive intent from blocking a nested operation while it
waits for the admitted outer operation to drain.

Track every daemon-started store/model user through its top-level context: search,
add/index/remove, pending indexing, processor batches, catchup, watch transitions, maintenance
triggers, warmup, repair, and review. LLM lifecycle serialization remains a follow-up, but requests
must at least be visible to shutdown.

Project pending registration, indexing, and final built-identity stamp are one top-level operation.
The shared operation/store lease is not released before the registry stamp, preventing an exclusive
rebuild from overtaking indexing and then receiving a stale old-generation `indexed` write.

### Cancellable project mutex

Replace promise-tail `withProjectLock()` with an abortable keyed mutex. Register connection-close
cancellation before waiting. Aborted waiters are removed and never start after the previous holder
releases.

Lock order is fixed:

1. keyed project mutex for ordinary project operations
2. shared operation admission

Global exclusive rebuild never acquires project mutexes after it begins. This avoids lock inversion.

### Interprocess store lease

The daemon coordinator cannot see MCP sessions, direct CLI fallbacks, schema probes, or other
processes that open the shared LanceDB. Add `src/lib/store/store-lease.ts` and require every
`VectorDB` opener to participate.

Use a cross-process shared/exclusive lease with explicit owner metadata:

- normal `VectorDB` lifetime holds a shared lease marker with PID, process start identity, and nonce
- exclusive intent is acquired atomically and blocks new shared leases
- exclusive acquisition waits for all other live shared owners to close
- the daemon may upgrade its own shared lease by acquiring intent, blocking new readers, and waiting
  for every marker except its own before closing/promoting its DB
- stale shared markers are removed only after owner death/start-identity verification
- exclusive acquisition has a bounded timeout and reports blocking PIDs/process roles
- `VectorDB.close()` always releases its lease
- target `VectorDB` during rebuild receives the exclusive lease token rather than reacquiring shared

Long-lived MCP sessions can therefore block rebuild until they close, but cannot overlap drop. This
is preferable to dropping under an invisible reader. Release notes require restarting all gmax
processes after the lease protocol ships; old uncooperative processes cannot be made safe by a new
daemon-local lock.

Direct CLI search may fall back only when the daemon is genuinely unavailable and no exclusive
intent exists. It never falls back on `busy`, `rebuilding`, capability, or scope errors.

### Watch sessions

Refactor `WatcherManager` timer maps into one per-root session with generation, desired state,
abort controller, subscription, processor, backoff timer, poll timer, and recovery promise.

- every timer callback verifies session generation
- unwatch invalidates generation before awaiting cleanup
- teardown clears and awaits every timer/recovery promise
- catchup accepts an abort signal
- add `quiesceAll()` and `resumeAll(snapshot)` for exclusive generation replacement

### Single-flight daemon shutdown

Store and return one `shutdownPromise`. Install signal handlers immediately after constructing the
daemon, before `start()`.

Shutdown order:

1. mark not-ready/stopping and write draining marker
2. stop accepting IPC and await server close, with tracked sockets and bounded destruction
3. unlink socket/PID and await lock release
4. clear all timers and close coordinator admission
5. abort startup and daemon-owned operations
6. quiesce watchers/processors
7. await coordinator and project-mutex drain
8. stop model managers and worker pool
9. close MetaCache and VectorDB
10. unregister state
11. relaunch only after resources close
12. clear draining marker in final cleanup

### Tests

- `tests/operation-coordinator.test.ts`
- `tests/keyed-mutex.test.ts`
- extend `tests/watcher-manager.test.ts`
- extend `tests/daemon-lifecycle.test.ts`

Use fake timers and deferred promises. Test repeated shutdown, shutdown during startup, socket close,
queued disconnect, recovery timeout resurrection, quiesce/resume ordering, exclusive intent during
reindex final re-watch, shared lease drain, stale marker cleanup, and direct-fallback refusal.

### Phase gate

- No destructive rebuild behavior changes yet.
- All ordinary operations pass through shared admission.
- Every VectorDB opener holds an interprocess shared lease and honors exclusive intent.
- Shutdown proves all store users drained before close.
- Full Phase 0 gate passes.

## Phase 7 - MLX Ownership and Cleanup

**Finding:** F8 and related daemon recovery ownership risks.

**Status:** Complete in the working tree on 2026-07-11. Lifecycle verification uses mocked processes
only; no MLX server or model was started. Phase 8 subsequently completed on this foundation.

Refactor `MlxServerManager` around explicit states: stopped, probing, starting, owned-ready,
adopted-ready, stopping, and failed.

### Required behavior

- `ensure()` and `stop()` are single-flight.
- Parse `/health` JSON and require the expected model, not just HTTP 200.
- Close the parent log FD immediately after `spawn()` returns; the child retains its duplicate.
- Track child error and exit during startup.
- On timeout, terminate the owned detached process group, await exit, escalate to SIGKILL if needed,
  await again, then clear ownership.
- Stop only an owned process group.
- Never kill an adopted service on daemon shutdown.
- Never kill an arbitrary PID merely because it occupies the port.
- An occupied unhealthy or wrong-model unverified port causes CPU fallback and a clear diagnostic.
- Recheck shutdown/cancellation after every awaited health/recovery step.

Add a small ownership sidecar under `~/.gmax` only if process-group identity cannot otherwise be
validated across daemon crashes. The sidecar must include owner PID, process group, port, model,
start time, and nonce; reclaim only when owner death and process identity both verify. Do not add
the sidecar preemptively if the spawned child handle/process group is sufficient for clean runtime
ownership.

Change `mlx-client.ts` to validate expected model from `/health` before sending embeddings.

Standalone `serve` MLX code is already removed in Phase 1, so there is one manager to fix.

### Tests

Extend `tests/mlx-server-manager.test.ts` using mocked HTTP, spawn, and process signaling only:

- successful readiness closes FD once
- async spawn failure closes FD once
- timeout terminates and awaits group, then escalates
- concurrent ensure spawns once
- stop during startup cleans up
- matching service is adopted and not killed
- wrong-model service is rejected
- unrelated port owner is never killed
- shutdown during recovery cannot respawn

### Phase gate

- No test or implementation verification starts `uv`, a Python server, or a model.
- Owned/adopted semantics are explicit in status and logs.
- Full Phase 0 gate passes.

Implemented results:

- explicit stopped, probing, starting, owned-ready, adopted-ready, stopping, and failed states
- single-flight concurrent ensure and stop behavior
- strict health model and ownership-token validation
- matching external service adoption without shutdown ownership
- wrong-model and unrecognized port-owner refusal without arbitrary signaling
- immediate parent log-descriptor closure and startup-listener cleanup
- bounded SIGTERM-to-SIGKILL process-group teardown for owned startup failures and timeouts
- daemon status, CLI status, and doctor reporting for MLX lifecycle/model diagnostics
- mocked coverage in `tests/mlx-server-manager.test.ts`, `tests/mlx-health-probe.test.ts`, and
  `tests/process-group.test.ts`

Full gate: 106 test files / 865 tests, production and test-source typechecks, Biome across 287 files,
direct build, JavaScript/Python syntax checks, and `git diff --check`.

## Phase 8 - Exclusive Resource-Generation Rebuild

**Findings:** F2 and F3 completion.

**Status:** Complete in the working tree on 2026-07-11 after explicit approval. This is whole-corpus
guarded repair for the current layout, not the separate background atomic re-embed product plan. No
real rebuild or model process was started during verification.

### Immutable generation

Represent the daemon's embedding resources as one generation:

```ts
interface DaemonResourceGeneration {
  id: number;
  config: EmbeddingGenerationConfig;
  vectorDb: VectorDB;
  workerPool: WorkerPool;
  mlx: "owned" | "adopted" | "cpu";
}
```

MetaCache may remain daemon-lifetime state, but every processor using it is recreated during
generation replacement. Searchers and processors receive explicit DB/pool dependencies rather than
resolving mutable global singletons during operations.

Make `WorkerPool` capture an immutable embedding environment. Add an explicit replacement API; do
not allow one pool to spawn a mix of old and new tier workers.

Pass generation-owned DB/pool dependencies through every daemon path, including `initialSync`,
`Searcher`, `ProjectBatchProcessor`, warmup, and process management. Daemon generation code must not
call the mutable module-level `getWorkerPool()` singleton.

### Store exclusive mutation

Extend `VectorDB` with an exclusive mutation gate:

- announce exclusive intent before draining active writes
- block later writes from entering
- wait for compaction/maintenance
- perform drop
- ignore only a verified missing-table error
- propagate corruption, permission, I/O, and commit errors
- make close wait for active writes and exclusive mutation

This in-process gate composes with the Phase 6 interprocess store lease. The lease excludes other
processes; the mutation gate drains work inside the exclusive owner.

### Rebuild protocol capability

Add a daemon IPC protocol/capability field to `ping`. `repair --rebuild` refuses to send the
destructive command to a daemon lacking exclusive-generation rebuild support and instructs the user
to restart it. Never rely only on package version string comparison.

### Rebuild sequence

1. Attach client-close cancellation before waiting.
2. Resolve and validate one immutable `EmbeddingGenerationConfig`; snapshot desired watched roots
   for later resume. The registry is not authoritatively snapshotted until exclusive ownership.
3. Enter `runExclusive("repair")`; new searches receive busy.
4. Quiesce watchers/processors and drain all admitted operations.
5. Pause maintenance and evict all Searchers.
6. Acquire/upgrade to the interprocess exclusive store lease; on timeout, report blocking processes
   and do not tear down the old generation.
7. While holding exclusive store ownership, lock and reread the registry, derive the authoritative
   included set, and atomically mark every included project pending with target fingerprint and a
   unique `rebuildId` in one rewrite before drop. Keep that locked snapshot for pre-drop restoration.
8. Destroy the old worker pool and await child termination.
9. Stop the owned old-model MLX generation and await cleanup; adopted service remains untouched.
10. Close old `VectorDB` handles while retaining the exclusive lease token.
11. Open a target-width `VectorDB` with the exclusive lease token.
12. Drop through the store exclusive mutation gate.
13. Create/ensure the target table and verify its physical vector dimension.
14. Ensure the expected MLX model or establish explicit CPU fallback.
15. Create the immutable target worker pool.
16. Publish the new resource generation only after schema/model validation.
17. Reindex each project without restarting watchers between projects.
18. Stamp each project indexed only after its own successful full sync and only if its `rebuildId`
    still matches; clear `rebuildId` in that same write.
19. Recreate desired watchers against the new generation.
20. Downgrade/release exclusive store ownership to the new generation's shared lease.
21. Resume maintenance.
22. Reread global config; if its fingerprint changed during rebuild, report that another rebuild is
    needed rather than claiming current-config success.

Before drop, client disconnect cancels. After drop, it only suppresses progress output; rebuild
continues unless daemon shutdown aborts it.

### Failure semantics

| Failure point | Required state |
|---|---|
| Before pending mark | Old generation/watchers remain; registry unchanged |
| After pending mark but before committed drop | Reconstruct old generation from immutable snapshot, atomically restore only entries still carrying this `rebuildId`, resume watchers |
| Drop error known not to have committed | Reconstruct old generation and compare-and-restore this rebuild's registry entries |
| After successful drop, before target schema | Projects pending; daemon degraded; no false indexed stamp |
| Physical dimension mismatch | Abort target generation; projects remain pending |
| One project reindex fails | Completed projects remain indexed; failed/unstarted projects pending |
| Config changes during rebuild | Report snapshot generation completed but current config differs |
| Client disconnect after drop | Continue safely without writes to dead socket |

### Tests

- `tests/vector-db-exclusive-gate.test.ts`
- `tests/daemon-operation-barrier.test.ts`
- `tests/daemon-rebuild.test.ts`
- extend `tests/model-tier-wiring.test.ts`
- extend `tests/vector-db-schema-dim.test.ts`

Cover active search/batch/index ordering, stale Searcher eviction, old pool destruction, new dimension,
drop error propagation, physical schema verification, config mutation, disconnect timing, degraded
post-drop failures, external shared-lease blocking, pre-drop generation reconstruction, atomic
registry transition, rejection of a stale old-generation identity stamp, and watcher recreation with
new handles.

### Phase gate

- No daemon or upgraded external-process store user overlaps drop.
- A live small-to-standard tier rebuild produces a physically verified standard-width table in
  tests with fake model resources.
- Registry identity never leads physical state.
- Full verification and package gates pass.

Implemented results:

- daemon-owned immutable DB/pool/model resource generations with explicit publication
- capability-negotiated `repair-v2`; old daemons and legacy repair IPC fail before destructive work
- daemon-local exclusive admission plus interprocess lease upgrade/transfer/downgrade
- strict mutation gating across writes, schema/FTS changes, maintenance, compaction, drop, and close
- durable rebuild journal covering reservation, drop intent, crash resume, and registry expansion
- strict old worker/DB teardown before drop and adopted-MLX non-ownership preservation
- physical target-width verification before resource publication
- per-project compare-and-set completion with partial-failure truth preservation
- pre-drop disconnect rollback, post-drop continuation, and strict degraded shutdown
- watcher recreation followed by catchup after exclusive admission releases
- blocker diagnostics with lease owner PID, process-start identity, nonce, and role

Full gate: 114 test files / 942 tests, production and test-source typechecks, Biome across 296 files,
direct build, JavaScript/Python syntax checks, and `git diff --check`.

## Compatibility and Migration Notes

### Deliberate behavior changes

- `gmax serve` is loopback-only and daemon-backed.
- `gmax serve --cpu` directs users to global daemon configuration.
- Scripts using `--in ../other-project` must use `--root` or cross-project flags.
- Arbitrary MCP roots/files must select a registered project first.
- Internal and external repository symlinks are consistently excluded.
- `--all-projects` may return fewer results because orphan and error-project rows are excluded.
- Searches during global repair return a busy error instead of partial/empty results.
- A mismatched adopted MLX service causes CPU fallback rather than being killed.

### Lazy data migration

- Existing project entries remain valid; exact model IDs are filled on the next successful full
  sync.
- Existing Markdown metadata without current `hashVersion` reprocesses once.
- Existing metadata without `hasVectors` is reconciled lazily from physical paths.
- No eager registry rewrite or full-corpus reindex is required except the intentional rebuild for a
  dimension change.

### Rollback boundaries

- Phases 1-5 are independently revertible before daemon lifecycle changes.
- Phase 1's `serve` proxy must be reverted as a unit; do not restore only its old writer path.
- Phases 6-8 share lifecycle contracts. Once Phase 8 depends on the coordinator/generation APIs,
  rollback must restore all three phases together.
- No phase should rewrite persisted state irreversibly before its compatibility reader is shipped.

## Verification Strategy

### Per-phase deterministic gate

```bash
pnpm run typecheck
pnpm run test:typecheck
pnpm run format:check
pnpm run test
pnpm run build
```

### Final release gate

```bash
pnpm install --frozen-lockfile
pnpm run typecheck
pnpm run test:typecheck
pnpm run format:check
pnpm run test
pnpm run build
pnpm audit --prod
npm pack --dry-run --ignore-scripts --json
```

Run deterministic gates on the Node 22.12 engine floor and the release Node version. Keep the real
Parcel watcher timing canary in a separate macOS integration shard; unit tests use fake subscriptions
and timers. Use temporary LanceDB/LMDB directories for store tests. Mock `EACCES` rather than relying
on filesystem permissions that differ under privileged CI.

### Safety rules for tests

- never invoke `gmax serve`, daemon foreground startup, `review`, `investigate`, `summarize`, or
  benchmark commands as integration shortcuts
- never spawn `uv`, Python model servers, `llama-server`, or real worker model processes
- use mock child processes for MLX and worker lifecycle
- use unique Unix socket paths and await both listen and close
- restore HOME, cwd, environment, timers, module singletons, and sockets after each test
- do not run publish/version/postrelease scripts against real GitHub or npm services

## Completion Criteria

The plan is complete only when:

1. all fourteen confirmed findings have a passing regression test
2. the additional lifecycle and integrity risks pulled into the phases are either fixed or recorded
   with an explicit deferral
3. every successful pre-audit test remains green
4. security-boundary changes have updated README/help/schema text
5. daemon protocol compatibility prevents old daemons from executing unsafe rebuild semantics
6. no production or test path loads a prohibited local LLM during verification
7. physical table schema, per-project identity, and global config can be inspected independently and
   never contradict a reported successful rebuild

## Closeout

The principal remediation shipped in `2aaa9c4`, followed by per-path cache/vector
reconciliation in `9d7e501`, critical-pressure deletion safety in `8f77b4c`, and stability
fixes `1364e58`, `9b012b2`, and `9f29870`. All audit findings are closed. Zero-downtime
embedding migration remains intentionally separate and is not an audit blocker.

## Version History

- **2026-08-04T11:07:44Z** Archived — All audit findings shipped; follow-up stability work is tracked separately.
