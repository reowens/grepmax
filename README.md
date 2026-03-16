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
- **Auto-Isolated:** Each repository gets its own index automatically.
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

3.  **Search**

    ```bash
    cd my-repo
    gmax "where do we handle authentication?"
    ```

    **Your first search will automatically index the repository.** Each repository is automatically isolated with its own index. Switching between repos "just works" — no manual configuration needed. If the background server is running (`gmax serve`), search goes through the hot daemon; otherwise it falls back to on-demand indexing.

4.  **Trace** (Call Graph)

    ```bash
    gmax trace "function_name"
    ```
See who calls a function (upstream dependencies) and what it calls (downstream dependencies). Perfect for impact analysis and understanding code flow.

To find the symbols in your code base:
    ```bash
    gmax symbols
    ```

In our public benchmarks, `grepmax` can save about 20% of your LLM tokens and deliver a 30% speedup.

<div align="center">
  <img src="public/bench.png" alt="gmax benchmark" width="100%" style="border-radius: 8px; margin: 20px 0;" />
</div>



### Claude Code Plugin

1. Run `gmax install-claude-code`
2. Open Claude Code (`claude`) and ask it questions about your codebase.
3. Highly recommend indexing your code base before using the plugin.
4. The plugin's hooks auto-start `gmax serve` in the background and shut it down on session end. Claude will use `gmax` for semantic searches automatically but can be encouraged to do so.

### Opencode Plugin
1. Run `gmax install-opencode`
2. Open OC (`opencode`) and ask it questions about your codebase.
3. Highly recommend indexing your code base before using the plugin.
4. The plugin's hooks auto-start `gmax serve` in the background and shut it down on session end. OC will use `gmax` for semantic searches automatically but can be encouraged to do so.

### Codex Plugin
1. Run `gmax install-codex`
2. Codex will use `gmax` for semantic searches.

### Factory Droid Plugin
1. Run `gmax install-droid`
2. To remove: `gmax uninstall-droid`

### MCP Server

gmax exposes tools via the [Model Context Protocol](https://modelcontextprotocol.io/) for any MCP-compatible AI agent or editor.

```bash
gmax mcp
```

This starts a stdio-based MCP server that auto-launches the `gmax serve` daemon. Available tools:

| Tool | Description |
| --- | --- |
| `semantic_search` | Natural language code search with score filtering and per-file caps |
| `code_skeleton` | Collapsed file structure (~4x fewer tokens than reading the full file) |
| `trace_calls` | Call graph — who calls a symbol and what it calls |
| `list_symbols` | List indexed functions, classes, and types with definition locations |
| `index_status` | Check daemon status, file count, embed mode, and index age |


## Commands

### `gmax search`

The default command. Searches the current directory using semantic meaning.

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
| `-d`, `--dry-run` | Show what would be indexed without actually indexing. | `false` |

**Examples:**

```bash
# General concept search
gmax "API rate limiting logic"

# Deep dive (show more matches per file)
gmax "error handling" --per-file 5

# Just give me the files
gmax "user validation" --compact

# Show relevance scores and filter low-confidence matches
gmax "authentication" --scores --min-score 0.5

# Show skeletons of matching files
gmax "database connection" --skeleton
```

### `gmax index`

Manually indexes the repository. Useful if you want to pre-warm the cache or if you've made massive changes outside of the editor.

- Respects `.gitignore` and `.gmaxignore` (see [Configuration](#ignoring-files) section).
- **Smart Indexing:** Only embeds code and config files. Skips binaries, lockfiles, and minified assets.
- **Bounded Concurrency:** Uses a fixed thread pool to keep your system responsive.
- **Semantic Chunking:** Uses TreeSitter grammars for supported languages (TypeScript, JavaScript, Python, Go, Rust, C/C++, Java, C#, Ruby, PHP, Swift, Kotlin, JSON).

**Options:**

| Flag | Description | Default |
| --- | --- | --- |
| `-d`, `--dry-run` | See what would be indexed without making changes. | `false` |
| `-p`, `--path <dir>` | Path to index (defaults to current directory). | `.` |
| `-r`, `--reset` | Remove existing index and re-index from scratch. | `false` |
| `-v`, `--verbose` | Show detailed progress with file names. | `false` |

**Examples:**

```bash
gmax index                    # Index current dir
gmax index --dry-run          # See what would be indexed
gmax index --verbose          # Watch detailed progress (useful for debugging)
gmax index --reset            # Full re-index from scratch
```

### `gmax serve`

Runs a lightweight HTTP server with live file watching so searches stay hot in RAM.

- Keeps LanceDB and the embedding worker resident for <50ms responses.
- **Live reindexing:** Watches the repo (via chokidar) and incrementally re-indexes on file change.
- **Idle timeout:** Automatically shuts down after 30 minutes of inactivity (disable with `--no-idle-timeout`).
- Endpoints:
  - `GET /health` — liveness check
  - `GET /stats` — file count, chunk count, embed mode, index age, watcher status
  - `POST /search` — `{ query, limit, path }`

**Options:**

| Flag | Description |
| --- | --- |
| `-p, --port <port>` | Port to listen on (default `4444`, retries up to 10 ports if taken) |
| `-b, --background` | Run server in background and exit immediately |
| `--cpu` | Use CPU-only embeddings (skip MLX GPU server) |
| `--no-idle-timeout` | Disable the 30-minute idle shutdown |

**Port Selection (priority order):**
1. Explicit `-p <port>` flag
2. `GMAX_PORT` environment variable
3. Default `4444` (auto-increments if in use)

**Usage:**

```bash
gmax serve                    # Foreground, port 4444 (or next available)
gmax serve --background       # Background mode, auto port
gmax serve -b -p 5000         # Background on specific port
```

**Subcommands:**

```bash
gmax serve status             # Show server status for current directory
gmax serve stop               # Stop server in current directory
gmax serve stop --all         # Stop all running gmax servers
```

**Example workflow:**

```bash
# Start servers in multiple projects
cd ~/project-a && gmax serve -b    # Starts on port 4444
cd ~/project-b && gmax serve -b    # Starts on port 4445 (auto-increment)

# Check status
gmax serve status

# Stop all when done
gmax serve stop --all
```

Claude Code hooks start/stop this automatically; you rarely need to run it manually.

### `gmax list`

Lists all indexed repositories (stores) and their metadata.

```bash
gmax list
```

Shows store names, sizes, and last modified times. Useful for seeing what's indexed and cleaning up old stores.

### `gmax skeleton`

Generates a compressed "skeleton" of a file, showing only signatures, types, and class structures while eliding function bodies.

```bash
gmax skeleton src/lib/auth.ts
```

**Output:**
```typescript
class AuthService {
  validate(token: string): boolean {
    // → jwt.verify, checkScope, .. | C:5 | ORCH
  }
}
```

**Modes:**
- `gmax skeleton <file>`: Skeletonize specific file.
- `gmax skeleton <Symbol>`: Find symbol in index and skeletonize its file.
- `gmax skeleton "query"`: Search for query and skeletonize top matches.

**Supported Languages:**
TypeScript, JavaScript, Python, Go, Rust, Java, C#, C++, C, Ruby, PHP, Swift, Kotlin.


### `gmax doctor`

Checks installation health, model paths, and database integrity.

```bash
gmax doctor
```

## Performance & Architecture

gmax is designed to be a "good citizen" on your machine:

1.  **Bounded Concurrency:** Chunking/embedding stay within small thread pools (1–4) and capped batch sizes to keep laptops responsive.
2.  **Smart Chunking:** Uses `tree-sitter` to split code by function/class boundaries, ensuring embeddings capture complete logical blocks.
3.  **Deduplication:** Identical code blocks (boilerplate, license headers) are embedded once and cached, saving space and time.
4.  **Semantic Split Search:** Queries both "Code" and "Docs" separately to ensure documentation doesn't drown out implementation details, then reranks with ColBERT.
5.  **Global Batching:** A producer/consumer pipeline decouples chunking from embedding. Files are chunked concurrently, queued, embedded in fat batches, and written to LanceDB in bulk.
6.  **Anchor-Only Scans & Batch Deletes:** File discovery and stale cleanup hit only anchor rows, and stale/changed paths are removed with a single `IN` delete to minimize I/O.
7.  **Structural Boosting:** Function/class chunks get a small score boost; test/spec paths are slightly downweighted to bubble up primary definitions first.
8.  **Role Classification:** Detects `ORCHESTRATION` functions (high complexity, many calls) vs `DEFINITION` (types/classes) to help agents prioritize where to read.

## Configuration

### Automatic Repository Isolation

gmax automatically creates a unique index for each repository based on:

1. **Git Remote URL** (e.g., `github.com/facebook/react` → `facebook-react`)
2. **Git Repo without Remote** → directory name + hash (e.g., `utils-7f8a2b3c`)
3. **Non-Git Directory** → directory name + hash for collision safety

**Examples:**
```bash
cd ~/work/myproject        # Auto-detected: owner-myproject
gmax "API handlers"

cd ~/personal/utils        # Auto-detected: utils-abc12345
gmax "helper functions"
```

Stores are isolated automatically — no manual `--store` flags needed!

### Ignoring Files

gmax respects both `.gitignore` and `.gmaxignore` files when indexing. Create a `.gmaxignore` file in your repository root to exclude additional files or patterns from indexing.

**`.gmaxignore` syntax:**
- Uses the same pattern syntax as `.gitignore`
- Patterns are relative to the repository root
- Supports glob patterns, negation (`!`), and directory patterns (`/`)


### Index Management

- **View indexed projects:** `gmax list`
- **Index location:** `.gmax/` in each project root
- **Clean up a project index:** `rm -rf .gmax/` in the project directory
- **Global data (models, grammars):** `~/.gmax/`

### GPU Embeddings (Apple Silicon)

On Macs with Apple Silicon, gmax can use MLX for GPU-accelerated embeddings instead of ONNX on CPU.

1. Run `gmax setup` and select **GPU (MLX)** when prompted.
2. Start the server: `gmax serve` (automatically starts the MLX embed server).
3. To force CPU mode on a GPU-configured project: `gmax serve --cpu`.

The MLX embed server runs on port `8100` by default (configurable via `MLX_EMBED_PORT`). It is managed automatically by `gmax serve` — you don't need to start it manually.

## Development

```bash
pnpm install
pnpm build        # or pnpm dev
pnpm test         # vitest
pnpm format       # biome check
```

## Troubleshooting

- **Index feels stale?** Run `gmax index` to refresh, or use `gmax serve` for live reindexing.
- **Weird results?** Run `gmax doctor` to verify models.
- **Index getting stuck?** Run `gmax index --verbose` to see which file is being processed.
- **Need a fresh start?** Delete `.gmax/` in your project root and run `gmax index`.
- **MLX server won't start?** Check `/tmp/mlx-embed-server.log` for errors. Use `gmax serve --cpu` to fall back to CPU.

## Attribution

gmax is built upon the foundation of [mgrep](https://github.com/mixedbread-ai/mgrep) by MixedBread. We acknowledge and appreciate the original architectural concepts and design decisions that informed this work.


See the [NOTICE](NOTICE) file for detailed attribution information.

## License

Licensed under the Apache License, Version 2.0.
See [LICENSE](LICENSE) and [Apache-2.0](https://opensource.org/licenses/Apache-2.0) for details.

