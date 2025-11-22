<div align="center">
  <h1>osgrep</h1>
  <p><em>Semantic search for your codebase.</em></p>
  <a href="https://opensource.org/licenses/Apache-2.0"><img src="https://img.shields.io/badge/License-Apache%202.0-blue.svg" alt="License: Apache 2.0" /></a><br>
</div>

Natural-language search that works like `grep`. Fast, local, and works with coding agents.

- Semantic, multilingual & multimodal
- On-demand indexing for fast repeated searches
- 100% local embeddings via `transformers.js`
- Integrates with coding agents

## Quick Start

1. **Install**
   ```bash
   npm install -g osgrep    # or pnpm / bun
   ```

2. **Setup (optional, but recommended)**
   ```bash
   osgrep setup
   ```
   Downloads models (~150MB) so your first search is instant. Skip this if you prefer—models download automatically on first use.

3. **Start searching**
   ```bash
   cd path/to/repo
   osgrep "where do we set up auth?" src/lib
   osgrep -m 25 "store schema"
   ```
   Your first search will automatically index the repository. Subsequent searches are fast and use the cached index. Searches default to the current working directory unless you pass a path.

   **Optional:** Manually index with `osgrep index` if you want to pre-index or refresh the index.

Today, osgrep works great on: code and text documents.  
**Coming soon:** PDFs, images, audio, and video.

## Coding Agent Integration

**Claude Code**  
1. Run `osgrep install-claude-code`
2. Open Claude Code, enable the plugin, and point it at your repository
3. The repository will be automatically indexed on first use, or run `osgrep index` to pre-index
4. Results stream into the chat with file paths and line hints
  
More agents coming soon (Codex, Cursor, Windsurf, etc.).


## Commands =

| Command | Purpose |
| --- | --- |
| `osgrep` / `osgrep search <pattern> [path]` | Natural-language search with many `grep`-style flags (`-i`, `-r`, `-m`...). |
| `osgrep setup` | One-time setup: downloads models (~150MB) and prepares osgrep. |
| `osgrep index` | Index the current repo to create a local searchable store. |
| `osgrep doctor` | Check installation health and paths. |
| `osgrep install-claude-code` | Add the osgrep plugin to Claude Code for local queries. |

### osgrep search

`osgrep search` is the default command. Searches the current directory for a pattern.

| Option | Description |
| --- | --- |
| `-m <max_count>` | The maximum number of results to return |
| `-c`, `--content` | Show content of the results |
| `-s`, `--sync` | Sync the local files to the store before searching (always fresh but slower) |

**Examples:**
```bash
osgrep "What code parsers are available?"  # search in the current directory
osgrep "How are chunks defined?" src/models  # search in the src/models directory
osgrep -m 10 "What is the maximum number of concurrent workers in the code parser?"  # limit the number of results to 10
osgrep --sync "latest auth changes"  # always fresh but slower
```

**Workflow:**
- `osgrep "query"` = auto-indexes on first run, then fast repeated searches
- `osgrep --sync "query"` = always fresh but slower (forces re-index before search)
- `osgrep index` = manually pre-index or refresh the index

### osgrep setup

One-time setup that downloads models (~150MB) and prepares your system. This is optional but recommended—it ensures your first `osgrep index` or search is fast. If you skip this, models will download automatically on first use.

```bash
osgrep setup
```

### osgrep index

Manually indexes the current repository and creates a local searchable store. This is optional—the first search will automatically index if needed. Use this command to pre-index or refresh the index after large changes.

It respects the current `.gitignore`, as well as a `.osgrepignore` file in the
root of the repository. The `.osgrepignore` file follows the same syntax as the
[`.gitignore`](https://git-scm.com/docs/gitignore) file.

| Option | Description |
| --- | --- |
| `-d`, `--dry-run` | Dry run the indexing process (no actual file syncing) |
| `-p`, `--path <dir>` | Path to index (defaults to current directory) |

**Examples:**
```bash
osgrep index  # index the current repository
osgrep index --path src/lib  # index a specific subdirectory
osgrep index --dry-run  # see what would be indexed without actually indexing
```

### osgrep doctor

Check the health of your osgrep installation. Shows paths to data directories, model status, and system information.

```bash
osgrep doctor
```

## How it works

- Files are embedded locally with `transformers.js` and stored in `~/.osgrep/data` via LanceDB.
- Searches combine vector and FTS matches with reciprocal-rank fusion.
- Results include relative paths plus contextual hints (line ranges for text, page numbers for PDFs, etc.).
- Runs offline.

## Configuration

- `--store <name>` isolates workspaces (per repo, per team, per experiment). Stores are created on demand.
- Ignore rules come from git, so temp files, build outputs, and vendored deps stay out of embeddings.
- `index` reports progress (`processed / indexed`) as it scans.
- `search` accepts most `grep`-style switches.

**Environment Variables:**
- `MXBAI_STORE`: Override the default store name (default: `osgrep`)

## Development

```bash
pnpm install
pnpm build        # or pnpm dev for a quick compile + run
pnpm format       # biome formatting + linting
```

- Executable at `dist/index.js` (built from TypeScript via `tsc`).
- Run `npx husky init` once after cloning.
- Tests not wired up yet—run `pnpm typecheck` before publishing.

## Troubleshooting

- **Index feels stale**: run `osgrep index` again after large refactors.
- **Need a fresh store**: delete `~/.osgrep/data/<store>` and run `osgrep index`.

## Version History

### v0.1.7
- Auto-setup: directories and models are created automatically on first use
- Auto-index: first search automatically indexes empty repositories
- Refactored setup and store logic into reusable helper modules
- Improved user experience with better messaging

### v0.1.6
- Improved `osgrep setup` with better resource cleanup
- Cleaner output formatting

### v0.1.5
- Added `osgrep setup` command for one-time model download
- Created standalone `model-loader` module for clean model management
- Fixed auto-exit behavior for all commands

### v0.1.4
- Commands now auto-exit on success (no more Ctrl+C needed!)
- Removed watch mode and simplified dependencies

### v0.1.3
- Changed from scoped package (`@ryandonofrio/osgrep`) to unscoped (`osgrep`)
- Simplified installation: `npm install -g osgrep`

## License

Apache-2.0. See the [LICENSE](https://opensource.org/licenses/Apache-2.0) file for details.
