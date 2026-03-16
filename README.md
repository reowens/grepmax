<div align="center">
  <h1>grepmax</h1>
  <p><em>Slash tokens. Save time. Semantic search for your coding agent.</em></p>

  <a href="https://opensource.org/licenses/Apache-2.0">
    <img src="https://img.shields.io/badge/License-Apache%202.0-blue.svg" alt="License: Apache 2.0" />
  </a>

  <a href="https://deepwiki.com/reowens/grepmax">
    <img src="https://deepwiki.com/badge.svg" alt="Ask DeepWiki" />
  </a>

<a>
  <img alt="CodeRabbit Pull Request Reviews" src="https://img.shields.io/coderabbit/prs/github/reowens/grepmax">
</a>
</div>



Natural-language search that works like `grep`. Fast, local, and built for coding agents.

- **Semantic:** Finds concepts ("where do transactions get created?"), not just strings.
- **Call Graph Tracing:** Map dependencies with `trace` to see who calls what.
- **Role Detection:** Distinguishes `ORCHESTRATION` (high-level logic) from `DEFINITION` (types/classes).
- **Local & Private:** 100% local embeddings via ONNX (CPU) or MLX (Apple Silicon GPU).
- **Centralized Index:** One database at `~/.gmax/` — index once, search from anywhere.
- **Agent-Ready:** Native output with symbols, roles, and call graphs.

## Quick Start

1. **Install**
   ```bash
   npm install -g grepmax
   ```

2.  **Setup (Recommended)**

    ```bash
    gmax setup
    ```

    Downloads embedding models (~150MB) upfront and lets you choose between CPU (ONNX) and GPU (MLX) embedding modes. If you skip this, models download automatically on first use.

3.  **Index**

    ```bash
    cd my-repo
    gmax index
    ```

    Indexes into a centralized store at `~/.gmax/lancedb/`. You can index any directory — a single repo, a monorepo, or an entire workspace.

4.  **Search**

    ```bash
    gmax "where do we handle authentication?"
    ```

5.  **Trace** (Call Graph)

    ```bash
    gmax trace "function_name"
    ```
    See who calls a function (upstream dependencies) and what it calls (downstream dependencies).

    ```bash
    gmax symbols                  # List all indexed symbols
    ```

In our public benchmarks, `grepmax` can save about 20% of your LLM tokens and deliver a 30% speedup.

<div align="center">
  <img src="public/bench.png" alt="gmax benchmark" width="100%" style="border-radius: 8px; margin: 20px 0;" />
</div>

## Agent Plugins

### Claude Code

1. Run `gmax install-claude-code`
2. Open Claude Code — the plugin auto-starts the MLX GPU server and a background file watcher.
3. Claude uses `gmax` for semantic searches automatically via MCP tools.

### Opencode
1. Run `gmax install-opencode`
2. OC uses `gmax` for semantic searches via MCP.

### Codex
1. Run `gmax install-codex`
2. Codex uses `gmax` for semantic searches.

### Factory Droid
1. Run `gmax install-droid`
2. To remove: `gmax uninstall-droid`

### MCP Server

`gmax mcp` starts a stdio-based MCP server that searches the centralized index directly — no HTTP daemon needed.

| Tool | Description |
| --- | --- |
| `semantic_search` | Natural language code search. Use `root` to search a parent or sibling directory. |
| `search_all` | Search ALL indexed code across every directory. |
| `code_skeleton` | Collapsed file structure (~4x fewer tokens than reading the full file) |
| `trace_calls` | Call graph — who calls a symbol and what it calls (unscoped, crosses project boundaries) |
| `list_symbols` | List indexed functions, classes, and types with definition locations |
| `index_status` | Check index health: chunk counts, indexed directories, model info |

## Commands

### `gmax search`

The default command. Searches indexed code using semantic meaning.

```bash
gmax "how is the database connection pooled?"
```

**Options:**

| Flag | Description | Default |
| --- | --- | --- |
| `-m <n>` | Max total results to return. | `5` |
| `--per-file <n>` | Max matches to show per file. | `3` |
| `-c`, `--content` | Show full chunk content instead of snippets. | `false` |
| `--scores` | Show relevance scores (0-1) for each result. | `false` |
| `--min-score <n>` | Filter out results below this score threshold. | `0` |
| `--compact` | Compact hits view (paths + line ranges + role/preview). | `false` |
| `--skeleton` | Show code skeleton for matching files instead of snippets. | `false` |
| `--plain` | Disable ANSI colors and use simpler formatting. | `false` |
| `-s`, `--sync` | Force re-index changed files before searching. | `false` |

**Examples:**

```bash
gmax "API rate limiting logic"
gmax "error handling" --per-file 5
gmax "user validation" --compact
gmax "authentication" --scores --min-score 0.5
gmax "database connection" --skeleton
```

### `gmax index`

Index a directory into the centralized store.

- Respects `.gitignore` and `.gmaxignore`.
- Only embeds code and config files. Skips binaries, lockfiles, and minified assets.
- Uses TreeSitter for semantic chunking (TypeScript, JavaScript, Python, Go, Rust, C/C++, Java, C#, Ruby, PHP, Swift, Kotlin, JSON).
- Files already indexed with matching content are skipped automatically.

```bash
gmax index                        # Index current dir
gmax index --path ~/workspace     # Index a specific directory
gmax index --dry-run              # See what would be indexed
gmax index --verbose              # Watch detailed progress
gmax index --reset                # Full re-index from scratch
```

### `gmax watch`

Background file watcher for live reindexing. Watches for file changes and incrementally updates the centralized index.

```bash
gmax watch -b                     # Background mode (auto-stops after 30min idle)
gmax watch --path ~/workspace     # Watch a specific directory
gmax watch status                 # Show running watchers
gmax watch stop --all             # Stop all watchers
```

The MCP server auto-starts a watcher on session start. You rarely need to run this manually.

### `gmax serve`

HTTP server with live file watching. Useful for non-MCP integrations.

```bash
gmax serve                        # Foreground, port 4444
gmax serve --background           # Background mode
gmax serve --cpu                  # Force CPU-only embeddings
```

### `gmax skeleton`

Compressed view of a file — signatures with bodies collapsed.

```bash
gmax skeleton src/lib/auth.ts
gmax skeleton AuthService         # Find symbol, skeletonize its file
gmax skeleton "auth logic"        # Search, skeletonize top matches
```

**Supported Languages:** TypeScript, JavaScript, Python, Go, Rust, Java, C#, C++, C, Ruby, PHP, Swift, Kotlin.

### `gmax doctor`

Checks installation health, model paths, and database integrity.

```bash
gmax doctor
```

## Architecture

### Centralized Index

All data lives in `~/.gmax/`:
- `~/.gmax/lancedb/` — LanceDB vector store (one database for all indexed directories)
- `~/.gmax/cache/meta.lmdb` — file metadata cache (content hashes, mtimes)
- `~/.gmax/config.json` — global config (model tier, embed mode)
- `~/.gmax/models/` — embedding models
- `~/.gmax/grammars/` — Tree-sitter grammars
- `~/.gmax/projects.json` — registry of indexed directories

All chunks store **absolute file paths**. Search scoping is done via path prefix filtering. There are no per-project index directories.

### Performance

- **Bounded Concurrency:** Worker threads scale to 50% of CPU cores (min 4). Override with `GMAX_WORKER_THREADS`.
- **Smart Chunking:** `tree-sitter` splits code by function/class boundaries for complete logical blocks.
- **Deduplication:** Identical code blocks are embedded once and cached.
- **Multi-stage Search:** Vector search + FTS + RRF fusion + ColBERT reranking + structural boosting.
- **Role Classification:** Detects `ORCHESTRATION` (high complexity, many calls) vs `DEFINITION` (types/classes).

### GPU Embeddings (Apple Silicon)

On Macs with Apple Silicon, gmax defaults to MLX for GPU-accelerated embeddings. The MLX embed server runs on port `8100` and is managed automatically by the Claude Code plugin hook.

To force CPU mode: `GMAX_EMBED_MODE=cpu gmax index`

## Configuration

### Ignoring Files

gmax respects `.gitignore` and `.gmaxignore` files. Create a `.gmaxignore` in your directory root to exclude additional patterns.

### Index Management

- **View indexed directories:** `gmax list --all`
- **Index location:** `~/.gmax/lancedb/` (centralized)
- **Clean up:** `gmax index --reset` re-indexes the current directory from scratch
- **Full reset:** `rm -rf ~/.gmax/lancedb ~/.gmax/cache` to start completely fresh

## Development

```bash
pnpm install
pnpm build
pnpm test         # vitest
pnpm format       # biome check
just deploy       # publish latest tag to npm
```

## Troubleshooting

- **Index feels stale?** Run `gmax index` to refresh, or use `gmax watch -b` for live reindexing.
- **Weird results?** Run `gmax doctor` to verify models.
- **Index getting stuck?** Run `gmax index --verbose` to see which file is being processed.
- **Need a fresh start?** `rm -rf ~/.gmax/lancedb ~/.gmax/cache` then `gmax index`.
- **MLX server won't start?** Check `/tmp/mlx-embed-server.log` for errors. Use `GMAX_EMBED_MODE=cpu` to fall back to CPU.

## Attribution

grepmax is built upon the foundation of [mgrep](https://github.com/mixedbread-ai/mgrep) by MixedBread. We acknowledge and appreciate the original architectural concepts and design decisions that informed this work.

See the [NOTICE](NOTICE) file for detailed attribution information.

## License

Licensed under the Apache License, Version 2.0.
See [LICENSE](LICENSE) and [Apache-2.0](https://opensource.org/licenses/Apache-2.0) for details.
