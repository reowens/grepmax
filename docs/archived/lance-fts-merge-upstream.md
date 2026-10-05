---
type: plan
status: archived
created: 2026-08-05T22:15:40Z
updated: 2026-10-05T02:45:51Z
surfaces:
  - store
modules:
  - src/lib/store/vector-db.ts
domain: upstream lance-index FTS incremental-merge out-of-bounds panic
audience: internal
parent_plan: lancedb-fts-panic-remediation.md
related_plans:
  - stability-cycle-v0.26.2.md
related_docs:
  - ../2026-08-04-macos-kernel-zone-panic-incident.md
  - docs/2026-08-25-release-triage-retrospective.md
current_state: Closed. lance-format/lance#8310 was fixed by lance#8312 (lance 11.0.0-beta.22); gmax pins @lancedb/lancedb 0.38.0 GA (lance 11.0.0). The 0.26.27/0.26.28 canary on the GA pin ran 2026-09-07 to 2026-09-16 with zero optimize failures, FTS rebuilds, or panics. The drop-and-rebuild guard stays as a tripwire.
next_step: None. A future FTS panic is a regression to report upstream against the GA line.
summary: Closed FTS merge investigation; the upstream fix shipped through the LanceDB 0.38.0 GA runtime and passed its live canary.
---

# Lance FTS Incremental-Merge Panic — Upstream Pursuit

## Historical problem and workstream — August 2026

The investigation below predates the shipped fix. See Outcome and Closeout for the final disposition; its triage and retry proposals are not outstanding work.

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

Filed 2026-08-05 as [lance-format/lance#8310](https://github.com/lance-format/lance/issues/8310)
with the backtrace, the full 26-row overshoot table, workload shape, store dimensions, and
versions. Note that `lancedb/lance` redirects to `lance-format/lance`. Awaiting triage; a
duplicate check by hand is still worth one glance, since `gh issue list --search` returned no
results for any query against that repo and may not be indexing it.

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

## Outcome

- **Step 1 (upstream):** fixed upstream by [lance#8312](https://github.com/lance-format/lance/pull/8312),
  released in lance `11.0.0-beta.22` and carried by lance `11.0.0` GA, which `@lancedb/lancedb 0.38.0`
  bundles.
- **Step 2 (local mitigation):** not needed. The panic is fixed at the source, so incremental merge
  stays; the guard's drop-and-rebuild remains as a tripwire.
- **Step 3 (retry headroom):** not pursued. The exhausted-retry case was one conflict during a
  many-project catchup; since 0.26.30 the daemon watches only session-leased projects, which shrinks
  that catchup, and the canary saw no recurrence.
- **Canary:** 2026-09-07 15:56 to 2026-09-16 on the GA pin, `Optimize failed|FTS rebuild failed|
  Periodic maintenance failed|Panic|Rebuilt FTS` = 0 in the daemon log.

## Closeout

Closed after the September 7–16 GA canary. The upstream fix is included in the pinned LanceDB 0.38.0 runtime; incremental merge remains enabled and the rebuild guard stays as a recovery tripwire. Periodic full rebuilds and a longer retry ladder were not adopted. A new panic on the current runtime is a regression to investigate, not a request to resume the historical workstream.

## Version History

- **2026-09-17T00:41:38Z** Archived.
- **2026-09-16T17:45:00Z** Closed after the GA canary; see Outcome.

- **2026-08-05T22:20:00Z** Filed upstream issue lance-format/lance#8310.
- **2026-08-05T22:15:00Z** Created as successor to the closed LanceDB 0.31 remediation plan.
