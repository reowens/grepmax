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

**Opportunistic:**

1. **Agent UX Phase 12: watcher-manager split.** `search.ts` and daemon search handling are already
   split; only the state-coupled watcher/recovery/poll-mode region remains. Do this when touching
   watcher behavior, not as standalone churn.

**Gated or held:**

1. **Embedding re-embed cutover.** Do not start until a better embedding model is selected; then
   decide migration granularity/table layout before implementing background re-embed.
2. **Embedding layout decision.** Product decision still needed: per-project upgrades imply a second
   nullable vector column or per-project tables; whole-corpus upgrades imply a second-table swap.
3. **MCP Server Migration leftovers.** Headline migration is shipped; remaining items are dependency
   holds (`apache-arrow`, `onnxruntime-node`, `biome`) plus separate Sentinel absorption.
4. **Semantic-ranking experiments.** PPR, HyDE, query expansion, graph-distance rerank, and semantic
   cache stay measurement-gated until new miss/latency fixtures justify them.
5. **Known limitations.** Static graph caveats remain around dynamic dispatch/reflection/string-built
   calls, stale/corrupt index recovery, and `surprises` as experimental orientation rather than proof.

| Priority | Plan | Next Work |
|---|---|---|
| Active | [v0.26.2 Stability Cycle](stability-cycle-v0.26.2.md) | SC-001 is live-verified on v0.26.3. Run seven days of representative normal workload, integrity observation, disk-pressure regressions, and store-growth review. |
| Done | [Repository Audit Fix Plan](plans/2026-07-09-repository-audit-fixes.md) | Phases 1-8 are complete. Phase 4B shipped exact-byte hashing, explicit vector/tombstone metadata, per-path coherence, and deletion-only critical-pressure behavior. |
| Done | [Mcp Search Scope Leak](archived/mcp-search-scope-leak.md) | Fix A+B shipped and fresh MCP smoke passed from qsys subdirectories. Also fixed source-mode worker bootstrap from non-gmax cwd. |
| Done | [Graphify Derived Improvements](plans/graphify-derived-improvements.md) | Phase 3A-3E complete in working tree. Disposition: keep `gmax surprises` / MCP `surprising_connections` experimental; revisit only with new corpus evidence. |
| Done | [gmax — Agent UX Backlog](agent-ux-proposals.md) | Phase 7 `impact` rollup MVP and narrowed Phase 9 SQL-template skeleton MVP implemented. Remaining Agent UX work is opportunistic Phase 12 refactor only. |
| Gated | [Embedding Reembed Atomic Cutover](plans/embedding-reembed-atomic-cutover.md) | Do not start until a better embedding model is chosen; then decide per-project vs whole-corpus layout and build reembed/cutover. |
| Gated | [Embedding Layout Decision](embedding-layout-decision.md) | Product decision still needed: per-project upgrades imply second nullable vector column; whole-corpus upgrades imply second table swap. |
| Hold | [Mcp Server Migration](plans/mcp-server-migration.md) | Migration shipped. Remaining items are dependency/Sentinel holds: apache-arrow peerDep, onnxruntime ABI, biome format churn, Sentinel absorption. |
| Measure-first | [Semantic Search — Open Backlog](plans/2026-05-25-semantic-search-landscape.md) | No active build target; PPR/HyDE/query expansion/cache only reopen with new measured miss or latency fixtures. |
| Reference | [Known Limitations](known-limitations.md) | Static graph caveats remain: callback-value shape, dynamic dispatch/reflection/string-built calls, stale/corrupt index recovery notes. |

<!-- GENERATED:dotmd:start -->

## Active

| Doc | Status |
|-----|--------|
| [Repository Audit - 2026-07-09](2026-07-09-repository-audit.md) | Active |
| [gmax — Agent UX Backlog](agent-ux-proposals.md) | Active |
| [Embedding Layout Decision](embedding-layout-decision.md) | Active |
| [Semantic Search — Open Backlog](plans/2026-05-25-semantic-search-landscape.md) | Active |
| [Repository Audit Fix Plan](plans/2026-07-09-repository-audit-fixes.md) | Active |
| [Graphify Derived Improvements](plans/graphify-derived-improvements.md) | Active |
| [v0.26.2 Stability Cycle](stability-cycle-v0.26.2.md) | Active |

## Planned

| Doc | Status |
|-----|--------|
| [Embedding Reembed Atomic Cutover](plans/embedding-reembed-atomic-cutover.md) | Planned |

## Reference

| Doc | Status |
|-----|--------|
| [Known Limitations](known-limitations.md) | Reference |

## Archived

Archived docs are indexed by the CLI/JSON output. Showing 5 recent or high-signal highlights out of 41 archived docs:

| Doc | Status Snapshot |
|-----|-----------------|
| [Mcp Search Scope Leak](archived/mcp-search-scope-leak.md) | Archived: ARCHIVED. Fix A+B is implemented and fresh MCP-session smoke passed from `qsys/qsys-training` and `qsys/docs`: default `semantic_search` stayed qsys-scoped with zero platform leakage, while `scope:"all"` and `projects:"platform"` returned platform results. Follow-up source-mode robustness fix shipped in `WorkerPool`: TS workers now preload an absolute `tsx` loader instead of bare `ts-node/register`, so fresh source MCP processes launched outside the gmax repo can boot query workers. Fix C (findProjectRoot registry/marker-aware) intentionally NOT taken — higher risk, left as documented option. |
| [Repo Audit Hardening](archived/2026-06-28-repo-audit-hardening.md) | Archived: Phases 1-5 are implemented. Lifecycle fixes now block/degrade safely around draining daemons, expose readiness separately from liveness, and quiesce/requeue active ProjectBatchProcessor work. Graph consumers now use language-family anchors and outbound callee resolution prefers same file, then same language family, then fallback. Search/store fixes make `search --root` consistently use the active root, stamp chunkerVersion after search-triggered full sync, return `-m` results beyond RERANK_TOP while bounding expensive rerank, preserve VectorDB schema-validation errors, and count impact dependents by distinct target symbol per file. Release/package hardening is complete: release workflow actions are SHA-pinned, release verification includes test/format/audit/build/tarball checks, `mathjs` is overridden to 15.2.0, package `main` points at `dist/index.js`, prebuild removes stale dist and tsbuildinfo, postinstall is a no-op notice, and `gmax plugin update` is explicit. Smaller lifecycle hardening now clears WorkerPool destroy timers on worker exit, handles MLX spawn errors as CPU fallback, and applies the worker respawn cap to timeout-killed workers. Current verification passes: typecheck, full Vitest (76 files / 634 tests), format check, production audit, build, dry-run pack, native simsimd smoke, and packed install/version smoke. |
| [Investigate Tool Calling Leak](archived/investigate-tool-calling-leak.md) | Archived: FIXED (in working tree, uncommitted). Option 2 (`--reasoning-format deepseek`) experimentally proven to fix the leak with the CURRENT model — see history. Shipped changes: (a) `investigate.ts` guard — `looksLikeRawToolCall`/`toolCallLeakHint`/`finalizeAnswer` at both return points (empty `tool_calls` + tool-call-shaped content → clear hint, not raw XML); (b) `config.ts` `reasoningFormat` defaults to "deepseek" (env `GMAX_LLM_REASONING_FORMAT` overrides; "" opts out); (c) `server.ts` passes `--reasoning-format` to llama-server. Tests: `tests/investigate-tool-call-leak.test.ts` 12 cases green; `tsc` + biome clean. Option 1 (Hermes model swap) kept as a documented fallback only — NOT pursued (no download). NOT committed: a concurrent session is mid-refactor on remove.ts/vector-db.ts/filter-builder.ts/scope-filter.ts — commit gmax-llm files separately, do not sweep those up. |
| [Triage 2026 06 28 Correctness Hardening](archived/triage-2026-06-28-correctness-hardening.md) | Archived: 2026-06-28 — ALL 8 PHASES SHIPPED to main (commits 446f180, d9772c2, 7f6126b, 3bc2678, 61af5ad, 75788f9, b3c0838, 6532192); tsc/biome clean, 552 tests passing. PLAN COMPLETE. Done: prefix/wildcard safety (starts_with, repo-wide), atomic reindex (insert-before-delete), stale-chunk purge on non-indexable transitions, daemon startup/shutdown lifecycle races (readiness gate + poll-for-exit), poll-mode watcher teardown, model-tier dim wired end-to-end (VectorDB default dim from global config + throw on mismatch, embeddingEnv() into worker spawn, granite reads GMAX_EMBED_ONNX_MODEL), packaging (.claude-plugin in files so root marketplace.json ships + setup calls gracefulExit-free installAll()), docs (README skeleton example uses a file not a directory). gmax source clean at 6532192 except the other-session LLM files (llm/{config,investigate,server}.ts + investigate-tool-call-leak.test.ts + scratch-harness.ts) which stayed OUT of these commits. |
| [Index Versioning + Daemon/Search Refactor](archived/2026-06-23-index-versioning-and-daemon-refactor.md) | Archived: Two next-session work items, both scoped from code (file:line anchors below). ITEM 1 = embedding-model versioning (agent-ux Phase 11): a model/dim change today is caught only by checkModelMismatch() at sync time, which silently force-RESETS the project; nothing surfaces it at query/doctor time, and the LanceDB vector column is a FIXED-dim FixedSizeList in one shared table — so dim-changing swaps can't coexist without a layout change. Splits into Phase 1A (visibility/detection — cheap, mirror the just-shipped chunker-version pattern) and Phase 1B (in-place re-embed + atomic cutover — hard, defer until a better model lands). ITEM 2 = search.ts/daemon.ts refactor (agent-ux Phase 12): runSearch/search-handler/ipc-handler are ALREADY extracted; real targets are 3 new daemon manager classes (Watcher/Mlx/Process) + search.ts's output-render block. |

- Use `dotmd list` or `dotmd json` for the full inventory.
<!-- GENERATED:dotmd:end -->
