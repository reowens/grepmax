---
type: doc
status: active
created: 2026-06-23T10:00:03Z
updated: 2026-08-04
modules:
  - src/lib/store/vector-db.ts
  - src/config.ts
  - src/lib/utils/project-registry.ts
surfaces:
  - store
  - embeddings
  - index
domain: embedding-model migration — LanceDB table-layout decision (Phase 1B Gate 2)
audience: internal
related_plans:
  - docs/plans/embedding-reembed-atomic-cutover.md
  - docs/archived/2026-07-09-repository-audit-fixes.md
related_docs:
  - docs/archived/2026-06-23-index-versioning-and-daemon-refactor.md
  - docs/2026-07-09-repository-audit.md
---

# Embedding Layout Decision

> One-line summary of what this doc covers.

## Overview

## Context

Phase 1B of the embedding-reembed plan (`docs/plans/embedding-reembed-atomic-cutover.md`)
cannot start until the LanceDB **table-layout decision** is made. This doc analyzes the
options and records a recommendation, so that when a better embedding model is chosen (the
other gate) the first concrete step is already settled.

The constraint: `src/lib/store/vector-db.ts` stores `vector` as a
`FixedSizeList(this.vectorDim, Float32)` (`vector-db.ts:299-306`) in ONE shared `chunks`
table (`TABLE_NAME = "chunks"`), with every project's rows in that one table scoped by a
path-prefix `WHERE`. The Arrow schema dim is immutable after table creation; `evolveSchema()`
only adds *list* columns. So a **dim-changing** model swap (e.g. small 384 → standard 768)
cannot coexist with existing vectors in the current layout.

Embedding identity is now a full generation fingerprint covering tier, dimension, ONNX model,
MLX model, and ColBERT model. A safe route must select all generation-dependent resources and
stored fields, not only a vector dimension.

**Same-dimension swaps still require staging.** In-place background overwrites would expose
mixed generations before cutover even if Arrow widths match.

## Decision Driver: migration granularity comes first

The layout cannot be chosen in isolation — it is dictated by *granularity*:

- The plan's CLI is **per-project**: `gmax reembed <project> --to-model <tier>`.
- But the `chunks` table is **shared across all projects**.

So a per-project re-embed must hold the migrating project's NEW-dim vectors *alongside* the
other projects' OLD-dim vectors in the same table — which the current single fixed-dim column
cannot do. Whole-corpus migration (every project at once) avoids mixed dims and unlocks the
simplest layout. **Pick the granularity, and the layout follows.**

## Options

### (a) Per-project tables
Give each project its own table (`chunks__<hash>`); dim is per-table, so projects migrate
independently.

- **Pros:** clean isolation; no mixed-dim queries ever; drop/rebuild a project = drop a table;
  per-project dim is natural.
- **Cons:** largest code surface. Every `vector-db.ts` method, the search handler, the FTS
  index, and the maintenance loop assume ONE table scoped by prefix. Cross-project search
  becomes multi-table fan-out; FTS + compaction become per-table. Contradicts the deliberate
  shared-table design (CLAUDE.md: "One table, all projects share it, scoped by path prefix").

### (b) Parallel generation columns + query-time branch
This requires parallel dense vector, quantized ColBERT, scale, pooled ColBERT, and token-ID
columns for every generation, not merely `vector_v2`.

- **Pros:** stays in ONE table — preserves prefix scoping, single FTS, single maintenance loop.
  Supports **per-project** migration (matches the CLI): one project's rows flip to `vector_v2`
  while others are untouched. No table swap; reuses the existing write gate for the cutover.
  Phase 1A's per-project dim stamp already gives the searcher what it needs to pick the column.
- **Cons:** every generation multiplies several columns and query branches, complicates schema
  cleanup, and still requires generation-specific query pools/MLX endpoints.

### (c) Second table + atomic swap  ← recommended only if migrations are whole-corpus
Build `chunks_v2` at the new dim, re-embed ALL projects into it in the background, then
atomically cut over (repoint `TABLE_NAME` / drop the old table).

- **Pros:** simplest query path — after cutover the code is byte-identical (no branch, single
  dim). Clean mental model; reuses the write gate to drain before swap.
- **Cons:** **whole-corpus only** — cannot upgrade a single project, so it contradicts the
  per-project CLI. Long window where `chunks_v2` is incomplete; ~2× disk during migration.
  Needs an "all projects re-embedded" coordination state machine across a multi-project daemon
  (large repos like platform ~159k chunks make this a long pour).

## Decision Matrix

| Driver | (a) per-project tables | (b) second column | (c) second table swap |
|---|---|---|---|
| Per-project upgrades | ✅ | ✅ | ❌ (whole-corpus only) |
| Preserves shared-table design | ❌ | ✅ | ✅ (after swap) |
| Query-path complexity added | high (fan-out) | medium (column branch) | none (post-swap) |
| Code surface to build | largest | medium | small |
| Disk during migration | ~1× (isolated) | ~1.x (extra column) | ~2× (full copy) |
| Migration coordination | per-project | per-project | corpus-wide state machine |

## Recommendation

**If per-project upgrades are required, prefer generation-partitioned complete tables (a), keyed
by fingerprint.** This isolates all dense/ColBERT fields and supports rollback retention. It
requires explicit per-project routing and cross-project fan-out, which is the real cost of the
product choice rather than something a second vector column avoids.

**If we decide a model upgrade is inherently global (defensible — you rarely want two projects
on different embedding models long-term) → choose (c), second table + atomic swap**, and
simplify the CLI to `gmax reembed --all --to-model <tier>`. It is materially less code and
leaves the query path untouched.

The default recommendation is **(c), whole-corpus staged table cutover**, because it preserves
the current singular daemon/search architecture. Choose (a) only if independent per-project
migration justifies permanent multi-generation routing. Do not choose (b).

## Consequences / Follow-ups

- Whichever option, the re-embed worker and atomic cutover (write-gate drain) are shared work;
  only the storage target differs.
- The GPU embedder is the **MLX server** (one model per process); a dim-changing re-embed needs
  the target model stood up separately (see the plan's Phase 1B notes) regardless of layout.
- Same-dimension swaps use the same staging and publication protocol.

## Related

- `docs/plans/embedding-reembed-atomic-cutover.md` — the gated plan this decision unblocks
- `docs/archived/2026-06-23-index-versioning-and-daemon-refactor.md` — parent (Phases 1A/2/3, shipped v0.18.0)
- `src/lib/store/vector-db.ts` · `src/config.ts` (`describeEmbeddingGap`) · `src/lib/utils/project-registry.ts`

## Version History

- **2026-06-23T10:00:03Z** Created.
- **2026-08-04** Updated for full generation fingerprints and ColBERT state; recommendation
  changed from a second vector column to whole-corpus staged tables by default.

## Related Documentation
