# Docs

## Remaining Work Index

This is the repo-level active backlog. Archived docs may contain historical ideas, but the
items below are the ones still live or explicitly gated.

## Current Next

1. **Repository audit Phases 1-8, including Phase 4B, are complete and released.** `v0.26.0` shipped
   exact cache/vector coherence and `v0.26.2` shipped deletion-only critical-pressure behavior.
2. **The `v0.26.3` stability cycle is the current priority.** Run the seven-day observation,
   representative-workload, disk-pressure regression, and store-growth gates before selecting
   another feature project. `v0.26.3` shipped the SC-001 zero-reindex watcher-status fix, and three
   live ignored-document events returned the project to watching after settling with zero reindexed.
3. **Agent UX Phase 7 `impact` rollup MVP is implemented.** CLI file-target rollups, opt-in agent/MCP rollup
   TSV, package/export grouping, top-K caps, and `--flat` compatibility are in the working tree.
4. **Narrowed Phase 9 SQL-template skeleton MVP is implemented.** TS/JS skeleton summaries surface
   operation/table hints for hidden ``sql`...` `` tagged templates. The full GraphQL/SQL/CSS parser is
   intentionally not built.
5. **MCP search scope leak is archived.** Fresh MCP smoke from `qsys/qsys-training` and
   `qsys/docs` passed: default search stayed qsys-scoped; `scope:"all"` / `projects:"platform"`
   still opt into cross-project search.
6. **Do not reopen Graphify or semantic-ranking experiments by default.** Graphify is closed with
   `surprises` kept experimental; PPR/HyDE/query expansion/cache remain measurement-gated.

## Remaining Work

**Actionable now:**

1. Complete the [v0.26.2 stability cycle](stability-cycle-v0.26.2.md) on `v0.26.3` and record its
   representative-workload, integrity-observation, disk-pressure, and store-growth exit evidence.
2. No active Agent UX feature build target remains after Phase 7 rollup and narrowed Phase 9 SQL
   skeleton summaries. Phase 12 remains opportunistic refactor work only.

## Phase 7 Scope

**Status:** implemented in the working tree (2026-07-01). Phase 7 shipped as an `impact` rollup
layer, not as a new graph model.

**Why now:** `impact <file>` already works, but the output is a flat dependent-file list with only a
shared-symbol count. That under-serves the two empirical extremes from dogfooding: files with many
exports and files with very large dependent sets. The useful improvement is presentation and
aggregation over the data gmax already has.

**Implemented MVP behavior:**

1. Existing symbol-target output and existing `--agent` lines are preserved by default.
2. File targets in human output render a rollup view by default; `--flat` forces the old
   dependent-list view if needed.
3. `--rollup` works for symbol targets and for `--agent` mode so machine consumers opt into the new TSV
   shape explicitly.
4. `--top <n>` caps sampled dependents/tests per section; default is 10.
5. Existing `--no-tests` semantics are preserved: skip traversal and omit test sections entirely.
6. MCP `impact_analysis` accepts `rollup:true` and `top` and returns deterministic TSV rows.

**Implementation shape:**

1. Add a detailed dependent primitive in `src/lib/graph/impact.ts`, e.g.
   `findDependentsDetailed()`, that returns matched target symbols per dependent file instead of only
   `sharedSymbols`.
2. Add a pure rollup builder, e.g. `buildImpactRollup()`, that derives per-export counts, package
   groups, top dependents, and grouped tests from detailed dependents plus existing `findTests()`
   results.
3. Group packages with a conservative path heuristic: `packages/<name>` when present, otherwise the
   first stable directory bucket under the project root.
4. Add human and agent formatters in `src/commands/impact.ts` or a small helper module. Agent rollup
   should be TSV rows such as `summary`, `export`, `pkg`, `dep`, and `test`.
5. Thread an optional `rollup` boolean and `top` limit through MCP `impact_analysis` after CLI behavior
   is covered.

**Non-goals for the MVP:**

1. Do not add standalone `.graphql` indexing or GraphQL operation dependency graphs.
2. Do not implement SDL structural impact in the first pass; keep it as Phase 7B if real examples need
   it.
3. Do not parse SQL/template-literal DSLs; that belongs to the narrower Phase 9 SQL skeleton MVP.
4. Do not add new LanceDB columns, reindex requirements, or LLM summaries.

**Acceptance checks:**

1. Existing `impact` command tests keep passing; default symbol output and default agent output remain
   compatible.
2. File-target human output shows target export count, production dependent count, package count, and
   affected test count.
3. Per-export rollup identifies which exports have no known production dependents and which exports
   dominate the blast radius.
4. Package grouping caps noisy files while preserving representative top dependents.
5. `--no-tests` avoids calling `findTests()` and omits test sections in both flat and rollup modes.
6. `--agent --rollup` emits deterministic TSV rows suitable for MCP/agent parsing.

## Phase 9 Scope

**Status:** implemented in the working tree (2026-07-01) as the narrowed SQL-template skeleton MVP.

**Implemented MVP behavior:**

1. TS/JS skeleton summaries detect ``sql`...` `` and ``.sql`...` `` tagged templates hidden inside elided
   function bodies.
2. Summaries include lightweight SQL operation/table hints such as `SQL: SELECT users; INSERT audit_log`.
3. Interpolations are reduced to placeholders and full SQL text remains elided with the function body.
4. Non-SQL tags such as ``html`...` `` are ignored.

**Non-goals preserved:**

1. Do not build broad GraphQL/SQL/CSS template-literal parsing without new corpus evidence.
2. Do not parse standalone `.graphql` files as part of this phase.
3. Do not add new index columns or require a reindex beyond normal stored-skeleton refresh.

**Current Work:**

1. **LanceDB FTS panic remediation.** Repeated FTS merge panics recurred after the v0.26.4
   recovery shipped. Evaluate LanceDB 0.31, verify API/peer-dependency compatibility, and require
   maintenance convergence under watcher churn.
2. **Embedding re-embed cutover.** Do not start until a better embedding model is selected; then
   decide migration granularity/table layout before implementing background re-embed.
3. **Embedding layout decision.** Product decision still needed: per-project upgrades imply a second
   nullable vector column or per-project tables; whole-corpus upgrades imply a second-table swap.
4. **Semantic-ranking experiments.** PPR, HyDE, query expansion, graph-distance rerank, and semantic
   cache stay measurement-gated until new miss/latency fixtures justify them.
5. **Known limitations.** Static graph caveats remain around dynamic dispatch/reflection/string-built
   calls, stale/corrupt index recovery, and `surprises` as experimental orientation rather than proof.

| Priority | Plan | Next Work |
|---|---|---|
| Active | [LanceDB FTS Panic Remediation](plans/lancedb-fts-panic-remediation.md) | Evaluate LanceDB 0.31 and prove FTS maintenance convergence after repeated live panic/recovery cycles. |
| Gated | [Embedding Reembed Atomic Cutover](plans/embedding-reembed-atomic-cutover.md) | Do not start until a better embedding model is chosen; then decide per-project vs whole-corpus layout and build reembed/cutover. |
| Gated | [Embedding Layout Decision](embedding-layout-decision.md) | Product decision still needed: per-project upgrades imply second nullable vector column; whole-corpus upgrades imply second table swap. |
| Measure-first | [Semantic Search — Open Backlog](plans/2026-05-25-semantic-search-landscape.md) | No active build target; PPR/HyDE/query expansion/cache only reopen with new measured miss or latency fixtures. |
| Reference | [Known Limitations](known-limitations.md) | Static graph caveats remain: callback-value shape, dynamic dispatch/reflection/string-built calls, stale/corrupt index recovery notes. |

<!-- GENERATED:dotmd:start -->

## Active

| Doc | Status |
|-----|--------|
| [macOS Kernel-Zone Panic Incident - 2026-08-04](2026-08-04-macos-kernel-zone-panic-incident.md) | Active |
| [Performance Review — 2026-08-04](2026-08-04-performance-review.md) | Active |
| [Embedding Layout Decision](embedding-layout-decision.md) | Active |

## Planned

| Doc | Status |
|-----|--------|
| [Embedding Reembed Atomic Cutover](plans/embedding-reembed-atomic-cutover.md) | Planned |

## Reference

| Doc | Status |
|-----|--------|
| [Repository Audit - 2026-07-09](2026-07-09-repository-audit.md) | Reference |
| [Known Limitations](known-limitations.md) | Reference |

## Archived

Archived docs are indexed by the CLI/JSON output. Showing 8 recent or high-signal highlights out of 51 archived docs:

| Doc | Status Snapshot |
|-----|-----------------|
| [Mcp Server Migration](archived/mcp-server-migration.md) | Archived: The Server-to-McpServer migration shipped in `e80daca`; the result-shape follow-up shipped in `04a87a4`. The current server registers 27 tools with Zod schemas, explicit registered-project scoping, protocol coverage, and subsequent lifecycle/performance hardening. |
| [Graphify Derived Improvements](archived/graphify-derived-improvements.md) | Archived: Completed and shipped. Phase 1 and Phase 2 are shipped or rejected by measurement. Audit file dependency cycles are shipped. Phase 3A-3E are complete for the embedding-native orientation surface: `gmax surprises --experimental` and MCP `surprising_connections` have protocol coverage, corpus calibration, tuned scoring/filtering, actionable output, scale measurements, docs, and known-limitations coverage. |
| [gmax — Agent UX Backlog](archived/agent-ux-proposals.md) | Archived: All scoped Agent UX work is shipped. Phase 7 impact rollups shipped in `a71c616`, Phase 9 SQL-template skeleton summaries shipped in `504c055`, and Phase 12's daemon managers and search-output extraction shipped in `79f12d7` and `fbb8396`. Remaining ideas are measure-first reopen triggers, not an active backlog. |
| [Repository Audit Fix Plan](archived/2026-07-09-repository-audit-fixes.md) | Archived: All fourteen audit findings and Phases 1 through 8 are implemented and released through v0.26.2, with follow-up stability fixes through v0.26.5. Current HEAD passes 124 test files / 1035 tests, production and test-source typechecks, and Biome across 308 files. |
| [v0.26.2 Stability Cycle](archived/stability-cycle-v0.26.2.md) | Archived: Historical v0.26.2-v0.26.5 stability cycle. SC-001 and SC-003 were fixed and live-verified; SC-002 recovery shipped and restored compaction, but FTS merge panics recurred repeatedly through 2026-08-03. The dated observation window and formal exit snapshot were never completed, and the 2026-08-04 watcher/index/store changes supersede this baseline. |
| [Performance Backlog Fixes](archived/performance-backlog-fixes.md) | Archived: Phases 1A through 5A are implemented and verified. Phase 1B measurement retained the 1536 MB worker recycle default. Phase 5B's flag-gated IVF_FLAT implementation failed its recall gate and remains disabled; its path scalar index was retained for scoped exact-search latency. The full 124-file / 1035-test regression gate passes. |
| [Health Backlog — chunker v4 reindex, doctor cleanups, summarizer proposal](archived/2026-07-08-health-backlog.md) | Archived: Backlog left over from the 2026-07-06 health-check session (aeb966f MLX hardening, fd59de5 recycle-threshold fix). Four items, all verified against code/state on 2026-07-08: 11 projects stale at chunker v3 (doctor confirms), summarizer 0% coverage rendered as FAIL, gpu-mode doctor false-WARNs on the granite model path, ~/.zshrc:70 exports an unguarded external-volume HF_HOME. MLX healthy on 8100 as of plan creation. Sized for a single overnight session. |
| [Mcp Search Scope Leak](archived/mcp-search-scope-leak.md) | Archived: ARCHIVED. Fix A+B is implemented and fresh MCP-session smoke passed from `qsys/qsys-training` and `qsys/docs`: default `semantic_search` stayed qsys-scoped with zero platform leakage, while `scope:"all"` and `projects:"platform"` returned platform results. Follow-up source-mode robustness fix shipped in `WorkerPool`: TS workers now preload an absolute `tsx` loader instead of bare `ts-node/register`, so fresh source MCP processes launched outside the gmax repo can boot query workers. Fix C (findProjectRoot registry/marker-aware) intentionally NOT taken — higher risk, left as documented option. |

- Use `dotmd list` or `dotmd json` for the full inventory.
<!-- GENERATED:dotmd:end -->
