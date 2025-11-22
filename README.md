<div align="center">
  <h1>osgrep</h1>
  <p><em>Semantic search for your codebase.</em></p>
  <a href="https://opensource.org/licenses/Apache-2.0"><img src="https://img.shields.io/badge/License-Apache%202.0-blue.svg" alt="License: Apache 2.0" /></a><br>
</div>

Natural-language search that works like `grep`. Fast, local, and works with coding agents.

- **Semantic:** Finds concepts ("auth logic"), not just strings.
- **Local & Private:** 100% local embeddings via `transformers.js`.
- **Adaptive:** Runs fast on desktops, throttles down on laptops to prevent overheating.
- **Agent-Ready:** Native integration with Claude Code.

## Quick Start

1. **Install**
   ```bash
   npm install -g osgrep    # or pnpm / bun
````

2.  **Setup (Recommended)**

    ```bash
    osgrep setup
    ```

    Downloads embedding models (\~150MB) upfront. If you skip this, models download automatically on first use.

3.  **Search**

    ```bash
    cd my-repo
    osgrep "where do we handle authentication?"
    ```

    **Your first search will automatically index the repository.** Subsequent searches use the cached index and are near-instant.

## Coding Agent Integration

**Claude Code** 1. Run `osgrep install-claude-code`
2\. Open Claude Code (`claude`) and ask it questions about your codebase.
3\. It will use `osgrep` to find relevant context automatically.

## Commands

### `osgrep search`

The default command. Searches the current directory using semantic meaning.

```bash
osgrep "how is the database connection pooled?"
```

**Options:**
| Flag | Description | Default |
| --- | --- | --- |
| `-m <n>` | Max total results to return. | `25` |
| `--per-file <n>` | Max matches to show per file. | `1` |
| `-c`, `--content` | Show full chunk content instead of snippets. | `false` |
| `--scores` | Show relevance scores (0.0-1.0). | `false` |
| `--compact` | Show file paths only (like `grep -l`). | `false` |
| `-s`, `--sync` | Force re-index changed files before searching. | `false` |

**Examples:**

```bash
# General concept search
osgrep "API rate limiting logic"

# Deep dive (show more matches per file)
osgrep "error handling" --per-file 5

# Just give me the files
osgrep "user validation" --compact
```

### `osgrep index`

Manually indexes the repository. Useful if you want to pre-warm the cache or if you've made massive changes outside of the editor.

  * Respects `.gitignore` and `.osgrepignore`.
  * **Smart Indexing:** Only embeds code and config files. Skips binaries, lockfiles, and minified assets.
  * **Adaptive Throttling:** Monitors your RAM and CPU usage. If your system gets hot, indexing slows down automatically.

<!-- end list -->

```bash
osgrep index              # Index current dir
osgrep index --dry-run    # See what would be indexed
```

### `osgrep doctor`

Checks installation health, model paths, and database integrity.

```bash
osgrep doctor
```

## Performance & Architecture

osgrep is designed to be a "good citizen" on your machine:

1.  **The Thermostat:** Indexing adjusts concurrency in real-time based on memory pressure and CPU speed. It won't freeze your laptop.
2.  **Smart Chunking:** Uses `tree-sitter` to split code by function/class boundaries, ensuring embeddings capture complete logical blocks.
3.  **Deduplication:** Identical code blocks (boilerplate, license headers) are embedded once and cached, saving space and time.
4.  **Hybrid Search:** Uses Reciprocal Rank Fusion (RRF) to combine Vector Search (semantic) with FTS (keyword) for best-of-both-worlds accuracy.

## Configuration

  - **Stores:** Data is saved in `~/.osgrep/data`.
  - **Isolation:** Use `--store <name>` to isolate different projects or workspaces.
  - **Env Vars:**
      - `MXBAI_STORE`: Default store name (default: `osgrep`).
      - `OSGREP_PROFILE=1`: Enable performance profiling logs.

## Development

```bash
pnpm install
pnpm build        # or pnpm dev
pnpm format       # biome check
```

## Troubleshooting

  - **Index feels stale?** Run `osgrep index` to refresh.
  - **Weird results?** Run `osgrep doctor` to verify models.
  - **Need a fresh start?** Delete `~/.osgrep/data` and re-index.

## License

Licensed under the Apache License, Version 2.0.  
See [Apache-2.0](https://opensource.org/licenses/Apache-2.0) for details.


