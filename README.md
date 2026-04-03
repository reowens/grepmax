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
- **Call Graph Tracing:** Map dependencies with `trace`, find tests with `test`, measure blast radius with `impact`.
- **Role Detection:** Distinguishes `ORCHESTRATION` (high-level logic) from `DEFINITION` (types/classes).
- **Local & Private:** 100% local embeddings via ONNX (CPU) or MLX (Apple Silicon GPU).
- **Centralized Index:** One database at `~/.gmax/` — index once, search from anywhere.
- **Agent-Ready:** `--agent` flag returns compact one-line output — ~90% fewer tokens than default.

## Quick Start

```bash
npm install -g grepmax        # 1. Install
cd my-repo && gmax add        # 2. Add + index
gmax "where do we handle auth?" --agent  # 3. Search
```

No setup required — gmax auto-detects your platform (GPU on Apple Silicon, CPU elsewhere) and downloads models on first use.

### Setup & Config

```bash
gmax setup                    # Interactive wizard (models, embedding mode, plugins)
gmax config                   # View current settings
gmax config --embed-mode gpu  # Switch to GPU (Apple Silicon)
gmax doctor                   # Health check
gmax doctor --fix             # Auto-repair (compact, prune, remove stale locks)
```

### Core Commands

```bash
gmax "where do we handle auth?" --agent  # Semantic search (compact output)
gmax extract handleAuth                  # Full function body with line numbers
gmax peek handleAuth                     # Signature + callers + callees
gmax trace handleAuth -d 2              # Call graph (2-hop)
gmax skeleton src/lib/search/           # File structure (bodies collapsed)
gmax symbols auth                       # List indexed symbols
```

### Analysis Commands

```bash
gmax diff main                           # Changed files vs main
gmax diff main --query "auth changes"    # Semantic search within changes
gmax test handleAuth                     # Find tests via reverse call graph
gmax impact handleAuth                   # Dependents + affected tests
gmax similar handleAuth                  # Find similar code patterns
gmax context "auth system" --budget 4000 # Token-budgeted topic summary
```

### Project Commands

```bash
gmax project                  # Languages, structure, key symbols
gmax related src/lib/auth.ts  # Dependencies + dependents
gmax recent                   # Recently modified files
gmax status                   # All indexed projects + chunk counts
```

In our public benchmarks, `grepmax` can save about 20% of your LLM tokens and deliver a 30% speedup.

<div align="center">
  <img src="public/bench.png" alt="gmax benchmark" width="100%" style="border-radius: 8px; margin: 20px 0;" />
</div>

## Agent Plugins

gmax integrates with Claude Code, OpenCode, Codex, and Factory Droid. Install all detected clients at once:

```bash
gmax plugin add               # Install all detected clients
gmax plugin                   # Show plugin status
gmax plugin remove             # Remove all plugins
```

Or manage individually:

```bash
gmax plugin add claude         # Claude Code only
gmax plugin add opencode       # OpenCode only
gmax plugin add codex          # Codex only
gmax plugin add droid          # Factory Droid only
gmax plugin remove claude      # Remove specific plugin
```

Plugins auto-update when you run `npm install -g grepmax@latest` — no need to re-run `gmax plugin add`.

### How it works per client

- **Claude Code:** Plugin with hooks (SessionStart, CwdChanged, SubagentStart, PreToolUse). Model uses CLI via `Bash(gmax ... --agent)`.
- **OpenCode:** Tool shim with dynamic SKILL + session plugin for daemon startup. Model calls gmax tool directly.
- **Codex:** MCP server registration + AGENTS.md skill instructions.
- **Factory Droid:** Skills + SessionStart/SessionEnd hooks for daemon lifecycle.

### MCP Server

`gmax mcp` starts a stdio-based MCP server for clients that support MCP but can't run shell commands (Cursor, Windsurf, custom agents).

| Tool | Description |
| --- | --- |
| `semantic_search` | Search by meaning. 16+ params: query, limit, role, language, scope (project/all), etc. |
| `search_all` | Cross-project search. Same params + project filtering. |
| `code_skeleton` | File structure with bodies collapsed (~4x fewer tokens). |
| `trace_calls` | Call graph: importers, callers (multi-hop), callees with file:line. |
| `extract_symbol` | Complete function/class body by symbol name. |
| `peek_symbol` | Compact overview: signature + callers + callees. |
| `list_symbols` | Indexed symbols with role and export status. |
| `index_status` | Index health: chunks, files, projects, watcher status. |
| `summarize_project` | Project overview: languages, structure, key symbols, entry points. |
| `summarize_directory` | Generate LLM summaries for indexed chunks. |
| `related_files` | Dependencies and dependents by shared symbols. |
| `recent_changes` | Recently modified indexed files. |
| `diff_changes` | Search scoped to git changes. |
| `find_tests` | Find tests via reverse call graph. |
| `impact_analysis` | Dependents + affected tests for a symbol or file. |
| `find_similar` | Vector similarity search. |
| `build_context` | Token-budgeted topic summary. |
| `investigate` | Agentic codebase Q&A using local LLM + gmax tools. |
| `review_commit` | Review a git commit for bugs, security issues, and breaking changes. |
| `review_report` | Get accumulated code review findings for the current project. |

## Search Options

```bash
gmax "query" [options]
```

| Flag | Description | Default |
| --- | --- | --- |
| `--agent` | Compact one-line output for AI agents. | `false` |
| `-m <n>` | Max results. | `5` |
| `--per-file <n>` | Max matches per file. | `3` |
| `--role <role>` | Filter: `ORCHESTRATION`, `DEFINITION`, `IMPLEMENTATION`. | — |
| `--lang <ext>` | Filter by extension (e.g. `ts`, `py`). | — |
| `--file <name>` | Filter by filename. | — |
| `--exclude <prefix>` | Exclude path prefix. | — |
| `--symbol` | Append call graph after results. | `false` |
| `--imports` | Prepend file imports per result. | `false` |
| `--name <regex>` | Filter by symbol name. | — |
| `--skeleton` | Show file skeletons for top matches. | `false` |
| `--context-for-llm` | Full function bodies + imports per result. | `false` |
| `--budget <tokens>` | Cap output tokens (for `--context-for-llm`). | `8000` |
| `--explain` | Show scoring breakdown per result. | `false` |
| `-C <n>` | Context lines before/after. | `0` |
| `--root <dir>` | Search a different project. | cwd |
| `--min-score <n>` | Minimum relevance score. | `0` |

## Background Daemon

A single daemon watches all registered projects via native OS file events (FSEvents/inotify). Changes are detected in sub-second and incrementally reindexed. All writes to LanceDB are routed through the daemon via IPC, eliminating lock contention.

```bash
gmax watch --daemon -b        # Start daemon manually
gmax watch stop               # Stop daemon
gmax status                   # See all projects + watcher status
```

The daemon auto-starts when you run `gmax add`, `gmax index`, `gmax remove`, or `gmax summarize`. It shuts down after 30 minutes of inactivity.

## Local LLM (optional)

gmax can use a local LLM (via llama-server) for agentic codebase investigation. This is entirely opt-in and disabled by default — gmax works fine without it.

```bash
gmax llm on                   # Enable LLM features (persists to config)
gmax llm start                # Start llama-server (auto-starts daemon too)
gmax llm status               # Check server status
gmax llm stop                 # Stop llama-server
gmax llm off                  # Disable LLM + stop server
```

### Investigate

Ask questions about your codebase — the LLM autonomously uses gmax tools (search, trace, peek, impact, related) to gather evidence and synthesize an answer.

```bash
gmax investigate "how does authentication work?"
gmax investigate "what would break if I changed VectorDB?" -v
gmax investigate "where are API routes defined?" --root ~/project
```

### Review

Automatic code review on git commits. Extracts the diff, gathers codebase context (callers, dependents, related files), and prompts the LLM for structured findings.

```bash
gmax review                           # Review HEAD
gmax review --commit abc1234          # Review specific commit
gmax review --commit HEAD~3 -v        # Verbose — shows context gathering + LLM progress
gmax review report                    # Show accumulated findings
gmax review report --json             # Raw JSON output
gmax review clear                     # Clear report
```

#### Post-commit hook

Install a git hook that automatically reviews every commit in the background via the daemon:

```bash
gmax review install                   # Install in current repo
gmax review install ~/other-repo      # Install in another repo
```

The hook sends an IPC message to the daemon and returns instantly — it never blocks `git commit`. Findings accumulate in the report.

### LLM Configuration

| Variable | Description | Default |
| --- | --- | --- |
| `GMAX_LLM_MODEL` | Path to GGUF model file | (none) |
| `GMAX_LLM_BINARY` | llama-server binary | `llama-server` |
| `GMAX_LLM_PORT` | Server port | `8079` |
| `GMAX_LLM_IDLE_TIMEOUT` | Minutes before auto-stop | `30` |

## Architecture

All data lives in `~/.gmax/`:
- `lancedb/` — LanceDB vector store (centralized, all projects)
- `cache/meta.lmdb` — file metadata cache (hashes, mtimes)
- `cache/watchers.lmdb` — watcher/daemon registry (LMDB, crash-safe)
- `daemon.sock` — Unix domain socket for daemon IPC
- `daemon.pid` — PID file for daemon dedup
- `logs/` — daemon and server logs (5MB rotation)
- `config.json` — global config (model tier, embed mode)
- `models/` — embedding models
- `grammars/` — Tree-sitter grammars
- `projects.json` — registry of indexed directories

**Pipeline:** Walk (gitignore-aware) → Chunk (Tree-sitter) → Embed (384-dim Granite via ONNX/MLX) → Store (LanceDB + LMDB) → Search (vector + FTS + RRF fusion + ColBERT rerank)

**Supported Languages:** TypeScript, JavaScript, Python, Go, Rust, Java, C#, C++, C, Ruby, PHP, Swift, Kotlin, JSON, YAML, Markdown, SQL, Shell.

## Configuration

```json
// ~/.gmax/config.json
{
  "modelTier": "small",
  "vectorDim": 384,
  "embedMode": "gpu"
}
```

### Ignoring Files

gmax respects `.gitignore` and `.gmaxignore`:

```gitignore
# .gmaxignore
docs/generated/
*.test.ts
fixtures/
```

### Environment Variables

| Variable | Description | Default |
| --- | --- | --- |
| `GMAX_EMBED_MODE` | Force `cpu` or `gpu` | Auto-detect |
| `GMAX_WORKER_THREADS` | Worker threads for embedding | 50% of cores |
| `GMAX_DEBUG` | Debug logging | Off |
| `GMAX_SUMMARIZER` | Enable summarizer auto-start (`1`) | Off |

## Troubleshooting

```bash
gmax doctor                   # Check health
gmax doctor --fix             # Auto-repair (compact, prune, fix locks)
gmax doctor --agent           # Machine-readable health output
gmax index --reset            # Full reindex from scratch
gmax watch stop && gmax watch --daemon -b  # Restart daemon
```

## Contributing

See [CLAUDE.md](CLAUDE.md) for development setup, commands, and architecture details.

## Attribution

grepmax is built upon the foundation of [mgrep](https://github.com/mixedbread-ai/mgrep) by MixedBread. See the [NOTICE](NOTICE) file for details.

## License

Licensed under the Apache License, Version 2.0. See [LICENSE](LICENSE).
