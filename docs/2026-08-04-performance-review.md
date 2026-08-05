---
type: doc
status: active
created: 2026-08-04T08:22:27Z
updated: 2026-08-04T08:22:27Z
modules:
  - src/lib/index/chunker.ts
  - src/lib/index/syncer.ts
  - src/lib/index/batch-processor.ts
  - src/lib/index/watcher.ts
  - src/lib/skeleton/skeletonizer.ts
  - src/lib/workers/pool.ts
  - src/lib/workers/process-child.ts
  - src/lib/workers/orchestrator.ts
  - src/lib/workers/embeddings/mlx-client.ts
  - src/lib/workers/embeddings/colbert.ts
  - src/lib/store/vector-db.ts
  - src/lib/store/meta-cache.ts
  - src/lib/search/searcher.ts
  - src/lib/graph/graph-builder.ts
  - src/lib/daemon/daemon.ts
  - src/lib/daemon/watcher-manager.ts
  - src/lib/daemon/search-handler.ts
  - src/commands/mcp.ts
  - mlx-embed-server/server.py
surfaces:
  - workers
  - index
  - store
  - search
  - daemon
  - mcp
domain: performance review (memory, indexing throughput, search latency)
audience: internal
related_plans:
  - archived/performance-backlog-fixes.md
  - archived/lancedb-fts-panic-remediation.md
related_docs:
  - docs/2026-07-09-repository-audit.md
  - docs/known-limitations.md
  - docs/2026-08-04-macos-kernel-zone-panic-incident.md
current_state: >
  Full performance review completed 2026-08-04 across the indexing pipeline, worker/embedding
  path, storage, daemon, search, and graph tools. Findings ranked and verified; the watcher
  ignore-glob fix shipped in fd11906 and the primary remediation plan shipped in 7b6349c.
  IVF_FLAT was rejected by its recall gate; exact search retained the path btree improvement.
next_step: >
  Keep the remaining lower-priority findings measure-first. Nested-definition duplicate
  chunking is the next candidate only after a recall benchmark establishes a safe target.
---

# Performance Review — 2026-08-04

> Ranked performance findings across gmax: worker memory, indexing throughput, search
> latency. Trigger: sustained high memory (gmax-worker observed at 886MB RSS).

## Executive Summary

Reviewed with three subsystem passes (indexing pipeline; workers/embeddings; storage/
daemon/search) plus a manual pass over graph/analysis code. The observed worker memory
is explained by a compounding chain: tree-sitter parse trees are never freed (unbounded
Emscripten-heap growth), the pool's recycle threshold (1536MB) sits above the leak's
steady state so nothing reclaims the bloated worker, and a single transient MLX failure
permanently loads the ONNX fallback stack in-process. Host-level memory is further
multiplied by each `gmax mcp` session duplicating the entire search stack in-process and
by unconditional 5-minute LanceDB compaction (~1.7GB spikes even when idle).

**Shipped during review:** watcher ignore globs fixed (nested `dist`, `.turbo`) —
commit `fd11906`, verified live with positive/negative probes. `@parcel/watcher` treats
non-glob ignore entries as root-relative literal paths, so bare directory names never
matched nested build dirs; monorepo builds flooded the daemon with events on every build.

## Memory findings

| # | Finding | Where | Status |
|---|---------|-------|--------|
| M1 | Tree-sitter `Tree` never freed; two trees leaked per file (chunker + skeletonizer); Emscripten heap grows monotonically, invisible to V8 limits | `chunker.ts:421`, `skeletonizer.ts:218` | verified |
| M2 | Recycle threshold 1536MB + MIN_KEEP_WORKERS=1 retains an ~886MB worker forever | `pool.ts:204,216` | verified |
| M3 | One MLX timeout (30s blacklist) permanently loads ONNX Granite session in-process, +150–250MB/worker, no unload path | `mlx-client.ts`, `orchestrator.ts:201`, `granite.ts:133` | agent-verified |
| M4 | Every MCP session builds its own VectorDB + Searcher + embedding worker instead of daemon IPC search | `mcp.ts:371-379` | verified |
| M5 | Unconditional maintenance every 5min: FTS rebuild + full optimize with no dirty gate; documented ~1.7GB compaction spikes; searches stall behind write gate during it | `vector-db.ts:120-160,936-985` | verified |
| M6 | initialSync holds up to 2000 hydrated VectorRecords (~80–100MB) + ~8 full-corpus path sets; duplicate LMDB scan at syncer.ts:258 | `syncer.ts:196-266,584,643-690` | agent-verified |
| M7 | `getDistinctPathsForPrefix` materializes one row per chunk (500k+ transient objects) per catchup per project | `vector-db.ts:1057` | agent-verified |
| M8 | Two tree-sitter runtimes + two unbounded grammar caches per worker | `chunker.ts:237`, `skeletonizer.ts:117` | agent-verified |
| M9 | pagerank module cache never evicts (gated on GMAX_PAGERANK=1); MCP audit/summarize materialize up to 500k/200k rows in-process | `pagerank.ts:31`, `mcp.ts:1413,1921` | agent-verified |

## Indexing throughput findings

| # | Finding | Where | Status |
|---|---------|-------|--------|
| T1 | Worker IPC ships binary vectors as JSON (`fork` without `serialization: "advanced"`); sync stringify/parse blocks worker and daemon loops; ~4.5× payload inflation; four revive/coerce workarounds exist only because of this | `pool.ts:173`, `process-child.ts`, `orchestrator.ts:66-89,398`, `vector-db.ts:664` | verified |
| T2 | Daemon reindex fully serial — one `processFile` at a time; catchup + watcher batches run at 1/N of pool throughput (initialSync already does bounded concurrency right) | `batch-processor.ts:306,383` | verified |
| T3 | Embed pipeline stalls: MLX HTTP and ColBERT CPU strictly sequential per batch; batch clamped to 16 vs server max 64; server `mx.clear_cache()` per request; ColBERT pads to longest batch member | `orchestrator.ts:164-212`, `colbert.ts:82-99`, `server.py:130,202` | verified (seq awaits) |
| T4 | Nested definitions chunked twice (class body + per-method) → ~2× embed cost on OO code | `chunker.ts:1042,1067` | agent-verified |
| T5 | Each file policy-classified 3–4× per run; post-index full-corpus serial reclassify pass with ignore-cache invalidation every 50 files | `walker.ts:101`, `syncer.ts:462,502,683-726` | agent-verified |
| T6 | O(L²) prefix re-slicing in `splitByChars` (GB-scale copying on large/minified files); fresh RegExp per symbol per sub-chunk in `scopeSymbolsToContent` | `chunker.ts:1208,1128` | agent-verified |
| T7 | Sync `realpathSync`/hashing on daemon event loop per file in catchup/batch paths | `watcher-manager.ts:581`, `path-containment.ts:32` | agent-verified |
| T8 | Cold worker pays 3s hard sleep on first MLX health check; 30s blacklist with no early re-probe (also triggers M3) | `mlx-client.ts:182,18` | agent-verified |

## Search latency findings

| # | Finding | Where | Status |
|---|---------|-------|--------|
| S1 | No ANN vector index exists (only FTS on `content`); every query brute-force scans all projects' vectors. (Correction from spec pass: the path scope IS a prefilter in LanceDB 0.30 — the defect is that with no vector index there is nothing to prune, and no scalar index accelerates the `starts_with(path,…)` predicate either) | `vector-db.ts:759,786`, `searcher.ts:574` | verified |
| S2 | Retrieval materializes ~2×500 full rows incl. `content`, then spread-copies each; vector + FTS queries sequential though independent | `searcher.ts:550-597` | agent-verified |
| S3 | `ensureTable` per query re-opens table + fetches schema twice, and queues behind write gate (stalls for full compaction duration — see M5) | `vector-db.ts:592-615` | agent-verified |
| S4 | Search response JSON-stringified twice (once only to measure size) | `search-handler.ts:190`, `daemon.ts:308` | agent-verified |
| S5 | Heartbeat runs `execSync` lsof/pgrep (≤5s) on daemon event loop every 5min | `daemon.ts:458`, `process-manager.ts:69`, `mlx-server-manager.ts:163` | agent-verified |
| S6 | Graph tools issue serial/N+1 unindexed scans: buildGraph resolves ≤15 callees serially; multi-hop trace serial per node; `related_files`/`diff_changes` one scan per symbol/file | `graph-builder.ts:241-296,363`, `mcp.ts:2107,2300` | verified (graph-builder) |

## Kernel panic investigation (2026-08-03)

`panic-full-2026-08-03-152634.0002.panic`: kernel zone-map exhaustion,
`data.kalloc.1024` at 19GB / ~21M elements. Backtrace through
`com.apple.iokit.EndpointSecurity` + `com.apple.filesystems.apfs`; panicked thread in
`opencode.exe`. **Not attributable to gmax**: no gmax process was alive in the panic's
825-process snapshot, the leak is kernel-side (a userspace watcher cannot leak kalloc),
and no third-party ES extension is installed — the undrained ES client would be an Apple
daemon (likely a macOS 26.5.2 bug). gmax contributes FS-event *volume* like every other
busy process; the watcher-glob fix reduces that share. Recurrence check:
`sudo zprint data.kalloc.1024`.

## Verification notes

- "verified" = re-checked in source by the reviewing session; "agent-verified" =
  reported by an Opus review agent with quoted code, spot-check pending.
- Live observations: worker RSS 886MB during a build-artifact batch, settling to 462MB;
  daemon log showed gitignored `packages/*/dist` and `.turbo/cache` paths in watch
  batches prior to the fix; post-fix probes confirmed those paths generate no events
  while a control file does.

## Version History

- **2026-08-04T08:22:27Z** Created.
- **2026-08-04** Full findings from three-subsystem Opus review + manual graph pass;
  watcher-glob fix shipped (fd11906) and verified live; kernel-panic investigation
  recorded.
- **2026-08-04** Primary remediation shipped in `7b6349c`; plan archived after IVF_FLAT
  failed its production recall gate.

## Related Documentation

- docs/archived/performance-backlog-fixes.md — remediation implementation and closeout
- docs/2026-07-09-repository-audit.md — prior audit (security/correctness focus)
