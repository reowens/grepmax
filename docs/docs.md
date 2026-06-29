# Docs

<!-- GENERATED:dotmd:start -->

## Active

| Doc | Status |
|-----|--------|
| [gmax — Agent UX Backlog](agent-ux-proposals.md) | Active |
| [Embedding Layout Decision](embedding-layout-decision.md) | Active |
| [Semantic Search — Open Backlog](plans/2026-05-25-semantic-search-landscape.md) | Active |
| [Graphify Derived Improvements](plans/graphify-derived-improvements.md) | Active |

## Planned

| Doc | Status |
|-----|--------|
| [Embedding Reembed Atomic Cutover](plans/embedding-reembed-atomic-cutover.md) | Planned |

## Reference

| Doc | Status |
|-----|--------|
| [Known Limitations](known-limitations.md) | Reference |

## Archived

Archived docs are indexed by the CLI/JSON output. Showing 4 recent or high-signal highlights out of 38 archived docs:

| Doc | Status Snapshot |
|-----|-----------------|
| [Repo Audit Hardening](archived/2026-06-28-repo-audit-hardening.md) | Archived: Phases 1-5 are implemented. Lifecycle fixes now block/degrade safely around draining daemons, expose readiness separately from liveness, and quiesce/requeue active ProjectBatchProcessor work. Graph consumers now use language-family anchors and outbound callee resolution prefers same file, then same language family, then fallback. Search/store fixes make `search --root` consistently use the active root, stamp chunkerVersion after search-triggered full sync, return `-m` results beyond RERANK_TOP while bounding expensive rerank, preserve VectorDB schema-validation errors, and count impact dependents by distinct target symbol per file. Release/package hardening is complete: release workflow actions are SHA-pinned, release verification includes test/format/audit/build/tarball checks, `mathjs` is overridden to 15.2.0, package `main` points at `dist/index.js`, prebuild removes stale dist and tsbuildinfo, postinstall is a no-op notice, and `gmax plugin update` is explicit. Smaller lifecycle hardening now clears WorkerPool destroy timers on worker exit, handles MLX spawn errors as CPU fallback, and applies the worker respawn cap to timeout-killed workers. Current verification passes: typecheck, full Vitest (76 files / 634 tests), format check, production audit, build, dry-run pack, native simsimd smoke, and packed install/version smoke. |
| [Investigate Tool Calling Leak](archived/investigate-tool-calling-leak.md) | Archived: FIXED (in working tree, uncommitted). Option 2 (`--reasoning-format deepseek`) experimentally proven to fix the leak with the CURRENT model — see history. Shipped changes: (a) `investigate.ts` guard — `looksLikeRawToolCall`/`toolCallLeakHint`/`finalizeAnswer` at both return points (empty `tool_calls` + tool-call-shaped content → clear hint, not raw XML); (b) `config.ts` `reasoningFormat` defaults to "deepseek" (env `GMAX_LLM_REASONING_FORMAT` overrides; "" opts out); (c) `server.ts` passes `--reasoning-format` to llama-server. Tests: `tests/investigate-tool-call-leak.test.ts` 12 cases green; `tsc` + biome clean. Option 1 (Hermes model swap) kept as a documented fallback only — NOT pursued (no download). NOT committed: a concurrent session is mid-refactor on remove.ts/vector-db.ts/filter-builder.ts/scope-filter.ts — commit gmax-llm files separately, do not sweep those up. |
| [Triage 2026 06 28 Correctness Hardening](archived/triage-2026-06-28-correctness-hardening.md) | Archived: 2026-06-28 — ALL 8 PHASES SHIPPED to main (commits 446f180, d9772c2, 7f6126b, 3bc2678, 61af5ad, 75788f9, b3c0838, 6532192); tsc/biome clean, 552 tests passing. PLAN COMPLETE. Done: prefix/wildcard safety (starts_with, repo-wide), atomic reindex (insert-before-delete), stale-chunk purge on non-indexable transitions, daemon startup/shutdown lifecycle races (readiness gate + poll-for-exit), poll-mode watcher teardown, model-tier dim wired end-to-end (VectorDB default dim from global config + throw on mismatch, embeddingEnv() into worker spawn, granite reads GMAX_EMBED_ONNX_MODEL), packaging (.claude-plugin in files so root marketplace.json ships + setup calls gracefulExit-free installAll()), docs (README skeleton example uses a file not a directory). gmax source clean at 6532192 except the other-session LLM files (llm/{config,investigate,server}.ts + investigate-tool-call-leak.test.ts + scratch-harness.ts) which stayed OUT of these commits. |
| [Index Versioning + Daemon/Search Refactor](archived/2026-06-23-index-versioning-and-daemon-refactor.md) | Archived: Two next-session work items, both scoped from code (file:line anchors below). ITEM 1 = embedding-model versioning (agent-ux Phase 11): a model/dim change today is caught only by checkModelMismatch() at sync time, which silently force-RESETS the project; nothing surfaces it at query/doctor time, and the LanceDB vector column is a FIXED-dim FixedSizeList in one shared table — so dim-changing swaps can't coexist without a layout change. Splits into Phase 1A (visibility/detection — cheap, mirror the just-shipped chunker-version pattern) and Phase 1B (in-place re-embed + atomic cutover — hard, defer until a better model lands). ITEM 2 = search.ts/daemon.ts refactor (agent-ux Phase 12): runSearch/search-handler/ipc-handler are ALREADY extracted; real targets are 3 new daemon manager classes (Watcher/Mlx/Process) + search.ts's output-render block. |

- Use `dotmd list` or `dotmd json` for the full inventory.
<!-- GENERATED:dotmd:end -->
