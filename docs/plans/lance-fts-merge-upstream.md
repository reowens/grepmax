---
type: plan
status: active
created: 2026-08-05T22:15:40Z
updated: 2026-08-05T22:15:40Z
surfaces:
  - store
modules:
  - src/lib/store/vector-db.ts
domain: upstream lance-index FTS incremental-merge out-of-bounds panic
audience: internal
parent_plan: docs/archived/lancedb-fts-panic-remediation.md
related_plans:
  - docs/archived/stability-cycle-v0.26.2.md
related_docs:
  - docs/2026-08-04-macos-kernel-zone-panic-incident.md
current_state: The FTS merge panic is an upstream out-of-bounds in lance-index 7.0.0 at scalar/inverted/builder.rs:856, identical in LanceDB 0.30 and 0.31 because both bundle the same crate. Twenty-six retained backtraces show the index exceeding the buffer length by +89 to +2006, with length growing monotonically — a stale-length read during incremental merge. The local drop-and-rebuild guard absorbs it without correctness loss; v0.26.6 ships on 0.31.
next_step: File the upstream issue against lancedb/lance with the backtrace set, overshoot table, and workload shape. Then evaluate whether disabling incremental FTS merge in favour of periodic full rebuild removes the panic locally while upstream is pending.
summary: Pursue the upstream fix for the FTS merge panic that no LanceDB version bump can address.
---

# Lance FTS Incremental-Merge Panic — Upstream Pursuit

## Problem

`table.optimize()` panics inside Lance's incremental FTS merge with an out-of-bounds slice index.
Both LanceDB 0.30 and 0.31 bundle `lance-index 7.0.0`, so the defect is version-invariant from
this project's side. The predecessor plan tried and failed to remediate by version bump.

## Evidence

All 26 retained backtraces are the same assert:

```
thread 'tokio-rt-worker' panicked at
  lance-index-7.0.0/src/scalar/inverted/builder.rs:856:57:
index out of bounds: the len is 762714 but the index is 762844
```

- 13 distinct `len` values, each panicking twice — once on `optimize()`, once on the guard's
  rebuild retry.
- The index exceeds `len` in every occurrence. Overshoot spans +89 to +2006.
- `len` grows monotonically across occurrences (762,714 → 782,226), tracking index growth.
- Trigger shape: a table accumulating more than ~50 small fragments, then `optimize()` with
  `cleanupOlderThan` set.

Interpretation: the index is computed against a newer generation of the token dictionary than
the buffer was sized for. Varying overshoot fits tokens being added between the length capture
and the index computation.

## Workstream

### 1. Upstream report

File against `lancedb/lance` with the backtrace set, overshoot table, workload shape, store
dimensions (306k rows, ~780k tokens, 45 fragments), and versions. Link the LanceDB issue if the
maintainers prefer it there.

### 2. Local mitigation evaluation

Assess replacing incremental FTS merge with periodic full rebuild. The guard already performs a
full rebuild on panic and it consistently succeeds, which suggests full rebuild is not affected.
Measure rebuild cost at production scale before considering it as a default.

### 3. Retry headroom

One `createFTSIndex` conflict exhausted all five retries during post-restart catchup with many
projects reindexing concurrently. Decide whether the ladder needs more headroom, or whether
catchup should serialize FTS index creation.

## Non-Goals

- Further LanceDB version bumps as a remedy for this panic.
- Re-running the heavy production-shaped soak.
- Re-enabling IVF_FLAT ANN.

## Acceptance

- Upstream issue filed with reproducible evidence.
- A decision recorded on incremental-merge versus periodic rebuild, with measured cost.
- No FTS panic reaches a state where search is unavailable.

## Version History

- **2026-08-05T22:15:00Z** Created as successor to the closed LanceDB 0.31 remediation plan.
