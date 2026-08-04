---
type: plan
status: planned
created: 2026-06-23T09:46:05Z
updated: 2026-08-04
surfaces:
  - index
  - embeddings
  - store
  - daemon
modules:
  - src/lib/store/vector-db.ts
  - src/lib/workers/orchestrator.ts
  - src/lib/index/index-config.ts
  - src/config.ts
domain: embedding-model migration (background re-embed + atomic cutover)
audience: internal
parent_plan: docs/archived/2026-06-23-index-versioning-and-daemon-refactor.md
related_plans:
  - docs/plans/2026-05-25-semantic-search-landscape.md
  - docs/archived/2026-07-08-health-backlog.md
  - docs/archived/2026-07-09-repository-audit-fixes.md
related_docs:
  - ../archived/agent-ux-proposals.md
  - docs/embedding-layout-decision.md
  - docs/2026-07-09-repository-audit.md
current_state: >
  Safe coordination prerequisites and immutable embedding-generation handling are complete,
  and a guarded destructive whole-corpus rebuild exists. Zero-downtime staging, concurrent
  target-model MLX service, query routing, and atomic publication remain unimplemented. The
  available 768d tier is not a trigger because it benchmarked materially worse than 384d.
next_step: >
  Do not implement yet. First select and benchmark a concretely superior model, then decide
  per-project versus whole-corpus migration. Default to a whole-corpus staged-table cutover
  unless product requirements justify permanent multi-generation routing.
---

# Embedding Reembed Atomic Cutover

> Spun out of `docs/archived/2026-06-23-index-versioning-and-daemon-refactor.md`
> (Phase 1B) on 2026-06-23 when that plan was archived. Phases 1A/2/3 shipped in
> **v0.18.0**; this is the one deferred piece. **Do NOT start until a meaningfully
> better embedding model is actually chosen AND the table-layout decision below is
> made** — building the migration machinery before either is speculative.

The repository-audit Phase 8 guarded rebuild is deliberately separate. It restores an explicit,
whole-corpus destructive repair path for the current shared-table layout; it does not provide
background per-project migration or zero-downtime atomic cutover and does not satisfy this plan's two
product gates.

## Problem

Embeddings have no graceful versioning. A model/dimension change is detected, but the shared
  fixed-width table cannot safely accept the new generation in place. Guarded whole-corpus rebuild is
  available, but there is no supported automatic or zero-downtime migration until staging and
  cutover semantics are implemented.

Phase 1A (shipped in v0.18.0) made the mismatch *visible* — `describeEmbeddingGap`,
`maybeWarnStaleEmbedding`, a `gmax doctor` "Stale embedding" block, and a cross-project
dim guard — but visibility only. Phase 1B is the actual migration machinery: upgrade a
project's embedding model **without a global blow-away**, via background re-embed +
atomic cutover.

## Constraints / The Blocker

- **Fixed-dim shared table.** `src/lib/store/vector-db.ts` stores `vector` as a
  `FixedSizeList(this.vectorDim, Float32)` (`vector-db.ts:299-306`) in ONE shared `chunks`
  table (`TABLE_NAME = "chunks"`, scoped by path prefix); the Arrow schema dim is immutable
  post-creation, and `evolveSchema()` only adds *list* columns — it cannot change the vector
  dim. A dim-changing swap (e.g. small 384 → standard 768) cannot coexist with existing
  vectors. Phase 1B **must first pick a layout**: (a) per-project tables, (b) a second
  nullable vector column of the new dim + query-time branch, or (c) a second table + atomic
  swap. Same-dimension replacements still require staging because in-place background writes
  would expose mixed generations before cutover.
- **Layout is coupled to migration granularity** — the unnamed tension that decides Gate 2.
  The shared `chunks` table holds *all* projects. A **per-project** `gmax reembed <project>`
  must hold the migrating project's new-dim vectors *alongside* other projects' old-dim
  vectors → forces (a) or (b). The simple option (c) full-table atomic swap only works for a
  **whole-corpus** migration (every project at once). So pick the granularity first; the
  layout follows. Full options analysis + recommendation: `docs/embedding-layout-decision.md`.
- Don't change stamp *semantics* — only `--reset`/full-sync stamps, exactly as the
  chunker-version + Phase 1A work did.

## Decision Gates

1. **Model gate.** Freeze a full `EmbeddingGenerationConfig`, not only a tier. Require a
   held-out quality win plus acceptable MLX/ONNX parity, query/index latency, RAM, Metal, disk,
   and fallback behavior. A custom MLX generation without compatible ONNX fallback must be
   accepted explicitly as an availability tradeoff.
2. **Granularity gate.** Choose whole-corpus migration or permanent per-project generations.
   Whole-corpus is the default recommendation because current daemon/search resources are singular.
3. **Cross-project gate.** Decide whether `search-v2` may span generations. Dense and ColBERT
   scores from different models are not directly comparable; reject mixed-generation requests
   unless a separately tested normalization/merge contract exists.
4. **Capacity gate.** Measure headroom for staging rows, rollback retention, compaction, and a
   second MLX process. Starting another model requires explicit operator approval.
5. **Layout gate.** Stage every generation-dependent field (`vector`, quantized ColBERT,
   scale, pooled ColBERT, and token IDs), not only the dense vector.

## Recommended Architecture

Use complete generation-partitioned tables (`chunks__<fingerprint>`) plus an atomic route.
For the simpler whole-corpus case, one staged table becomes the new global route. If per-project
migration is required, the registry must atomically carry both full generation identity and the
physical table route, and the daemon must support a durable multi-generation resource snapshot.
A second nullable vector column is insufficient because ColBERT fields and query embedders are
also generation-specific.

Background staging must leave active registry identity, route, watcher, and MetaCache decisions
unchanged. Use a generation-scoped cache namespace or separate staging LMDB. Publication captures
one immutable snapshot containing project routes, store handles, query pools, and MLX endpoints;
search and writes must never assemble those pieces from independently mutable fields.

## Invariants

- Registry identity and physical route always name the same complete generation.
- Active project rows never mix embedding fingerprints.
- Staging cannot change active search, watcher, or cache behavior.
- Every admitted operation captures one route/store/pool/endpoint snapshot.
- Every write is generation-routed; global config never silently chooses its destination.
- Publication waits for `OperationCoordinator` and interprocess lease readers to drain.
- No registry route points to an unverified or missing table.
- Configuration changes during staging pause or invalidate the operation; they never retarget it.

## Phases

### Phase 1B — Embedding re-embed + atomic cutover ⬜ (DEFER — gated on a chosen model + layout decision)

- **Extend embedding identity, don't add a parallel version list.** Identity is now a full
  generation fingerprint covering tier, dimension, ONNX model, MLX model, and ColBERT model.
  Reuse that contract and immutable resource generation; do not introduce a parallel history.
- **Background re-embed worker:** stream a project's chunks through the new model into
  staging (new table or new-dim column, per the layout decision).
  - *CPU/ONNX path:* construct a separate pool/orchestrator with the immutable target
    `EmbeddingGenerationConfig`; do not mutate a live worker's model tier.
  - *GPU path (the default, and the real work):* the actual embedder is the **MLX server**
    (`mlx-embed-server/server.py`), which loads ONE model from `MLX_EMBED_MODEL` for its
    process lifetime — `orchestrator` just POSTs to port 8100. Re-embedding to a new model
    therefore means standing up the **target** model on MLX, most cleanly as a *second* MLX
    instance on another port (extend `mlx-server-manager.ts`) so the live index keeps serving
    the old model on 8100 during the background re-embed. This is the largest piece and the
    orchestrator hook alone does NOT cover it.
  - Orchestration lands in a new daemon `reembed-manager.ts` — clean home alongside the
    Phase 2 managers (`process-manager.ts` / `mlx-server-manager.ts` / `watcher-manager.ts`).
- **Atomic cutover** must reuse `OperationCoordinator`, the interprocess store lease,
  rebuild journal/CAS stamping, and immutable resource-generation publication. Publish staged
  rows/table plus project identity as one guarded transition; never expose mixed generations.
- **New CLI:** `gmax reembed <project> --to-model <tier> [--background]`; redirect
  `doctor`'s recovery hint here instead of `gmax index --reset`.

## Execution Sequence

1. **Foundation:** parameterize table names; add generation-aware project routes and cache
   namespaces; introduce an immutable resource snapshot while preserving current behavior.
2. **Target resources:** manage MLX instances by model/port and inject the endpoint into an
   immutable target `WorkerPool`; never mutate a live pool's generation or port.
3. **Durable staging:** create a migration journal before target writes, scan authoritative
   source files into the target table, and checkpoint source fingerprint plus file hashes.
4. **Reconciliation:** quiesce the affected watcher(s), drain admitted operations, and replay
   changed/deleted files against the checkpoint. Verify paths, rows, dimensions, and fingerprint.
5. **Publication:** acquire the exclusive lease, construct and validate the target snapshot,
   CAS registry identity + route, publish resources, invalidate cached searchers, resume watchers,
   and retain the old generation for rollback.
6. **Cleanup:** only after the acceptance soak, retire unreferenced pools/MLX instances, tables,
   and cache namespaces under the exclusive lease.

## Durable Recovery

Use explicit journal phases: `staging -> staged -> reconciling -> publishing -> published -> cleaning`.

- Before `publishing`, abort or resume staging; active routing is untouched.
- During `publishing`, inspect the atomic registry route: old means resume/abort before cutover;
  target means reconstruct target resources and roll forward.
- After `published`, default to roll-forward. Automatic rollback can lose post-cutover writes
  unless the old generation is reconciled again.
- Missing routed tables, ambiguous journals, resource construction failure, or lease downgrade
  failure must set daemon readiness false and fail closed.

## Non-Goals

- Choosing the model (Granite v2 / Qwen3-embed / etc.) — that's the trigger, out of scope
  until selected.
- No search-quality / ranking changes.

## Acceptance

- Same-dimension and dimension-changing migrations never expose mixed vectors or ColBERT fields.
- Target resource/model failure leaves active search unaffected and staging resumable.
- Source edits/deletes during staging are reconciled before publication.
- Daemon crash recovery is deterministic at every journal phase.
- Registry CAS rejects changed source fingerprints or routes.
- Concurrent add/remove/index/reembed operations serialize or return a clear busy response.
- Cross-generation search is either rejected or merged under a measured normalization contract.
- Old-generation cleanup cannot run while any project route references it.
- Disk exhaustion leaves active generation untouched.
- Full tests, both typechecks, Biome, build, quality/latency gates, and a live rollback drill pass.

## Closeout

Still planned and double-gated. Coordination prerequisites are complete, but no replacement
model has beaten the 384d baseline and no migration granularity/layout has been selected.

## Version History

- **2026-08-04** Refreshed for full embedding-generation fingerprints, immutable target
  worker configuration, existing coordinator/lease/journal primitives, and the requirement
  to stage even same-dimension replacements.
