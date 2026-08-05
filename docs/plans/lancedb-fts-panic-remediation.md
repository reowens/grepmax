---
type: plan
status: in-session
created: 2026-08-04
updated: 2026-08-04T20:44:56Z
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
  - docs/2026-08-04-macos-kernel-zone-panic-incident.md
current_state: >
  Phases 0-3 are green. In the isolated Phase 4 soak, LanceDB 0.30 produced one recoverable
  FTS optimize panic while 0.31 produced none across 100 iterations and 12 qualifying cycles;
  both had zero correctness mismatches. The host kernel panicked 16 seconds after the 0.31
  summary with a recurring APFS/EndpointSecurity data.kalloc.1024 exhaustion, so Phase 4 is
  no-go and no live rollout is permitted.
next_step: >
  Preserve the panic reports and harness, correlate the recurring kernel-zone leak with Apple
  and EndpointSecurity diagnostics, and define a low-I/O reproduction or OS/vendor escalation
  path. Do not rerun the soak, deploy LanceDB 0.31, or perform additional bulk APFS churn.
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

### 2026-08-04 Candidate Gate

- Baseline commit: `55c2fca75952bcc3888578ab79bb59eab7e40351`; Node `v26.5.1`,
  pnpm `10.33.0`, Darwin `25.5.0` arm64.
- Baseline store: 306,555 rows, 45 fragments/44 small, 193 versions, 8.1 GB logical,
  16.6 GB disk, 198 GB free, and 12 retained optimize-panic/rebuild-exhaustion episodes.
- Candidate packages: `@lancedb/lancedb@0.31.0` integrity
  `sha512-EUEVpheKhaCNE6ybcW760OUyfeei2dKR2ZwgLWeC/ntHL4BBiBLIErh9fuEuUP3/mAx4B5UFraB2m5nDUx5XEA==`;
  Darwin arm64 native package integrity
  `sha512-6n3VxAenwcNWQpk9Ta4NL/KhpSywskafarBakzFPGe/OXzdKXbmbXdrhGdl8oMacbfgql6wmW3DcAJAbsiThvw==`;
  `apache-arrow@18.1.0` retained at
  `sha512-v/ShMp57iBnBp4lDgV8Jx3d3Q5/Hac25FWmQ98eMahUiHPXcvwIMKJD0hBIgclm/FCG+LwPkAKtkRO1O/W0YGg==`
  within LanceDB's `>=15.0.0 <=18.1.0` peer range.
- Dependency diff is limited to LanceDB and its native packages. LanceDB's optional OpenAI 4
  and Transformers 3 integrations are excluded; direct OpenAI 6 and Transformers 4 remain.
- Terminal FTS create/rebuild failures are observable. Focused recovery and real-store gate:
  2 files / 8 tests pass. The real store covers positional FTS, exact vector search with ANN
  bypass, sibling-prefix exclusion, repeated filters, path btree, IVF_FLAT API creation,
  index stats, schema evolution, update/delete, versions/stats, repeated optimize, and reopen.
- Bidirectional disposable-store probe passed: 0.31 created/searched/wrote/optimized; 0.30
  reopened/searched/wrote/optimized that store; 0.31 reopened and verified the 0.30 writes.
- Deterministic checks pass: production typecheck, test-source typecheck, Biome over 309 files,
  and build. Full test result is 124 files / 1037 tests passed with one independent failure:
  `tests/directory-delete.test.ts` cannot start an FSEvents stream. The failure reproduces
  alone and with one worker before LanceDB behavior is exercised; file-descriptor limit is
  1,048,576. Phase 2 remains blocked until this platform canary and the full suite pass.
- `pnpm audit --prod` reports 5 moderate and 8 high findings only through unchanged existing
  dependency paths, not LanceDB. The existing top-level `overrides.mathjs` is not applied by
  pnpm and is a separate dependency-policy follow-up.
- Gate decision: Phase 0 go; Phase 1 go; Phase 2 blocked on host FSEvents health; Phase 3
  compatibility evidence passes but does not override the Phase 2 block; Phase 4 not started.
  No live store, daemon binary, summarizer, or local LLM was changed or started.
- Follow-up at `2026-08-04T12:01:09Z`: the FSEvents canary passed alone (1 file / 2 tests),
  then the full suite passed (125 files / 1038 tests). Phase 2 is now go; Phases 0-3 are green;
  Phase 4 is ready but has not started. The earlier failure is classified as transient host
  contention, not candidate behavior.

### 2026-08-04 Isolated Soak And Kernel No-Go

- Commit `874dfe1` contains the LanceDB 0.31 candidate, compatibility and downgrade probes,
  FTS terminal-failure signaling, and deterministic gate evidence. The live daemon and shared
  store remained on the existing runtime.
- A coherent 17 GB source snapshot was taken while the daemon was paused, with LanceDB,
  MetaCache, project registry, and config copied together. The daemon was then restarted
  unchanged. Separate APFS copy-on-write stores were used for the two runtimes.
- The identical 100-iteration workloads each included 12 qualifying cycles above 50 fragments.
  LanceDB 0.30 recorded one FTS optimize panic, recovered by rebuilding FTS, and recorded zero
  correctness mismatches. LanceDB 0.31 recorded zero FTS optimize panics, zero rebuild failures,
  and zero correctness mismatches.
- The 0.31 process emitted its successful summary at `2026-08-04T13:05:15Z`. The kernel panicked
  at `2026-08-04T13:05:32Z`, 16 seconds later. This is a Phase 4 crash and therefore a no-go even
  though the candidate's user-space FTS result was better than the baseline.
- The panic exhausted `data.kalloc.1024` at approximately 20 GB / 21.2 million allocations.
  Its backtrace includes APFS `2811.121.1` and EndpointSecurity `1.0`; the panicked task was
  `opencode.exe` PID 44169. This identifies the allocation path active at exhaustion, not the
  process or component that accumulated the leaked allocations.
- The prior report from August 3 has the same macOS `25F84` / Darwin `25.5.0` build, panic text,
  APFS/EndpointSecurity backtrace, and `opencode.exe` panicked task (PID 31547), exhausting the
  same zone at approximately 19 GB / 20.9 million allocations.
- Jetsam diagnostics show the same zone was already the largest at 5.3 GB on July 28, 10.2 GB
  on July 29, 11.5 GB on August 1, and 19.7 GB before the August 3 panic. The leak therefore
  predates this LanceDB 0.31 soak; filesystem churn may accelerate it, but ownership is unproven.
- Retained diagnostics:
  `/Library/Logs/DiagnosticReports/panic-full-2026-08-03-152634.0002.panic` and
  `/Library/Logs/DiagnosticReports/panic-full-2026-08-04-060621.0002.panic`.
- The reboot cleared the temporary root containing the coherent snapshot, isolated stores,
  runtimes, and NDJSON files. No bulk cleanup remains. The soak harness remains at
  `scripts/lancedb-fts-soak.mts`; the summary values above were captured before the crash.
- Gate decision: Phase 4 no-go. Do not begin Phase 5, rerun the heavy soak, or deploy 0.31 until
  the kernel-zone leak is understood or validation can run on an unaffected host/OS build.

## Non-Goals

- Re-enabling IVF_FLAT ANN.
- Changing ranking or embedding models.
- Treating available disk space as proof that recurring panics are harmless.
- Upgrading Apache Arrow in the same experiment.

## Version History

- **2026-08-04T20:44:56Z** Recorded the isolated soak result and recurring kernel-panic no-go.
- **2026-08-04T12:01:09Z** Cleared the FSEvents blocker; full suite passes and Phase 4 is ready.
- **2026-08-04T11:39:21Z** Recorded Phases 0-3 candidate evidence; Phase 2 blocked by host FSEvents canary.
- **2026-08-04T11:28:13Z** Started (active → in-session).
- **2026-08-04** Created after the all-plan refresh confirmed post-v0.26.4 panic recurrence.

## Closeout

<!-- Fill when the vendor upgrade/remediation and live soak are complete. -->
