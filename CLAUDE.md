# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Git Workflow — MANDATORY

1. **All changes to main go through PRs.** No direct merges, no direct pushes to main. Ever.
2. **Never squash merge.** Use `gh pr merge` with no flags. Individual commits matter.
3. **Never run destructive git commands** (`reset --hard`, `push --force`, `checkout .`, `clean -f`) without the user explicitly requesting that specific command.
4. **If git state looks wrong, STOP.** Describe the problem. Do not try to fix it autonomously.

## Commands

```bash
pnpm build          # tsc → dist/
pnpm test           # vitest run
pnpm test:watch     # vitest watch mode
pnpm typecheck      # tsc --noEmit
pnpm format         # biome check --write .
pnpm lint           # biome lint .
```

## Release / Deploy

```bash
npm version patch   # bump version, commit, tag, push, and publish (fully automated)
```

This single command runs the full pipeline via npm lifecycle hooks:
1. `preversion` — runs tests + typecheck
2. `version` — syncs plugin.json + marketplace.json versions, stages all
3. `postversion` — pushes commit + tag, creates GitHub release, watches CI, installs globally

Use `minor` or `major` instead of `patch` as needed.

Run a single test file:
```bash
npx vitest run tests/intent.test.ts
```

## Architecture

grepmax is a semantic code search CLI tool (CLI command: `gmax`). It indexes source code into vector embeddings and searches by meaning rather than exact string matching.

### Centralized Index

All data lives in `~/.gmax/`:
- `~/.gmax/lancedb/` — LanceDB vector store (one database for all indexed directories)
- `~/.gmax/cache/meta.lmdb` — file metadata cache (content hashes, mtimes, LRU/LFU cached)
- `~/.gmax/cache/watchers.lmdb` — watcher/daemon registry (LMDB, crash-safe)
- `~/.gmax/daemon.sock` — Unix domain socket for daemon IPC
- `~/.gmax/logs/` — daemon, watcher, and MLX server logs (5MB rotation)
- `~/.gmax/config.json` — global config (model tier, embed mode)
- `~/.gmax/models/` — embedding models
- `~/.gmax/grammars/` — Tree-sitter grammars
- `~/.gmax/projects.json` — registry of indexed directories

All chunks store **absolute file paths**. Search scoping is done via path prefix filtering. There are NO `.gmax/` directories inside projects.

### Pipeline

1. **Walk** (`src/lib/index/walker.ts`) — traverses repo respecting `.gitignore` / `.gmaxignore`
2. **Chunk** (`src/lib/index/chunker.ts`) — splits files by function/class boundaries using Tree-sitter grammars
3. **Embed** (`src/lib/workers/`) — generates 384-dim dense vectors (Granite model via ONNX or MLX) and ColBERT reranking vectors via a custom child_process pool (not piscina — isolates ONNX segfaults)
4. **Store** (`src/lib/store/vector-db.ts`) — writes vectors to centralized LanceDB, file metadata to LMDB (`meta-cache.ts`). LanceDB auto-compacts every 5min.
5. **Search** (`src/lib/search/searcher.ts`) — multi-stage: vector search → FTS → RRF fusion → cosine rerank → structural boosting → deduplication
6. **Graph** (`src/lib/graph/graph-builder.ts`) — call graph from `defined_symbols` / `referenced_symbols` in indexed chunks
7. **Skeleton** (`src/lib/skeleton/skeletonizer.ts`) — Tree-sitter based file summarization (signatures only, bodies collapsed)

### MCP Server

`gmax mcp` runs an in-process MCP server over stdio. It searches the centralized VectorDB directly — no HTTP daemon needed.

Tools: `semantic_search` (use `scope: "all"` for cross-project), `code_skeleton`, `trace_calls`, `list_symbols`, `index_status`, `summarize_directory`, `summarize_project`, `related_files`, `recent_changes`

### Embedding Modes

Defaults to GPU (MLX) on Apple Silicon, CPU (ONNX) elsewhere. Override with `gmax serve --cpu` or `gmax setup`. Both modes produce compatible 384-dim vectors from the same Granite model — switching modes doesn't require reindexing.

### Daemon Watcher

`gmax watch --daemon` runs a single background process watching all registered projects via `@parcel/watcher` (native FSEvents/inotify — sub-second detection, no polling). CLI commands communicate over Unix socket IPC at `~/.gmax/daemon.sock`. Per-project watchers (`gmax watch --path <dir>`) are preserved as fallback.

Key files:
- `src/lib/daemon/daemon.ts` — Daemon class (socket server, per-project subscriptions, shared VectorDB/MetaCache)
- `src/lib/daemon/ipc-handler.ts` — IPC command router (ping, watch, unwatch, status, shutdown)
- `src/lib/index/batch-processor.ts` — Per-project batch processing (extracted from watcher.ts)
- `src/lib/utils/daemon-client.ts` — IPC client (sendDaemonCommand, isDaemonRunning)
- `src/lib/utils/daemon-launcher.ts` — Spawns daemon in background
- `src/lib/utils/watcher-launcher.ts` — Tries daemon IPC first, falls back to per-project spawn

### Plugin System

The Claude Code plugin lives in `plugins/grepmax/`. SessionStart hook starts the daemon and MLX server if needed.

## Key Types

- `VectorRecord` — a single indexed chunk with embedding, metadata, symbols, role
- `ChunkType` — search result with score, confidence, role classification (ORCHESTRATION / DEFINITION / IMPLEMENTATION)
- `SearchIntent` — query classifier (DEFINITION / FLOW / USAGE / ARCHITECTURE / GENERAL)

## Version Sync

Plugin and marketplace versions must match `package.json`. The `npm version` lifecycle hooks handle everything automatically — no manual steps needed. The release CI validates that all version files match.
