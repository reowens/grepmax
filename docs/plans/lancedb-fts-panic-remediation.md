---
type: plan
status: active
created: 2026-08-04
updated: 2026-08-04
surfaces:
  - store
  - index
  - daemon
modules:
  - src/lib/store/vector-db.ts
  - src/lib/index/syncer.ts
  - src/lib/daemon/daemon.ts
domain: LanceDB FTS panic remediation and maintenance convergence
audience: internal
related_plans:
  - ../archived/stability-cycle-v0.26.2.md
  - docs/archived/performance-backlog-fixes.md
related_docs:
  - docs/2026-08-04-performance-review.md
current_state: >
  The v0.26.4 rebuild-and-retry guard restores compaction after intermittent Lance FTS
  merge panics, but live logs show repeated panic/recovery cycles through 2026-08-03.
  Current doctor reports 306,349 rows, 51 fragments (50 small), 232 versions, 8.1 GB
  logical / 16.6 GB disk, and healthy free space. The trigger for escalation has fired.
next_step: >
  Pin LanceDB exactly to 0.31.0 in an isolated branch while keeping Apache Arrow at 18.1.0.
  First make terminal FTS creation failure observable, then run real-store compatibility,
  downgrade, and production-shaped soak gates before any whole-store deployment.
summary: Successor to the expired v0.26.2 stability cycle for recurring Lance FTS merge panics.
---

# LanceDB FTS Panic Remediation

## Problem

`table.optimize()` intermittently panics inside Lance's FTS incremental merge. The shipped
guard drops/rebuilds FTS and retries once, preventing a permanent wedge, but does not remove
the underlying recurrence or repeated disk-growth cycle.

## Constraints And Corrections

- Pin `@lancedb/lancedb` to exactly `0.31.0`; latest is newer and outside this experiment.
- Keep `apache-arrow` at `18.1.0`. LanceDB 0.31 retains the same `>=15 <=18.1` peer range.
- No release note proves 0.31 fixes this panic. The upgrade is a falsifiable hypothesis.
- The shared table and native package make production rollout whole-store; there is no
  project-level canary.
- Existing panic tests are mocked. A real-LanceDB compatibility harness is mandatory.
- `createFTSIndexUnsafe()` currently swallows terminal creation failure. Fix that signal before
  using `ftsAvailable` or maintenance success as upgrade evidence.
- A binary downgrade is not necessarily a store rollback. Prove 0.30 can consume 0.31 writes,
  or retain a coherent LanceDB + MetaCache rollback snapshot.

## Hypotheses

| ID | Hypothesis | Falsifier |
|---|---|---|
| H1 | LanceDB 0.31 eliminates the FTS merge panic under production-shaped churn. | Any matching panic in a qualifying candidate soak. |
| H2 | Schema, FTS, exact-vector, scalar-index, stats, version, and optimize contracts remain compatible. | Compile/runtime mismatch or result-contract drift. |
| H3 | Arrow 18.1.0 remains compatible and need not move. | Peer, install, type, or runtime failure. |
| H4 | A store written by 0.31 remains safely readable and writable by 0.30. | Any downgrade open/search/write/optimize failure. |
| H5 | Fragments, versions, and disk bloat converge after writes stop. | Thresholds are not met within two maintenance opportunities. |

## Execution Phases

### Phase 0 - Baseline And Evidence

Capture Git SHA, Node/pnpm/OS architecture, exact package integrities, retained panic log
windows, doctor metrics, and deterministic scoped search probes. Record rows, fragments,
versions, logical/disk bytes, free space, panic/rebuild counts, and result IDs/order.

**Go:** evidence is reproducible and disk can hold an isolated store copy plus compaction
headroom. **No-go:** low/critical disk, inconsistent snapshot, unexplained corruption, or no
coherent rollback capacity.

### Phase 1 - Dependency-Only Candidate

Pin only LanceDB `0.30.0 -> 0.31.0`; retain Arrow 18.1.0. Audit `createIndex`, FTS config,
`listIndices`, `indexStats`, `stats`, `version`, `listVersions`, repeated `.where()`, and
`optimize()` behavior. The lockfile may move only LanceDB and its native packages.

**No-go:** Arrow movement, accidental 0.32+, unsupported native target, or unexplained
transitive dependency changes.

### Phase 2 - Real-Store Compatibility Harness

Add synthetic, zero-model tests that create and reopen the real table; insert/update/delete;
evolve schema; build positional FTS; verify sibling-prefix exclusion; run exact vector search
with ANN bypassed; create the path btree; inspect all index/stats/version return shapes; optimize
twice; and prove terminal FTS creation failure remains visible. Exercise IVF_FLAT only as API
compatibility coverage, never as a production-default change.

**Go:** focused real-store tests, full suite, both typechecks, Biome, and build pass on supported
Node release lanes. **No-go:** native crash, result drift, swallowed failure, or adaptation that
changes ranking semantics.

### Phase 3 - Bidirectional Store Compatibility

Using disposable copies, test `0.30 -> 0.31`, `0.31 -> 0.31`, and `0.31 -> 0.30`. Each lane
must open, inspect schema, search FTS/vector paths, write, create indexes, optimize, and reopen
with stable IDs, scopes, counts, and schema.

If downgrade fails, production requires a verified coherent snapshot/restore of LanceDB and
MetaCache together. Without that proof, stop.

### Phase 4 - Production-Shaped Isolated Soak

Run 0.30 baseline and 0.31 candidate against separate copies of one quiescent snapshot. Generate
direct-store add/delete/update churn without embeddings until each sees at least 50 small
fragments, 100 maintenance iterations, and 12 qualifying high-fragment optimize cycles. Capture
panic text, latency, RSS, result hashes, bytes, fragments, and versions.

**Go:** zero candidate panics/rebuild-exhaustion events, zero correctness mismatches, and
post-write convergence. **No-go:** any panic, crash, corruption, cross-project result, hash drift,
or non-convergence.

### Phase 5 - Live Whole-Store Rollout

Requires explicit operator approval and a rollback checkpoint. Observe at least seven days,
12 qualifying maintenance passes after real watcher churn, and three material growth/convergence
cycles. Do not start the summarizer, LLM server, or any unrelated model during validation.

Stop immediately on a native panic, rebuild exhaustion, corruption, daemon crash, terminal index
conflict, scoped-search leak, golden-probe drift, or unexplained disk growth above 25%.

## Acceptance

- No FTS merge panic during the qualifying isolated and live soaks.
- After writes stop: small fragments <=10, versions <=50, and disk/logical ratio <=2.0
  within two maintenance opportunities, followed by two stable observations.
- Exact search, FTS fusion, path scoping, and doctor diagnostics remain correct.
- Full tests, both typechecks, Biome, build, and live daemon smoke pass.
- No local summarizer or large LLM is loaded during validation.

## Rollback

1. Keep the 0.30 dependency commit deployable.
2. Stop all store users and acquire the exclusive store lease.
3. Snapshot LanceDB, MetaCache, project registry, config, lockfile, and evidence timestamps.
4. If downgrade compatibility passed, restore binaries and verify search/write/optimize.
5. Otherwise restore LanceDB and MetaCache together; never restore only the vector store.
6. Run coherence/catchup checks and compare the golden search probes.
7. If coherent restore is unproven, rollback means a controlled full rebuild.

## Evidence Record

Each phase records commit and package integrities, snapshot checksums, commands/results,
workload seed and operation counts, before/after store metrics, panic/conflict/rebuild counts,
golden-result hashes, gate decision, operator, timestamp, and rollback outcome.

## Non-Goals

- Re-enabling IVF_FLAT ANN.
- Changing ranking or embedding models.
- Treating available disk space as proof that recurring panics are harmless.
- Upgrading Apache Arrow in the same experiment.

## Version History

- **2026-08-04** Created after the all-plan refresh confirmed post-v0.26.4 panic recurrence.

## Closeout

<!-- Fill when the vendor upgrade/remediation and live soak are complete. -->
