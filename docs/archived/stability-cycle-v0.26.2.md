---
type: plan
status: archived
created: 2026-07-13
updated: 2026-08-04T11:07:43Z
surfaces:
  - daemon
  - index
  - store
  - workers
  - search
modules:
  - src/lib/daemon/daemon.ts
  - src/lib/daemon/watcher-manager.ts
  - src/lib/index/batch-processor.ts
  - src/lib/index/syncer.ts
  - src/lib/store/meta-cache.ts
  - src/lib/store/vector-db.ts
domain: v0.26.2 post-release stability and index-integrity validation
audience: internal
related_plans:
  - 2026-07-09-repository-audit-fixes.md
  - ../plans/lancedb-fts-panic-remediation.md
related_docs:
  - ../2026-07-09-repository-audit.md
current_state: >
  Historical v0.26.2-v0.26.5 stability cycle. SC-001 and SC-003 were fixed and live-verified;
  SC-002 recovery shipped and restored compaction, but FTS merge panics recurred repeatedly
  through 2026-08-03. The dated observation window and formal exit snapshot were never
  completed, and the 2026-08-04 watcher/index/store changes supersede this baseline.
next_step: >
  None in this versioned cycle. Continue the recurring FTS panic and maintenance-convergence
  work in docs/plans/lancedb-fts-panic-remediation.md.
summary: Time-boxed v0.26.2 stability cycle for daemon, watcher, cache/vector coherence, disk pressure, and store growth.
---

# v0.26.2 Stability Cycle

## Goal

Prove that the repository-audit integrity work remains stable under normal multi-project use before
starting another feature phase. This is an observation and fault-containment cycle, not a search
ranking or architecture build.

## Duration And Coverage

The cycle exits only after both conditions hold:

1. At least seven calendar days have elapsed on `v0.26.2` or newer patch-only fixes.
2. Normal edit, delete, rename, ignore-policy, daemon-restart, and catchup activity has occurred on at
   least three representative project shapes: one large TS/JS monorepo, one medium application, and
   one non-TS repository.

A patch made to fix a cycle finding restarts the seven-day clock for the affected lane. Documentation
or test-only changes do not restart it.

## Guardrails

1. Do not fill or constrain the host filesystem to manufacture `ENOSPC`.
2. Do not run `repair --rebuild`, reset all projects, or mutate the live store solely for this cycle.
3. Do not start the summarizer, llama-server, or another large local model.
4. Do not reopen PPR, HyDE, query expansion, semantic cache, graph-distance reranking, broad template
   parsing, or embedding migration without separate measured evidence and approval.
5. Preserve the store and logs when corruption is suspected. Diagnosis comes before destructive
   recovery.

## Lane 1: Release Baseline

Capture once at cycle start and again at exit:

```bash
gmax --version
gmax status --agent
gmax doctor --agent
du -sk "$HOME/.gmax/lancedb"
```

Record:

- installed CLI version and daemon version
- project counts by watching, pending, degraded, error, and embedding generation
- doctor warnings and stale project counts
- LanceDB size in KiB
- daemon PID/start time and whether any unexpected recycle occurred

## Lane 2: Normal Workload

Use ordinary development activity rather than synthetic churn. Confirm each behavior at least once:

| Behavior | Expected result |
|---|---|
| Edit an indexed source file | One bounded reindex; project returns to watching. |
| Delete or rename an indexed file | Old path disappears from search and metadata. |
| Add then remove an ignore rule | Catchup converges without a repeated orphan loop. |
| Restart the daemon normally | Catchup completes; no duplicate daemon or orphan worker remains. |
| Leave projects idle | Worker pool returns to its idle floor; daemon remains responsive. |
| Search during catchup | Results remain scoped and expose partial-index state when applicable. |

For each representative project, run one known semantic query and one graph query (`trace`, `dead`,
or `impact`) before and after the workload. Record only regressions or unexpected differences; this
cycle is not a benchmark retuning pass.

## Lane 3: Disk-Pressure Safety

The automated regression lane is mandatory and safe to repeat:

```bash
npx vitest run tests/project-batch-processor.test.ts tests/vector-db-exclusive-mutation.test.ts tests/daemon-remove.test.ts
```

It must continue to prove:

- critical pressure permits authoritative file, policy-exclusion, and project-prefix logical deletes
- mixed batches dispatch no workers for deferred growth events
- deferred events retain retry budget and retry after environmental backoff
- logical deletes open only an existing table and never create or evolve a schema
- `ENOSPC` leaves LMDB metadata intact and requeues the deletion
- failed project removal restores a watcher that existed before removal
- compaction does not run from a critical-pressure deletion-only batch

If real critical pressure occurs naturally, capture status and logs but do not induce more writes.
Logical deletion corrects search-visible state; it does not promise physical space reclamation until
compaction can run after pressure improves.

## Lane 4: Logs And Store Growth

Review the daemon log after meaningful activity for these signals:

```bash
rg "Disk critically low|Disk pressure|ENOSPC|DATA CORRUPTION|Batch processing failed|Failed to re-watch|orphan worker" "$HOME/.gmax/logs/daemon.log"
```

Track LanceDB size at baseline, after large catchup activity, and at exit. Growth is not itself a
failure because new vectors and LanceDB versions consume space. Investigate before exit when size
grows by more than 25 percent without a corresponding corpus increase, or when compaction repeatedly
fails to reduce obvious version bloat after pressure returns to `ok`.

## Stop Conditions

Stop normal cycle progression and open a focused fix when any of these occurs:

1. A failed logical delete removes LMDB metadata or loses the retry event.
2. A failed project removal leaves a previously watched project unwatched.
3. A deleted, ignored, or renamed path remains searchable after catchup settles.
4. A project enters a repeated catchup/reindex loop without new filesystem activity.
5. LanceDB reports corruption, the daemon repeatedly crashes/recycles, or multiple daemon instances
   survive singleton checks.
6. A project remains pending/degraded after the triggering condition is gone and bounded retries have
   elapsed.
7. A completed zero-work batch leaves the project reported as `indexing` with no pending work.

For a stop condition, preserve the smallest reproducer, relevant log window, project status, store
size, and exact version. Add a regression before changing production code.

## Evidence Log

| Date | Version | Projects/workload | Status and store delta | Incidents/findings |
|---|---|---|---|---|
| 2026-07-13 | 0.26.2 | Baseline; graceful daemon restart to PID 85936 | Initially 14/14 watching; embeddings current; 273,510 rows; 7.2 GB logical / 12.4 GB disk; 102.9 GB free; pressure ok; 8 fragments; 27 versions; 0 orphan workers | Capstone is additively stale at chunker v3 vs v4; no reset performed. SC-001 reproduced after baseline. |
| 2026-07-13 | 0.26.2 + unreleased fix | SC-001 focused and full verification | 118 test files / 969 tests; both typechecks; Biome; build | Fix introduces an explicit batch-settled transition; live verification pending deployment. |
| 2026-07-14 | 0.26.3 | Patch deployment; daemon PID 13866; three ignored-document events | 14/14 watching; embeddings current; 274,499 rows at deployment; 7.4 GB logical / 10.7 GB disk; 93.8 GB free; pressure ok; 47 fragments; 181 versions; 0 orphan workers | SC-001 live-verified. Events at 04:09:38, 04:10:21, and 04:11:31 each logged `Batch complete: 1 files, 0 reindexed (0.0s)`; gmax returned to watching with no vector, metadata, worker, or daemon error. |
| 2026-07-16 | 0.26.4 | Patch deployment (FTS panic recovery + subrepo root resolution); graceful daemon restart | Pre-fix doctor: 26 fragments (25 small), 146 versions, 47.5 GB free — compaction wedged since 07-14. First post-fix maintenance tick at 12:18:15 compacted 23 frags → 1, pruned 70 versions, freed 11.4 GB (plus a 12:02 pass: 52 frags → 2, 275 versions, 9.5 GB). Free space 47.5 → 65 GB. | SC-002 opened and closed. Recovery path (FTS rebuild-on-panic) deployed but not yet exercised live — the wedge cleared on a data-dependent clean pass; the panic is intermittent. |
| 2026-07-16 | 0.26.5 | Patch deployment (lone-surrogate chunk repair); daemon PID 67128 (started 12:41); capstone v3→v4 reset reindex | 12/12 watching; embeddings current; 267,856 rows; 7.2 GB logical / 10.6 GB disk; 42.5 GB free; pressure ok; doctor clean (stale_chunker=0). Reindex churn compacted by three consecutive maintenance passes (12:49/12:50/12:56, ~31 GB of version bloat pruned); fragment/version counts fluctuate with platform watcher churn between ticks. | SC-003 opened and closed. First capstone reindex attempt (0.26.4) aborted: lone surrogate 500'd the embed batch and a concurrent daemon handoff aborted the run (registry correctly restored the v3 entry). Rerun on 0.26.5: 2137 files, 0 embed failures, chunker v4 stamped. Capstone stale-chunker note from the 07-13 baseline is resolved. |
| 2026-07-16 | 0.26.5 | SC-003 follow-up: read-only surrogate scan of the full live store (scripts/scan-surrogate-rows.js); no `Optimize panicked` in daemon.log since the 0.26.4 recovery shipped | 267,968 rows scanned across all 12 projects: 0 rows with lone surrogates; 13 rows (13 paths) contain U+FFFD — 8 faithful (source file holds a literal U+FFFD) and 5 split artifacts (astral char sliced mid-pair at a splitByChars boundary), one of which is capstone's post-fix reindex, proving pre-fix rows are byte-identical to current-chunker output. | Poisoned-row theory refuted at the byte level: apache-arrow's Utf8Builder (TextEncoder) substitutes U+FFFD for lone surrogates at write time (verified on the exact table.add path with raw .lance byte inspection — U+FFFD bytes, no WTF-8), so invalid UTF-8 never reached the store and there is nothing to `--fix`. The planned doctor check is not shipped; the scan script is kept for reruns. SC-002's root cause is unknown again. |

Earliest time-based exit is 2026-07-21 for the watcher lane (unchanged by 0.26.4/0.26.5, which do not touch batch settlement). The store and index-pipeline lanes restart from the 2026-07-16 patches: earliest exit for those lanes is 2026-07-23.

## Findings

| ID | Status | Observation | Next check |
|---|---|---|---|
| SC-001 | Closed; fixed and live-verified in v0.26.3 | On v0.26.2, editing ignored `docs/stability-cycle-v0.26.2.md` produced `Batch complete: 1 files, 0 reindexed (0.0s)` at `2026-07-13T22:33:48`, but `gmax status --agent` continued to report gmax as `indexing`. No vector, metadata, worker, or daemon error was logged. | The processor now emits a distinct batch-settled callback. Regression: `tests/watcher-manager.test.ts`. Three v0.26.3 live events settled with zero reindexed and returned to watching. Continue the watcher-health observation lane through the exit gate. |
| SC-002 | Closed; recovery shipped in v0.26.4, wedge cleared live | `table.optimize()` panicked intermittently from 2026-07-14T03:09 (`lance-index 7.0.0 scalar/inverted/builder.rs:856` index-out-of-bounds during the FTS incremental merge; 23 occurrences). Because optimize is all-or-nothing, compaction and pruning were blocked for two days: 26 fragments / 146 versions / ~21 GB of unreclaimed disk. | `optimize()` now rebuilds the FTS index from scratch on a Rust panic and retries once, with a latch that disables auto-rebuild until an optimize succeeds. Regression: `tests/vector-db-optimize-recovery.test.ts`. Watch `daemon.log` for `Optimize panicked` through the lane exit — the recovery path has not fired live (checked 2026-07-16). The SC-003 invalid-UTF-8 root-cause theory is refuted (see SC-003), so the panic's trigger is unknown; the capstone-timing correlation may still be data-dependent (e.g. token distribution of the PDF-derived corpus in the inverted-index merge), but not via malformed bytes. If it recurs, escalate to the lancedb 0.31 upgrade after lane exit. |
| SC-003 | Closed; fixed and live-verified in v0.26.5 | `splitByChars` slices by UTF-16 code-unit strides, so a chunk boundary inside a surrogate pair emitted a lone surrogate. The HF fast tokenizer rejects the whole batch (TypeError → HTTP 500), which killed the capstone v3→v4 reindex on files with PDF-derived math italics (478 astral chars in one file), and appeared to write invalid UTF-8 into the vector table's content column — at the time a plausible root cause for SC-002's inverted-index merge panics (capstone's v3 index landed 2026-07-14T00:33, first panic 03:09). | Chunker repairs lone surrogates to U+FFFD at the emit boundary; the MLX server sanitizes incoming texts as a second layer. Regressions: `tests/chunking.test.ts` (boundary-split reproduction). Live-verified: capstone rerun embedded 2137 files with 0 failures. Follow-up closed 2026-07-16 by refutation: the invalid-UTF-8 claim is wrong at the byte level. The Arrow JS write layer (apache-arrow Utf8Builder/TextEncoder) substitutes U+FFFD for lone surrogates at write time — verified on the exact `table.add` path by inspecting raw .lance bytes (U+FFFD present, WTF-8 surrogate bytes absent) — so ill-formed strings never reached disk on any gmax version. A full read-only scan of the live store (scripts/scan-surrogate-rows.js; 267,968 rows) found 0 lone-surrogate rows and 13 U+FFFD rows, all benign: 8 faithful to a literal U+FFFD in the source file, 5 mid-pair split artifacts byte-identical to current-chunker output (capstone's post-fix reindex reproduces one). No poisoned rows exist, so no doctor check or `--fix` ships; the pre-fix damage was confined to embed-batch 500s/ONNX fallback, both fixed. |

## Exit Gate

The cycle passes when:

1. All duration and representative-project coverage requirements are met.
2. `gmax status` shows every expected project watching with current embedding identity.
3. `gmax doctor` reports no unexplained integrity, watcher, generation, or disk warnings.
4. No stop condition remains open.
5. Store growth is explained by corpus growth or converges after normal maintenance.
6. The full release gate remains green: tests, both typechecks, Biome, production audit, build, and
   tarball inspection.

At exit, update the evidence row and this plan's `current_state`/`next_step`. A clean pass returns the
roadmap to measure-first feature selection. A failure produces only the smallest integrity patch
needed, followed by a new stability window for the affected lane.

## Closeout

SC-001 shipped in `1364e58`; SC-002 recovery shipped in `9b012b2`; SC-003 shipped in
`9f29870`. Current HEAD passes 124 test files / 1035 tests, both typechecks, and Biome,
but this cycle is archived without claiming its formal Exit Gate passed. Live logs show
SC-002 recurred after v0.26.4, so the unresolved vendor/index behavior moves to the
current LanceDB remediation plan rather than extending a version-specific observation window.

## Version History

- **2026-08-04T11:07:43Z** Archived — Historical cycle closed without claiming the formal exit gate; recurring FTS panic moved to successor plan.
