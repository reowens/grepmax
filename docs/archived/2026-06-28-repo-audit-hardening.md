---
type: plan
status: archived
created: 2026-06-28T20:15:00Z
updated: 2026-06-29T08:42:28Z
surfaces:
  - daemon
  - index
  - graph
  - search
  - release
  - packaging
modules:
  - src/lib/daemon/daemon.ts
  - src/lib/daemon/process-manager.ts
  - src/lib/index/batch-processor.ts
  - src/lib/graph/graph-builder.ts
  - src/lib/graph/impact.ts
  - src/commands/dead.ts
  - src/commands/search.ts
  - src/commands/search-run.ts
  - src/lib/search/searcher.ts
  - src/lib/store/vector-db.ts
  - .github/workflows/release.yml
  - scripts/postinstall.js
domain: repository audit follow-ups (correctness, lifecycle, release hardening)
audience: internal
parent_plan:
related_plans:
  - ../plans/graphify-derived-improvements.md
  - ../plans/mcp-server-migration.md
related_docs:
  - ../known-limitations.md
  - ../agent-ux-proposals.md
current_state: >
  Phases 1-5 are implemented. Lifecycle fixes now block/degrade safely around
  draining daemons, expose readiness separately from liveness, and quiesce/requeue active
  ProjectBatchProcessor work. Graph consumers now use language-family anchors and outbound
  callee resolution prefers same file, then same language family, then fallback. Search/store
  fixes make `search --root` consistently use the active root, stamp chunkerVersion after
  search-triggered full sync, return `-m` results beyond RERANK_TOP while bounding expensive
  rerank, preserve VectorDB schema-validation errors, and count impact dependents by distinct
  target symbol per file. Release/package hardening is complete: release workflow actions are
  SHA-pinned, release verification includes test/format/audit/build/tarball checks, `mathjs`
  is overridden to 15.2.0, package `main` points at `dist/index.js`, prebuild removes stale
  dist and tsbuildinfo, postinstall is a no-op notice, and `gmax plugin update` is explicit.
  Smaller lifecycle hardening now clears WorkerPool destroy timers on worker exit, handles MLX
  spawn errors as CPU fallback, and applies the worker respawn cap to timeout-killed workers.
  Current verification passes: typecheck, full Vitest (76 files / 634 tests), format check,
  production audit, build, dry-run pack, native simsimd smoke, and packed install/version smoke.
next_step: >
  None. Plan closed; reopen only for new audit findings.
---

# Repo Audit Hardening

## Problem

The audit found a mature codebase with strong unit coverage, but several high-leverage
gaps sit below the current tests:

- process lifecycle races around daemon restart/recycle/shutdown
- stale-index risks when watcher batches abort or close mid-file
- graph correctness paths that still match bare symbol names without language anchoring
- release-readiness gaps around dependency audit, workflow hardening, formatting, and postinstall behavior

This plan turns the audit into an execution sequence. It intentionally prioritizes
correctness and release safety over new features.

## Audit Snapshot

Commands run during the audit:

```bash
pnpm run typecheck
pnpm run test
pnpm run format:check
pnpm audit --prod
npm pack --dry-run --ignore-scripts --json
```

Results:

| Check | Result |
|---|---|
| `pnpm run typecheck` | passed |
| `pnpm run test` | passed, 72 files / 609 tests |
| `pnpm run format:check` | failed, 4 formatting diffs |
| `pnpm audit --prod` | failed, 2 high advisories via `simsimd > mathjs` |
| `npm pack --dry-run --ignore-scripts --json` | passed, tarball includes broad `dist/*` |

Known dirty worktree at audit time:

- `src/lib/graph/graph-builder.ts` has an in-progress same-file callee preference.
- `tests/graph-builder.test.ts` has matching tests.

Do not overwrite that work unless intentionally continuing it.

## Phases

### Phase 1 — Daemon and batch lifecycle correctness (P0)

#### 1. Block successor startup while a peer is still draining

**Finding.** `shutdown()` writes a draining marker, then drops socket/PID/lock before
shared resources are closed (`daemon.ts:1046-1124`). `ProcessManager.killStaleProcesses()`
recognizes the draining peer but still continues startup and "takes over" the free lock
(`process-manager.ts:94-109`). The existing test asserts this takeover behavior
(`tests/process-manager-draining.test.ts:53-63`).

**Impact.** Two daemon processes can overlap against shared LanceDB/LMDB resources while
the predecessor is closing processors, workers, MetaCache, and VectorDB.

**Work.** Change draining-peer behavior from "take over" to "defer until drained" for
ordinary starts. For explicit recycle handoff, spawn the successor only after resource
close, which `shutdown({ relaunch: true })` already attempts at `daemon.ts:1126-1135`.

**Acceptance.**

- A new daemon exits or waits while `isDaemonDraining(pid)` is true and the process is live.
- No new daemon opens VectorDB/MetaCache until the old process has exited or the draining marker expires.
- Regression coverage replaces the current "takes over" assertion.

#### 2. Make `ProjectBatchProcessor.close()` quiesce active work

**Finding.** `close()` only sets `closed`, aborts the current batch, and clears the timer
(`batch-processor.ts:84-88`). It does not await an active `processBatch()`.

**Impact.** Shutdown and full reindex treat `await processor.close()` as drained, while a
batch can still be flushing vectors/meta into stores that are closing or being reset.

**Work.** Track the active batch promise and have `close()` await it after aborting. Ensure
the wait is bounded by the existing batch timeout or a small close timeout.

**Acceptance.**

- Closing an active processor waits for `processBatch()` cleanup before returning.
- Shutdown does not close VectorDB/MetaCache until processors have actually quiesced.
- Tests cover close during an in-flight worker call and close during vector flush.

#### 3. Requeue started files on abort/timeouts

**Finding.** `processBatch()` marks a file `attempted` before worker processing
(`batch-processor.ts:148-151`). If the batch aborts while `pool.processFile()` is running,
the catch path breaks (`batch-processor.ts:232-234`) and requeue only restores non-attempted
paths (`batch-processor.ts:251-255`).

**Impact.** A changed file can be dropped permanently until another filesystem event
happens.

**Work.** Track successful completion separately from attempted processing. On abort or
pool-unhealthy break, requeue the current in-flight file unless its delete/meta/vector
write has been flushed.

**Acceptance.**

- Abort during `processFile()` leaves the file pending for retry.
- A successful file is not requeued.
- Existing disk-pressure and corruption backoff behavior remains unchanged.

### Phase 2 — Graph resolver consistency (P0/P1)

#### 4. Apply language anchoring to `dead`, `impact`, and `test`

**Finding.** `GraphBuilder.getCallers(symbol, anchorFamily?)` only guards cross-language
phantom callers when `anchorFamily` is passed (`graph-builder.ts:75-114`). `buildGraph()`
passes it, but `dead` calls `getCallers(symbol)` directly (`dead.ts:150-155`) and
`walkCallers()` in impact/test traversal does the same (`impact.ts:233-245`).

**Impact.** A Python `render` can be marked live because a TSX file references an unrelated
`render`; `impact` and `gmax test` can report unrelated cross-language dependents/tests.

**Work.** Resolve the target definition first and pass `languageFamilyForPath(defPath)` to
every inbound traversal. For multi-hop traversal, propagate each caller's own language
family when walking upward.

**Acceptance.**

- `dead`, `impact`, and `test` ignore foreign-family references for same bare symbol names.
- Tests cover at least TS/Python same-name false positives.
- Existing same-family behavior remains unchanged.

#### 5. Finish callee resolution disambiguation

**Finding.** The dirty change in `graph-builder.ts` improves same-file callee resolution by
fetching up to 25 definitions and preferring the center's file (`graph-builder.ts:184-221`).
When no same-file definition exists, it still falls back to the first row without preferring
same language.

**Impact.** Outbound `trace`/`search --symbol` can point a Python caller to a TS callee, or
vice versa, when definitions share a name.

**Work.** After same-file preference, prefer candidates whose `languageFamilyForPath(path)`
matches the center's family. Fall back to first row only if no same-family candidate exists.

**Acceptance.**

- Same-file definition wins.
- Same-language definition wins when same-file is absent.
- Existing fallback still works for unknown/unclassified file types.

#### 6. Decide whether this belongs in the graphify precision plan

This work overlaps `docs/plans/graphify-derived-improvements.md`, Phase 2. Once shipped,
update that plan's current state so the precision backlog does not fork into two versions.

### Phase 3 — Search and store correctness (P1)

#### 7. Fix `search --root <other>` fallback indexing/watching

**Finding.** `search.ts` validates `--root` into `checkRoot` / `effectiveRoot`, but passes
the cwd-derived `projectRoot` and `paths` into `runSearch()` (`search.ts:220-235`,
`329-334`). In fallback mode, `runSearch()` indexes and launches the watcher for
`projectRoot` (`search-run.ts:208-213`, `267-270`) while querying `effectiveRoot`.

**Impact.** First-run search or `--sync --root /other/project` can index/watch the wrong
project.

**Work.** Use `effectiveRoot` for fallback initial sync, registry update, watcher launch,
and `GMAX_PROJECT_ROOT` when `--root` is supplied. Keep cwd-derived path behavior only for
the no-`--root` case.

**Acceptance.**

- From cwd `/a`, `gmax search --root /b --sync` calls `initialSync({ projectRoot: "/b" })`.
- Watcher launch targets `/b`.
- Registry entry for `/b` preserves/stamps `chunkerVersion`.

#### 8. Remove hidden `-m > RERANK_TOP` result cap

**Finding.** `Searcher.search()` accepts any `top_k` as `finalLimit`, but only scores
`stage2Candidates.slice(0, RERANK_TOP)` where `RERANK_TOP` defaults to 20
(`searcher.ts:451`, `763-805`, `989-997`).

**Impact.** `gmax search -m 50` can return at most about 20 results even when more fused
candidates exist.

**Work.** Make the final scoring pool at least `finalLimit`, while keeping ColBERT rerank
bounded. One likely shape: score all stage-2 candidates with fused/boost signals, apply
ColBERT only to the top `RERANK_TOP`, then diversify up to `finalLimit`.

**Acceptance.**

- `top_k > RERANK_TOP` can return more than 20 results.
- Default `-m 5`/`-m 10` ranking is unchanged or benchmark-neutral.
- Tests cover `top_k=50` with rerank disabled and enabled.

#### 9. Preserve actionable schema-validation errors

**Finding.** `validateSchema()` throws a useful `gmax index --reset` message when required
columns are missing (`vector-db.ts:305-316`), but `ensureTable()` catches every error and
tries to create the table (`vector-db.ts:425-440`).

**Impact.** Existing invalid/corrupt schemas can produce confusing create-table/table-exists
errors instead of a clear reset instruction.

**Work.** Only create the table when open fails because the table is missing. Let schema
validation errors escape unchanged.

**Acceptance.**

- Missing table still creates a new table.
- Existing table missing required columns throws the reset message and does not call createTable.
- Doctor/search surfaces remain actionable.

#### 10. Count impact dependents by distinct symbol per file

**Finding.** `findDependents()` increments per matching chunk (`impact.ts:292-309`). A file
with two chunks referencing the same target symbol gets `sharedSymbols += 2` for one symbol.

**Impact.** `gmax impact` overstates dependent strength and can mis-rank files.

**Work.** Track `file -> Set<symbol>` and convert to counts after all symbols are scanned.

**Acceptance.**

- Two chunks in the same file referencing `Foo` produce `sharedSymbols=1`.
- A file referencing `Foo` and `Bar` still produces `sharedSymbols=2`.

### Phase 4 — Release and supply-chain hardening (P1)

#### 11. Resolve production audit failures

**Finding.** `pnpm audit --prod` reports two high `mathjs` advisories via
`simsimd > mathjs`.

**Work.** Prefer an upstream `simsimd` update if available. If not, document a temporary
advisory waiver with a clear reason and removal trigger.

**Acceptance.**

- `pnpm audit --prod` passes, or CI has an explicit documented waiver for these exact advisories.

#### 12. Harden release workflow permissions and action pinning

**Finding.** Release uses mutable action tags while the job has `id-token: write` and
`contents: write` (`release.yml:12-32`).

**Work.** Pin third-party actions by SHA. Split build/test from the minimal OIDC publish
job if practical. Add `pnpm test`, format/lint check, dependency audit, and tarball smoke
install to release.

**Acceptance.**

- Publish job has the smallest practical permission set.
- Actions are SHA-pinned or consciously waived in comments.
- Release job runs tests and audit before `npm publish`.

#### 13. Make packaging deterministic and narrower

**Finding.** `package.json` whitelists `dist/*`, `prebuild` only creates `dist` rather than
cleaning it, and the packed tarball includes compiled eval/diagnostic scripts. `package.json`
also points `main` to missing root `index.js` while `bin` correctly points at `dist/index.js`.

**Work.** Clean `dist` before build. Decide whether eval scripts should ship; if not,
exclude them from the compiled or packed output. Fix `main` to `dist/index.js` or remove it.

**Acceptance.**

- `npm pack --dry-run --ignore-scripts --json` contains only intentional files.
- No stale file under `dist/` can silently ship.
- `require("grepmax")` no longer points at a missing file if `main` remains.

#### 14. Reconsider postinstall user-home mutations

**Finding.** `postinstall` silently mutates Claude plugin caches and can run PATH-resolved
`gmax install-*` commands for OpenCode/Codex/Droid (`scripts/postinstall.js:30-120`).

**Impact.** Global install/update has broad side effects outside the package directory,
which is risky for supply-chain trust and hard to audit.

**Work.** Prefer explicit `gmax plugin update` / `gmax plugin add` flows. If automatic
updates stay, resolve the package-local bin rather than `gmax` from PATH and print an
opt-out path.

**Acceptance.**

- Fresh/global install does not unexpectedly rewrite user agent configs, or the behavior is explicit and documented.
- Postinstall never executes a PATH-shadowed `gmax` binary.

### Phase 5 — Cleanup and smaller lifecycle hardening (P2)

#### 15. Fix repo formatting drift

`pnpm run format:check` currently fails on:

- `.claude-plugin/marketplace.json`
- `plugins/grepmax/.claude-plugin/plugin.json`
- `src/lib/llm/investigate.ts`
- `tests/investigate-tool-call-leak.test.ts`

Acceptance: `pnpm run format:check` passes.

#### 16. Clean worker-pool shutdown handles

`WorkerPool.destroy()` resolves on worker exit but leaves the fallback timeout handles
referenced until `WORKER_TIMEOUT_MS` (`pool.ts:846-864`). Clear/unref fallback timers when
the worker exits.

Acceptance: a destroy test proves no long referenced timer remains after clean worker exit.

#### 17. Handle MLX spawn errors without crashing the daemon

`MlxServerManager.ensureMlxServer()` spawns `uv` without an `error` listener
(`mlx-server-manager.ts:119-141`). Missing `uv` should log and fall back to CPU, not crash
the daemon.

Acceptance: a test simulates spawn `error` and verifies CPU fallback behavior.

#### 18. Enforce worker respawn cap on task timeouts

The respawn counter is enforced in `handleWorkerExit()` (`pool.ts:343-355`), but timeout
handling removes listeners and unconditionally spawns a replacement (`pool.ts:537-575`).

Acceptance: repeated deterministic timeouts stop respawning after `MAX_RESPAWNS`.

## Proper Fixes Investigation

This section records the fix shapes selected after reading the relevant code paths. It is
the implementation blueprint for the phases above.

### A. Daemon handoff and readiness

#### A1. Draining daemon startup behavior

**Current control flow.** `Daemon.start()` calls `ProcessManager.killStaleProcesses()`
before acquiring the lock (`daemon.ts:135-146`). During shutdown, the old daemon writes a
draining marker and immediately drops socket/PID/lock (`daemon.ts:1046-1066`), then closes
processors, workers, watchers, MetaCache, and VectorDB (`daemon.ts:1071-1124`).
`killStaleProcesses()` currently sees the draining marker and skips killing the peer, but
continues startup (`process-manager.ts:94-109`). That is the overlap bug.

**Proper fix.** A live draining marker must block resource takeover, not just SIGKILL.

Implementation shape:

```ts
// daemon-client.ts
export async function waitForDaemonDrain(pid: number, timeoutMs = DRAIN_GRACE_MS): Promise<boolean> {
  return waitForProcessExit(pid, timeoutMs);
}

// process-manager.ts
if (isDaemonDraining(pid)) {
  const exited = await waitForDaemonDrain(pid);
  if (exited) continue;
  // marker grace elapsed and process still exists: fall through to normal stale probes/kill
}
```

Notes:

- Keep `ping` liveness semantics unchanged. The early socket is still needed so a slow-starting daemon is not killed as stale.
- Do not keep the lock during old-daemon cleanup unless shutdown is also rearranged; the current design intentionally drops markers early to avoid stale-lock no-op starts after OOM/SIGKILL.
- Do not spawn the recycle successor until after resource close. `shutdown({ relaunch: true })` already spawns at the end (`daemon.ts:1126-1135`); preserve that and remove comments/tests that imply early takeover is safe.

Tests to change/add:

- Replace `tests/process-manager-draining.test.ts` "takes over" expectation with "waits for draining peer exit and does not kill it".
- Add a timeout case: if `waitForDaemonDrain()` returns false and heartbeat/socket probes are stale, the stale daemon is killed.
- Add a recycle test asserting `spawnDaemon()` is called only after processors/stores are closed. This can be a mocked-order unit test on `shutdown({ relaunch: true })`.

#### A2. Auto-start readiness race

**Current control flow.** The daemon listens on the socket before LanceDB/MetaCache open
(`daemon.ts:168-253`). `handleCommand()` allows `ping` but gates resource-dependent
commands with `{ ok:false, error:"daemon initializing" }` (`ipc-handler.ts:80-85`).
`ensureDaemonRunning()` treats any successful `ping` as ready (`daemon-client.ts:216-227`).
Streaming clients then call `sendStreamingCommand()` and can fail with `connection closed
before done` because the non-streaming initializing response is ignored (`daemon-client.ts:292-304`).

**Proper fix.** Separate liveness from readiness.

Implementation shape:

- Add `ready: daemon.isReady()` to the `ping` response in `ipc-handler.ts`.
- Keep `isDaemonRunning()` as liveness-only: it should still return true on `{ ok:true, ready:false }`.
- Change `ensureDaemonRunning()` to poll until `ping.ok === true && ping.ready === true`, with a timeout long enough for DB open. Since `ready` is set before MLX startup (`daemon.ts:253-267`), this should not wait for the 30s GPU probe.
- Change `sendStreamingCommand()` to reject immediately on `{ ok:false, error }` so callers get `daemon initializing`, not `connection closed before done`.

Tests to add:

- `daemon-client.test.ts`: `ensureDaemonRunning()` sees ping ready=false, keeps polling, then returns true on ready=true.
- `daemon-client.test.ts`: `sendStreamingCommand()` rejects with `daemon initializing` on a one-line non-streaming error response.
- `daemon-lifecycle.test.ts`: `ping` before resources includes `ready:false`; after `daemon.ready = true`, includes `ready:true`.

### B. ProjectBatchProcessor quiescence and retry correctness

#### B1. Close must await active work

**Current control flow.** `close()` aborts and clears the debounce timer but returns
immediately (`batch-processor.ts:84-88`). Both full reindex (`daemon.ts:662-667`) and
shutdown (`daemon.ts:1085-1088`) assume it has drained.

**Proper fix.** Track the active batch promise in the class and await it in `close()`.

Implementation shape:

```ts
private activeBatch: Promise<void> | null = null;

private scheduleBatch(): void {
  if (this.debounceTimer) clearTimeout(this.debounceTimer);
  this.debounceTimer = setTimeout(() => {
    const run = this.processBatch();
    this.activeBatch = run;
    run.finally(() => {
      if (this.activeBatch === run) this.activeBatch = null;
    });
  }, DEBOUNCE_MS);
}

async close(): Promise<void> {
  this.closed = true;
  this.currentBatchAc?.abort();
  if (this.debounceTimer) clearTimeout(this.debounceTimer);
  await this.activeBatch;
}
```

If a close timeout is added, prefer a small explicit constant and log the timeout rather
than silently returning early.

Tests to add:

- New tests should target `ProjectBatchProcessor` itself, not only `watcher-batch.ts`, because the bug is class-level lifecycle.
- Use fake timers or a direct private-method call via `as any` to start a batch without waiting 2s.
- Mock `getWorkerPool().processFile()` as a deferred promise; call `close()`; assert it does not resolve until the deferred worker promise settles and cleanup has run.

#### B2. Abort must requeue the started file

**Current control flow.** A file is marked `attempted` before stat/hash/worker processing
(`batch-processor.ts:148-151`). On abort during `pool.processFile()`, the catch block breaks
(`batch-processor.ts:232-234`). Requeue restores only files not in `attempted`
(`batch-processor.ts:251-255`).

**Proper fix.** Track flushed/completed paths separately from attempted paths.

Implementation shape:

- Add `completed = new Set<string>()` inside `processBatch()`.
- Add a `currentPath` variable for the file being processed.
- Mark `completed.add(absPath)` only after the file's intended outcome is represented in
  `deletes`, `vectors`, `metaUpdates`, or `metaDeletes`, and no abort has interrupted that
  file.
- On abort/pool-unhealthy break, requeue every `batch` entry not in `completed`, including
  the current started path.
- Only delete `retryCount` for completed paths, not every path in the batch.

Recommended small helper:

```ts
const requeueUncompleted = () => {
  for (const [absPath, event] of batch) {
    if (!completed.has(absPath) && !this.pending.has(absPath)) this.pending.set(absPath, event);
  }
};
```

Do not count abort requeues as ordinary retry failures; aborts are lifecycle events, not
file-specific bad input.

Tests to add:

- Worker rejects with `AbortError` after it starts. Assert the file is pending again.
- Abort after one successful file and during the second file. Assert only the second and later files are pending.
- Pool unhealthy break after an error. Assert attempted-but-uncompleted path is pending.

#### B3. Do not refactor onto `watcher-batch.ts` in this patch

`watcher-batch.ts` contains useful tested primitives, but `ProjectBatchProcessor` has extra
behavior that the primitives do not model yet: fast hash check, disk pressure backoff,
Lance corruption backoff, retry counters, activity callbacks, compaction, and logging.
The proper near-term fix is targeted lifecycle/requeue repair. A full class-to-core
refactor is a separate cleanup after these correctness tests exist.

### C. Graph resolver consistency

#### C1. Put language anchoring in shared graph APIs

**Current control flow.** `buildGraph()` anchors callers to the center definition's family
(`graph-builder.ts:179-182`), but direct consumers still call `getCallers(symbol)` without
an anchor (`dead.ts:150-155`, `impact.ts:233-245`, `mcp.ts:1153-1154`). Library consumers
such as tests footer, review risk, LLM tools, and MCP impact route through `findTests()` /
`findDependents()`, so fixing only CLI wrappers is insufficient.

**Proper fix.** Add symbol-resolution helpers and make inbound graph consumers use them by
default.

Implementation shape:

```ts
// graph-builder.ts
async resolveDefinition(symbol: string): Promise<{ file: string; line: number; family: string | null; isExported?: boolean } | null>
async getAnchoredCallers(symbol: string): Promise<GraphNode[]> {
  const def = await this.resolveDefinition(symbol);
  return this.getCallers(symbol, def?.family ?? null);
}
```

Then:

- `dead.ts` and MCP `dead` should use the definition row's family when calling `getCallers()`.
- `findTests()` should resolve each expanded symbol's family and call a new `walkCallers(symbol, anchorFamily, ...)`.
- Recursive `walkCallers()` should pass `languageFamilyForPath(caller.file)` for each upstream hop, matching `GraphBuilder.expandCallers()`.
- `findDependents()` should accept an optional `symbolFamilies?: Map<string, string | null>` or resolve internally and filter rows whose `path` has a different known family. Since this is a shared library, internal resolution is safer for MCP/LLM callers.

Important edge case:

- `resolveTargetSymbols(file)` returns multiple symbols from one file. Those symbols share the file family; use the file path when available rather than issuing one definition query per symbol.

Tests to add:

- `graph-builder.test.ts`: direct `getCallers("render", "python")` drops TSX callers and keeps Python callers.
- `dead-command.test.ts`: assert `getCallers` is called with the definition family, or unmock GraphBuilder and use rows with TS/Python paths.
- `impact-lib.test.ts`: same bare symbol in `.py` and `.tsx`; `findDependents()` only counts same-family references.
- `test-find-command.test.ts` or a new impact-library test: cross-language test file does not count as a direct test hit.

#### C2. Finish outbound callee disambiguation with same-language preference

**Current control flow.** The dirty graph-builder change already fetches multiple callee
definition candidates and prefers the center's own file (`graph-builder.ts:184-221`). The
fallback is still arbitrary first row.

**Proper fix.** Preference order should be:

1. same file as center
2. same language family as center
3. first row, only if no same-family candidate exists

Implementation shape:

```ts
const centerFamily = center ? languageFamilyForPath(center.file) : null;
const selfRow = rows.find((r) => String((r as any).path ?? "") === centerFile);
const familyRow = centerFamily
  ? rows.find((r) => languageFamilyForPath(String((r as any).path ?? "")) === centerFamily)
  : undefined;
const chosen = selfRow ?? familyRow ?? rows[0];
```

Tests to add:

- Existing same-file test remains.
- Add Python center calling `validate`, with TS `validate` first and Python `validate` second. Expect Python.
- Existing fallback test remains for cases with no same-family candidate.

### D. Search and store fixes

#### D1. `search --root` must use one root for registry, sync, watch, and query

**Current control flow.** `search.ts` computes `projectRoot` from cwd/positional path and
`checkRoot` from `--root` (`search.ts:220-235`). It then passes both `projectRoot` and
`effectiveRoot` into `runSearch()` (`search.ts:329-339`). The in-process fallback queries
`effectiveRoot` but indexes, registers, and launches a watcher for `projectRoot`
(`search-run.ts:208-253`, `267-270`).

**Proper fix.** In single-project mode, derive one `activeRoot` after `--root` resolution
and pass it everywhere that mutates state.

Implementation shape:

```ts
const cwdSearchRoot = exec_path ? path.resolve(exec_path) : root;
const cwdProjectRoot = findProjectRoot(cwdSearchRoot) ?? cwdSearchRoot;
const resolvedRoot = options.root ? resolveRootOrExit(options.root) : null;
if (options.root && resolvedRoot === null) return;
const activeRoot = options.root
  ? findProjectRoot(resolvedRoot!)
  : cwdProjectRoot;
const paths = ensureProjectPaths(activeRoot);
process.env.GMAX_PROJECT_ROOT = activeRoot;
```

Then simplify `runSearch()` so it receives `projectRoot` for mutations and path prefix, not
both `projectRoot` and `effectiveRoot`, unless a future caller truly needs both.

Also add `chunkerVersion: CONFIG.CHUNKER_VERSION` to the search-triggered full-sync
registry update (`search-run.ts:244-253`). This path runs a full sync, so stamping is
correct.

Tests to add:

- Mock `resolveRootOrExit("/tmp/other") -> "/tmp/other"` and `findProjectRoot()` accordingly.
- Run `search query --root /tmp/other --sync` from mocked cwd `/tmp/project`.
- Assert `initialSync({ projectRoot: "/tmp/other" })`, `launchWatcher("/tmp/other")`, `hasRowsForPath("/tmp/other")`, and registry entry root `/tmp/other` with current chunker version.

#### D2. `-m` must not be capped by `RERANK_TOP`

**Current control flow.** The final result limit can be any `top_k`, but only
`stage2Candidates.slice(0, RERANK_TOP)` is scored (`searcher.ts:763-805`). Dedup/diversify
can never output more than that set (`searcher.ts:974-997`).

**Proper fix.** Keep ColBERT bounded but score the wider display pool.

Implementation shape:

- Define `displayCandidates = stage2Candidates.slice(0, Math.max(finalLimit * MAX_PER_FILE, finalLimit, RERANK_TOP))`, capped by `STAGE2_K`.
- Define `rerankCandidates` as today, including symbol-definition injections.
- Load ColBERT and call `pool.rerank()` only for `rerankCandidates` when `doRerank` is true.
- Build a `rerankScoreById` map.
- Score every `displayCandidate`: use ColBERT score when present, otherwise use fused score as base. Apply the same `FUSED_WEIGHT`, structure boost, definition boost, PageRank, dedup, and diversification.

This preserves the bounded expensive operation while letting `-m 50` use fused ordering for
tail results.

Tests to add:

- Searcher unit with 50 mock candidates and `GMAX_RERANK_TOP=20`, `top_k=50`; assert more than 20 results can return.
- Rerank-on test asserts `pool.rerank()` receives only `RERANK_TOP` docs, not all 50.
- Default `top_k=5` snapshot or score-order test remains unchanged.

#### D3. `ensureTable()` must only create on missing table

**Current control flow.** `ensureTable()` catches any error from `openTable()`,
`validateSchema()`, or `evolveSchema()` and then calls `createTable()` (`vector-db.ts:425-440`).

**Proper fix.** Split open-table failure from schema/evolution failure.

Implementation shape:

```ts
let table: lancedb.Table;
try {
  table = await db.openTable(TABLE_NAME);
} catch (err) {
  if (!isMissingTableError(err)) throw err;
  return this.createSeededTable(db);
}
await this.validateSchema(table);
await this.evolveSchema(table);
return table;
```

`isMissingTableError()` should be conservative. Match LanceDB's observed missing-table
messages only; do not classify schema/reset errors as missing. If the exact LanceDB error
shape is unstable, check by trying `db.tableNames()` if the API is available and create only
when `chunks` is absent.

Tests to add:

- Mock `openTable()` missing-table error -> `createTable()` called.
- Mock `openTable()` returns table whose schema lacks `complexity` -> throws reset message and `createTable()` not called.
- Mock `evolveSchema()` throws unknown error -> propagates, no create.

#### D4. `findDependents()` should count distinct target symbols per file

**Current control flow.** Each matching row increments a file's count (`impact.ts:292-309`).

**Proper fix.** Use `Map<string, Set<string>>`.

Implementation shape:

```ts
const symbolsByFile = new Map<string, Set<string>>();
for (const sym of symbols) {
  ...
  const set = symbolsByFile.get(p) ?? new Set<string>();
  set.add(sym);
  symbolsByFile.set(p, set);
}
return [...symbolsByFile].map(([file, set]) => ({ file, sharedSymbols: set.size }));
```

Tests to add:

- Same file has two chunks referencing `Foo`; expected `sharedSymbols=1`.
- Same file references `Foo` and `Bar`; expected `sharedSymbols=2`.

### E. Release, packaging, and supply chain

#### E1. Production audit remediation

**Investigation result.** `mathjs` is not imported by gmax. It is an optional dependency of
`simsimd@6.5.5` (`node_modules/simsimd/package.json`), and gmax uses only
`import { inner } from "simsimd"` in `src/lib/workers/colbert-math.ts`. Current latest
`simsimd` is still `6.5.5`; its optional dependency range is `mathjs: ^14.5.3`, which cannot
resolve to patched `mathjs@15.2.0` without an override.

**Proper fix.** Add a pnpm override for `mathjs@15.2.0`, then run native-load and test
smokes.

Implementation shape:

```json
{
  "pnpm": {
    "overrides": {
      "mathjs": "15.2.0"
    }
  }
}
```

Validation:

```bash
pnpm install --lockfile-only
pnpm audit --prod
node -e "const { inner } = require('simsimd'); console.log(inner(new Float32Array([1,2]), new Float32Array([3,4])))"
pnpm test
```

If the override breaks `simsimd`, fallback choices in order:

1. Open/upstream a `simsimd` dependency-range bump and temporarily document an audit waiver.
2. Evaluate whether pnpm can omit `simsimd` optional dependencies in production installs without disabling the native module.
3. Replace `simsimd` only if native-load or performance tests fail; it is in the hot ColBERT path.

#### E2. Release workflow hardening

**Proper fix.** Split verification from publish, then pin action SHAs.

Implementation shape:

- Job `verify` on Node 22: install, `typecheck`, `test`, `format:check`, `audit --prod`, `build`, `npm pack --dry-run --ignore-scripts --json`, and tarball smoke install if feasible.
- Job `publish-npm` on Node 24: `needs: verify`, minimal permissions (`id-token: write`, `contents: read` unless the same job creates the GitHub release), install/build or download verified artifact, then `npm publish`.
- Job `github-release`: after publish, `contents: write`, run `gh release create` without `|| true` unless duplicate-release idempotence is deliberately handled.
- Pin `actions/checkout`, `pnpm/action-setup`, and `actions/setup-node` by SHA. If SHA pinning is too noisy for CI, at least do it in release where OIDC publish permission exists.

Tests/checks:

- Workflow syntax check via `gh workflow view release.yml` if available.
- Dry-run by opening a tagless workflow_dispatch on a non-publishing branch is not possible with current trigger; test changes through PR CI plus careful review.

#### E3. Deterministic package contents

**Proper fix.** Clean before build and make tarball audit parse JSON.

Implementation shape:

- Change `prebuild` from `mkdir -p dist` to `rm -rf dist && mkdir -p dist`.
- Fix `main` to `dist/index.js` or remove it. Since this is a CLI package with a usable CommonJS entry, `dist/index.js` is the least surprising.
- Decide whether compiled eval scripts are public. If not, exclude `src/eval*.ts` from `tsconfig` or move eval scripts outside `rootDir` and run them with `tsx` from source only.
- In release tarball audit, use `npm pack --dry-run --json` and parse the `files[].path` JSON instead of sed over human output.

Acceptance:

- A stale file manually placed under `dist/` before build does not appear after build.
- `node -e "require('./dist/index.js')"` is not the smoke because it parses CLI args; prefer packed install plus `gmax --version`.

#### E4. Postinstall side effects

**Proper fix.** Make plugin updates explicit, not automatic.

Implementation shape:

- Remove `postinstall` or reduce it to a no-op notice that never modifies user-home config.
- Add `gmax plugin update` as an alias of `plugin add`, so README can say `gmax plugin update` after package upgrades.
- If automatic cache sync must remain for Claude only, keep it file-copy-only and never run `gmax install-*` from PATH. Resolve the package-local CLI with `process.execPath` plus `path.join(__dirname, "..", "dist", "index.js")`.

Preferred acceptance:

- `npm install -g grepmax` does not rewrite `~/.config/opencode`, `~/.codex`, or `~/.factory`.
- Tests assert `scripts/postinstall.js` does not call `execSync("gmax ...")`.

### F. Smaller lifecycle hardening

#### F1. WorkerPool destroy timers

**Proper fix.** In `destroy()`, keep handles for both fallback timers, clear them when the
worker exits, and `unref()` any remaining timeout.

Implementation shape:

```ts
let force: NodeJS.Timeout | undefined;
let fallback: NodeJS.Timeout | undefined;
const cleanup = () => {
  if (force) clearTimeout(force);
  if (fallback) clearTimeout(fallback);
  resolve();
};
w.child.once("exit", cleanup);
force = setTimeout(...); force.unref();
fallback = setTimeout(cleanup, WORKER_TIMEOUT_MS); fallback.unref();
```

Test: fake child exits immediately; assert both timers are cleared and the promise resolves
without advancing to `WORKER_TIMEOUT_MS`.

#### F2. MLX spawn error fallback

**Proper fix.** Attach `once("error")` before readiness polling and race spawn error against
health readiness.

Implementation shape:

```ts
const spawnError = new Promise<Error | null>((resolve) => {
  this.mlxChild!.once("error", (err) => resolve(err));
});
...
const err = await Promise.race([spawnError, oneSecondDelayThenHealth]);
if (err) { console.warn(...); this.mlxChild = null; return; }
```

Close `logFd` if spawn fails before the child owns it, if Node does not already do so.

Test: mock `spawn()` to return an EventEmitter child that emits `error` with `ENOENT`; assert
`ensureMlxServer()` resolves, logs fallback, and leaves `mlxChild` null.

#### F3. Worker timeout respawn cap

**Proper fix.** Centralize respawn accounting in one helper and call it from both
`handleWorkerExit()` and `handleTaskTimeout()`.

Implementation shape:

```ts
private maybeRespawn(reason: string): boolean {
  this.consecutiveRespawns++;
  if (this.consecutiveRespawns > WorkerPool.MAX_RESPAWNS) return false;
  this.spawnWorker();
  return true;
}
```

Then replace direct `this.spawnWorker()` calls in timeout handling with `maybeRespawn()`.
Keep `consecutiveRespawns = 0` only on successful task completion (`pool.ts:437-438`).

Test: force repeated hard-deadline timeouts under fake timers; assert spawn count stops after
`MAX_RESPAWNS` and pending tasks reject rather than loop forever.

## Verification Matrix

Required before closing this plan:

```bash
pnpm run typecheck
pnpm run test
pnpm run format:check
pnpm audit --prod
pnpm run build
npm pack --dry-run --ignore-scripts --json
node -e "const { inner } = require('simsimd'); console.log(inner(new Float32Array([1,2]), new Float32Array([3,4])))"
```

Targeted tests to add:

- daemon startup while peer has a live draining marker
- `ensureDaemonRunning()` waits for readiness, not just ping liveness
- streaming IPC surfaces `daemon initializing` directly
- `ProjectBatchProcessor.close()` during active worker processing
- batch abort requeues the in-flight file
- `dead` / `impact` / `test` same-name symbols across language families
- callee resolution same-file, same-language, fallback order
- `search --root /other --sync` indexes/watches `/other`
- `Searcher.search(top_k > RERANK_TOP)` result count
- `VectorDB.ensureTable()` schema-validation error path
- `findDependents()` distinct symbol count per file
- release tarball JSON audit and packed install/version smoke
- postinstall does not execute PATH-resolved `gmax install-*`
- MLX spawn error fallback
- repeated worker timeout respawn cap

## Non-Goals

- No new ranking model or recall experiment in this plan.
- No embedding migration machinery; see `docs/plans/embedding-reembed-atomic-cutover.md`.
- No broad graph import-resolution redesign beyond the consistency fixes above; larger graph precision work remains in `docs/plans/graphify-derived-improvements.md`.

## Closeout

2026-06-29: Phases 1-5 shipped and verified. Phase 5 added WorkerPool destroy timer cleanup,
MLX spawn error fallback, and timeout respawn-cap enforcement.
