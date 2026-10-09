<div align="center">
  <h1>grepmax</h1>
  <p><em>Slash tokens. Save time. Semantic search for your coding agent.</em></p>

  <a href="https://www.npmjs.com/package/grepmax">
    <img src="https://img.shields.io/npm/v/grepmax.svg" alt="npm version" />
  </a>

  <a href="https://www.npmjs.com/package/grepmax">
    <img src="https://img.shields.io/npm/dm/grepmax.svg" alt="npm downloads" />
  </a>

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
- **Agent-Ready:** `--agent` flag returns compact one-line output — ~89% fewer tokens than default.

## Quick Start

Requires **Node.js 22.12.0 or newer**.

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
gmax config --worker-threads 2  # Cap worker processes (auto = default); applies on daemon restart
gmax doctor                   # Health check
gmax doctor --fix             # Repair checks; full-table maintenance is disabled
```

**Storage containment:** full-table compaction is disabled, including forced maintenance and doctor repair. Existing retained index copies are not reclaimed by this release. The verified prune-only recovery path is separate work; normal incremental indexing remains available when the host is healthy and not quarantined. A persistent host safety stop blocks mutation and normal daemon restart; an explicit read-only start can serve the retained index. Installing an update preserves existing quarantine. Speculative embedding warmup and maintenance timers are disabled. Under the default `strict` host policy on macOS, startup, heavy queries, worker forks and MLX launches require known normal OS memory pressure and a healthy kernel-zone sample; warning or unavailable probes pause heavy work while the daemon serves bounded reads. The explicit `critical-only` policy keeps semantic search and indexing available under warning or unavailable probes. Known critical pressure still stops the daemon.

### Core Commands

```bash
gmax "where do we handle auth?" --agent  # Semantic search (compact output)
gmax extract handleAuth                  # Full function body with line numbers
gmax peek handleAuth                     # Signature + callers + callees
gmax trace handleAuth -d 2              # Call graph (2-hop)
gmax skeleton src/lib/auth.ts           # File structure (bodies collapsed)
gmax symbols auth                       # List indexed symbols
```

### Analysis Commands

```bash
gmax log src/lib/auth.ts                 # Git commit history for a path or symbol
gmax test handleAuth                     # Find tests via reverse call graph
gmax impact handleAuth                   # Dependents + affected tests
gmax similar handleAuth                  # Find similar code patterns
gmax audit --top 10                      # God nodes, hub files, file cycles, dead candidates
gmax surprises --experimental --agent    # Experimental: similar but graph-disconnected file pairs
gmax dead handleAuth                     # Unused-symbol check via call graph (DEAD / PUBLIC EXPORT / LIVE)
gmax context "auth system" --budget 4000 # Token-budgeted topic summary
gmax context src/lib/auth.ts --budget 4000 # Deterministic file/path context
```

### Project Commands

```bash
gmax project                  # Languages, structure, key symbols
gmax related src/lib/auth.ts  # Dependencies + dependents
gmax status                   # All indexed projects + chunk counts
gmax status --json            # The same plus daemon, settings and workers, as JSON
```

The recorded benchmark below showed about 20% fewer LLM tokens and a 30% speedup on its workload. Results depend on the repository, query and agent workflow.

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

After upgrading with `npm install -g grepmax@latest`, run `gmax plugin update` (or `gmax plugin update <client>`) to refresh integrations. Package installation does not modify your agent configuration; its postinstall script only prints this reminder.

Starting with v0.26.51, the installer refreshes an existing Claude marketplace from its configured source and updates each existing user/project/local installation in its original scope. It does not remove the marketplace, reset disabled preferences, or reinstall after a refresh failure. New installations use the local npm package. An existing source is retained; moving to another source is a separate migration. Codex instructions follow `CODEX_HOME` (default `~/.codex`), and a matching STDIO registration retains its existing options. A different existing launch configuration is reported for review instead of overwritten. Refresh the plugins after upgrading to activate the hook and installer repairs.

### How it works per client

- **Claude Code:** Plugin with session/directory hooks, guidance hooks and activity renewal on UserPromptSubmit/PostToolUse for Bash. Model uses CLI via `Bash(gmax ... --agent)`; the plugin does not register an MCP server. Source hooks honor the autostart kill switch, start only after a definite absent socket and never fall back to a separate watcher beside a live daemon.
- **OpenCode:** Tool shim with dynamic SKILL + session plugin for daemon startup. Model calls gmax tool directly.
- **Codex:** MCP server registration + AGENTS.md skill instructions.
- **Factory Droid:** Skills + SessionStart/SessionEnd hooks for daemon lifecycle.

### MCP Server

MCP is local-only: the client spawns it and communicates through stdin/stdout pipes. It has no HTTP, SSE, or TCP listener and cannot be reached over the network. The daemon socket is restricted to your user account.

`gmax mcp` uses the official MCP SDK v2.3.0 and serves both legacy (2025 handshake) and modern (2026-07-28 discovery and per-request metadata) clients over the same stdio entry. Discovery and catalog listing perform no daemon, model or watcher startup. Index-reading tools acquire watch leases lazily; one timer renews the primary projects actually used, and disconnect closes the SDK connection and its timer.

Clients requesting progress receive operation-stage messages with increasing stage counts and no estimated percentage. Cancelling a daemon read closes that request's IPC connection and prevents subsequent tool operations or fallback work; concurrent requests and the session's watch leases continue. An already-running local native query finishes under its existing deadline before its store closes. Cancellation does not undo indexing writes or interrupt optional LLM work.

`gmax mcp` starts a stdio-based MCP server for clients that support MCP but can't run shell commands (Cursor, Windsurf, custom agents). Search-backed tools use the singleton daemon when available, avoiding a separate embedding worker per MCP session, and use an in-process worker for supported offline/secondary-store access. An unsupported daemon command requires `gmax watch restart`.

`semantic_search`, `trace_calls`, `dead`, and `index_status` also advertise output schemas and return `structuredContent` with `schemaVersion: 1`, alongside the existing text. Search matches follow the same scope and display filters and include paths, one-based start/end lines, symbols, scores (null when unavailable), and warnings. Trace results preserve caller ancestry and edge confidence; unresolved callees have no location, and omitted callee/importer counts are explicit. Graph conclusions carry `approximate: true`. Index health includes embedding identity, watcher/reconciliation state, and the last compaction result; unavailable health is null or unobserved. These four tools advertise read-only, non-destructive, closed-world annotations. Other tools retain their current contracts.

| Tool | Description |
| --- | --- |
| `semantic_search` | Search by meaning. Pointer mode matches CLI `--agent` output; `detail=code/full` returns snippets. |
| `code_skeleton` | File structure with bodies collapsed (~4x fewer tokens). |
| `trace_calls` | Call graph: importers, callers (multi-hop), callees with file:line. |
| `extract_symbol` | Complete function/class body by symbol name. |
| `peek_symbol` | Compact overview: signature + callers + callees. |
| `dead` | Unused-symbol check via call graph. Returns `DEAD`, `PUBLIC EXPORT`, or `LIVE` with caller count. |
| `audit` | Graph summary: god nodes, hub files, symbol-derived file dependency cycles, and dead-code candidates. |
| `surprising_connections` | Experimental orientation signal: embedding-similar file pairs with no direct indexed static file edge. Requires `experimental:true`. |
| `get_neighbors` | Graph primitive: symbols reachable from a node along call edges within N hops. |
| `find_paths` | Graph primitive: shortest call-graph path between two symbols. |
| `subgraph_for_files` | Graph primitive: local dependency subgraph for a set of files. |
| `list_symbols` | Indexed symbols with role and export status. |
| `list_projects` | List every indexed project (name, root, status, chunks) to pick a search scope. |
| `index_status` | Index health: chunks, files, projects, watcher status. |
| `summarize_project` | Project overview: languages, structure, key symbols, entry points. |
| `summarize_directory` | Compatibility entry; summarization is disabled and generates no summaries. |
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
| `review_risk` | Deterministic risk ranking of symbols a commit touches (blast radius × tests × churn). No LLM. |

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
| `--in <subpath>` | Restrict to a sub-path of the project (repeatable). | — |
| `--seed-file <path>` | Bias results toward files in your working context (repeatable). | — |
| `--seed-symbol <name>` | Bias results toward an identifier you're working with (repeatable). | — |
| `--skeleton` | Show file skeletons for top matches. | `false` |
| `--context-for-llm` | Full function bodies + imports per result. | `false` |
| `--budget <tokens>` | Cap output tokens (for `--context-for-llm`). | `8000` |
| `--explain` | Show scoring breakdown per result. | `false` |
| `--scores` | Show relevance scores. | `false` |
| `--compact` | Compact hits view (paths + line ranges + role/preview). | `false` |
| `--plain` | Disable ANSI colors and use simpler formatting. | `false` |
| `-c, --content` | Show full chunk content instead of snippets. | `false` |
| `-C <n>` | Context lines before/after. | `0` |
| `-s, --sync` | Sync local files to the store before searching. | `false` |
| `--root <dir>` | Search a different project. | cwd |
| `--all-projects` | Search every indexed project; results grouped by project. | `false` |
| `--projects <list>` | Search only these projects (comma-separated names). | — |
| `--exclude-projects <list>` | With `--all-projects`, skip these projects. | — |
| `--min-score <n>` | Minimum score relative to this query’s top match, not an absolute confidence threshold. | `0` |

v0.26.50 carries an explicit `--per-file` value into retrieval as well as formatting. Values must be positive safe integers. Omitted requests retain the searcher's configured `GMAX_MAX_PER_FILE` cap or three; larger explicit values still respect `-m` and the existing candidate/rerank bounds. Explicit overrides require a daemon advertising `capabilities.perFileSearch: 1`; older live daemons are refused with an update/restart hint, without opening a fallback reader. An incompatible optional local HTTP fast path is skipped. v0.26.49 and older releases do not support this retrieval override.

## Experimental Orientation

`gmax surprises --experimental` finds file pairs that are semantically similar but not already connected by the indexed static graph. Use it for architecture orientation, duplicate-logic sweeps, and cross-package drift checks, not as proof that two files are unrelated.

```bash
gmax surprises --experimental --agent
gmax surprises --experimental --in packages/app/src --dir-depth 4 --agent
gmax surprises --experimental --exclude generated --top 10
```

The CLI and MCP output include score, max similarity, pair count, representative symbols, directory buckets, top similarities, applied penalties, and `gmax skeleton` follow-up hints. On large monorepos, prefer `--in`/`--exclude`; the default scan is capped at 50,000 rows and user-provided `--max-rows` is capped at 100,000. If a narrow `--in` scope returns no findings, increase `--dir-depth` so subdirectories are compared inside the scope.

Surprises excludes generated code, bindings, fixtures and GraphQL schema/operation output by default. Use CLI `--include-generated` or MCP `include_generated: true` to include these families; `--include-tests` / `include_tests` controls test files separately.

### Analysis coverage and compact output

Project overviews disclose when their language, directory, role and symbol breakdowns cover the first 200,000 chunks. CLI and MCP output label sampled chunk/file counts and show the full project chunk inventory separately. Inventory counting streams only paths in small batches with an execution deadline.

Architecture audits omit unresolved same-name definitions from rankings, cycles and dead-code claims, and report the number omitted. Compact CLI audit and MCP cycle rows retain total file/edge counts and show up to eight complete paths within 1,000 characters, with an explicit omitted-file count.

CLI `gmax skeleton --agent` and MCP `code_skeleton` text show at most 120 lines / 6,000 characters per file and report omitted lines and characters. CLI human output and JSON structure remain complete.

## Existing-index document search

`gmax mcp --existing-index-only` exposes a separate read-only stdio MCP contract
for Markdown document coverage and semantic pointers. It uses an existing daemon,
index and already-warm compatible query worker. It cannot start a daemon, watch a
project, initialize a model, fall back to another backend or mutate the index.
Cold, busy or unavailable resources return an explicit unavailable state.

Document query admission follows the configured host guard policy. On macOS,
default `strict` requires fresh aggregate resource admission; explicit
`critical-only` checks OS/kernel critical pressure without an aggregate scan or
ledger access. Warning or unavailable measurements stay diagnostic in that mode.
Both policies preserve containment checks. Up to four document queries can wait
FIFO for an already-warm compatible worker for up to two seconds, taking a turn
between indexing files. After four consecutive document queries, waiting ordinary
work gets a turn. Saturation or wait expiry returns `busy`; cold workers still
refuse. This wait cannot start, replace or scale workers, and it never interrupts
an in-flight file. Admission/readiness are checked again before dispatch, and the
overall ten-second deadline includes waiting. Readiness means a request can be
admitted, including this bounded wait. Long indexing files can still return `busy`.

Results contain canonical paths and one-based source ranges, without cached source
bodies. The first slice uses dense retrieval with explicit path scope and bounded
deadlines. Consumers must reread and authorize current source before using a
pointer. See [the document-search contract](DOCUMENT-SEARCH.md) for tool schemas,
limits, hash provenance and isolated qualification.

## Background Daemon

A single daemon watches your projects via native OS file events (FSEvents/inotify). Changes are detected in sub-second and incrementally reindexed. All writes to LanceDB are routed through the daemon via IPC, eliminating lock contention.

Filesystem watching belongs to gmax, in both daemon and standalone watch modes. Hetchy Developer is an optional monitor/controller that reads gmax status and invokes gmax commands. Watching, indexing and search must work with the dev app and its helper absent or stopped. Any future shared watcher extraction must be an independent component or package with an interface and lifecycle usable without Hetchy Developer; the dev app cannot become a gmax runtime dependency.

The daemon watches only projects that are in use: each Claude Code session (its MCP server and session hooks) holds a lease on its project, and `gmax add` / `gmax index` take a short one. When the last lease ends the project is unwatched; its index stays searchable, and the next session's catch-up scan picks up whatever changed in between. Set `GMAX_WATCH_ALL=1` to watch every registered project instead.

```bash
gmax watch --daemon -b        # Start daemon manually
gmax watch stop               # Stop daemon
gmax watch restart            # Stop it, wait for it to exit, start a fresh one (--json)
gmax status                   # See all projects + watcher status
```

Adding or indexing a project can start the daemon automatically. MCP acquires primary-project watch leases lazily when an index-reading tool is used; discovery and catalog listing start no background work. It shuts down after 4 hours of inactivity, and hands off to a fresh daemon after 24 hours or once its memory footprint passes 2.5 GB. File-change batches are processed on up to four worker processes by default, added only when work backs up, with one kept free for searches; full-table compaction and new FTS/ANN index builds are disabled by containment. Existing indexes remain readable. Host safety stops persist across restart and block heavy operations.

`gmax watch status` reports failed files, native watcher recovery or polling, dropped-event counts, and the last complete filesystem reconciliation. FSEvents dropped-event warnings keep the native stream attached and preserve the accompanying events. A reconciliation covers the gap; repeated warnings coalesce into one later scan, with a 30-second scan interval. Recovery stays visible until a complete scan covers the latest gap. Other backend errors still trigger subscription recovery; repeated terminal failures fall back to five-minute polling, where recent edits can lag. Search and MCP responses retain health warnings even after the file queue drains. On macOS, gmax also forwards up to eight existing policy-excluded directories to the native event stream, prioritizing dependency, build and development output. Discovery is bounded; remaining paths retain glob filtering and file-policy checks. Policy edits refresh exclusions, and a policy change during subscription setup is checked before keeping a directory exclusion. Live edit batches can run during reconciliation instead of waiting for the full filesystem walk. Whole-project reindex and removal still quiesce the watcher and drain its work before changing the project. A complete reconciliation means the filesystem scan completed; queued embedding work can still be pending.

Live filesystem edits take priority over background catchup and cleanup. Background batches dispatch one file at a time, with at most four catchup files or 50 cleanup paths. They yield between files when a live edit arrives or the two-second dispatch window is reached; an active file or store commit finishes before yielding. Catchup and cleanup alternate, and one background file is admitted after three consecutive live batches so cleanup continues during sustained editing. Existing retry backoff and worker limits remain in effect.

`gmax status --json` exposes `projects[].health.queue`; daemon IPC and MCP `index_status` expose the same `indexState.queue`. Counts `live`, `catchup` and `cleanup` cover waiting paths; `activeFiles` covers the selected current batch, including files not yet dispatched. `oldestLiveEditAgeMs` includes both waiting and current-batch live edits until commit, and is null when none remain. Human/agent status, `gmax watch status` and MCP health text show these measures separately. Initial full indexing uses its existing progress counters rather than these watcher queues. Older daemons may omit queue diagnostics.

Temporary embedding backend outages preserve existing indexed rows and retry with backoff from five seconds up to one minute, without exhausting individual files' retry budgets. MLX failures report bounded transport/protocol details in the daemon log. `gmax status --json` includes the most recent resource snapshot when a recycle threshold has been reached; these counters help investigate memory growth, whose cause requires measurement over time.

## Running under the Claude Code sandbox

Claude Code's Bash sandbox (the default on macOS) allows writes only under the working directory,
the added directories, and the session temp dir, and blocks every Unix socket unless it is listed.
Child processes inherit the profile, so a gmax command run from an agent shell inherits it too —
and gmax needs both kinds of access. A read command either asks the daemon over
`~/.gmax/daemon.sock`, or, with no daemon running, opens the shared store itself; opening the store
takes a lease, which means a `mkdir` under `~/.gmax`. A "read" is a writer as far as the filesystem
is concerned.

Two settings keys cover it (`~/.claude/settings.json`, or the project's `.claude/settings.json`):

```json
"sandbox": {
  "network": { "allowUnixSockets": ["~/.gmax/daemon.sock"] },
  "filesystem": { "allowWrite": ["~/.gmax"] }
}
```

| Key | What it unlocks |
| --- | --- |
| `sandbox.network.allowUnixSockets` | Every read command — search, `test`, `impact`, `trace`, `peek`, `status` — via the daemon. This is the one that matters day to day. |
| `sandbox.filesystem.allowWrite` | The in-process fallback, used only when no daemon is running (autostart disabled, CI). With a daemon up, nothing needs it. |

Without them gmax refuses rather than failing with a bare `EPERM`, exits `2`, and prints the key to add:

```
gmax: cannot reach the daemon socket from this sandbox. Add to Claude Code settings: "sandbox": {"network": {"allowUnixSockets": ["~/.gmax/daemon.sock"]}}
gmax: cannot open the store from this sandbox. Add to Claude Code settings: "sandbox": {"filesystem": {"allowWrite": ["~/.gmax"]}}
```

`gmax doctor` reports the same thing ahead of time as `WARN  Claude Code sandbox` whenever your
settings enable the sandbox without allowing the socket or the store directory. It never edits
Claude Code settings, `--fix` included — they are not gmax's files to write.

On Linux the per-socket list does not exist; the only option is
`"network": { "allowAllUnixSockets": true }`. See
[`docs/known-limitations.md`](docs/known-limitations.md).

## Local LLM (optional)

gmax can use a local LLM (via llama-server) for agentic codebase investigation. This is entirely opt-in and disabled by default — gmax works fine without it.

> **Memory footprint.** `gmax llm start`, `investigate`, and `review` can load a multi-GB
> GGUF model (typical coding models run 16–21 GB). On a memory-constrained machine that can stall
> or hang the host. Start it deliberately, not as a reflex — and if you run coding agents against
> this repo, they should be told not to invoke these on their own initiative. The bundled skill
> already carries that instruction.
>
> Everything else in gmax — search, `trace`, `impact`, `context`, `--context-for-llm` — uses
> local embeddings and the index without a generative LLM.

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

Set `GMAX_LLM_MODEL` to a GGUF file on your machine before starting; the built-in fallback path is machine-specific and may not exist. The server accepts loopback addresses only.

| Variable | Description | Default |
| --- | --- | --- |
| `GMAX_LLM_MODEL` | Path to GGUF model file | Machine-specific fallback |
| `GMAX_LLM_HOST` | Loopback address (`localhost` maps to IPv4 loopback) | `127.0.0.1` |
| `GMAX_LLM_BINARY` | llama-server binary | `llama-server` |
| `GMAX_LLM_PORT` | Server port | `8079` |
| `GMAX_LLM_IDLE_TIMEOUT` | Minutes before auto-stop | `30` |

### Summary compatibility commands

The summarizer is decommissioned. `gmax summarize` and MCP `summarize_directory` remain compatibility entries backed by a no-op; they do not generate summaries. `GMAX_SUMMARIZER` does not enable them. Investigation and review use the separate optional LLM described above.

## Architecture

Default shared data lives in `~/.gmax/`; configured secondary stores retain their own project indexes:
- `lancedb/` — LanceDB vector store (centralized, all projects)
- `cache/meta.lmdb` — file metadata cache (hashes, mtimes)
- `cache/watchers.lmdb` — watcher/daemon registry (LMDB, crash-safe)
- `daemon.sock` — Unix domain socket for daemon IPC
- `daemon.pid` — PID file for daemon dedup
- `logs/` — daemon and server logs (5MB rotation)
- `config.json` — global config (model tier, embed mode)
- `models/` — ONNX embedding models
- `hf/` — pinned Hugging Face cache for MLX embedding models
- `watch-leases.json` — active session/CLI watch leases
- `grammars/` — Tree-sitter grammars
- `projects.json` — registry of indexed directories

**Pipeline:** Walk (gitignore-aware) → Chunk (Tree-sitter) → Embed (384-dim Granite via ONNX/MLX) → Store (LanceDB + LMDB) → Search (vector + FTS + RRF fusion + ColBERT rerank)

**Supported Languages:**

- *Structure-aware* (Tree-sitter chunking + call graph): TypeScript, JavaScript/JSX, Python, Go, Rust, Java, C#, C++, C, Ruby, PHP, Swift, Kotlin, Scala, Lua, Bash, JSON.
- *Text-indexed* (semantic search only, no call graph): Markdown, YAML, CSS, HTML, SQL, TOML, XML, and other common formats.

## Configuration

```json
// ~/.gmax/config.json
{
  "modelTier": "small",
  "vectorDim": 384,
  "embedMode": "gpu"
}
```

### Model Tier

gmax embeds with IBM's Granite r2 code-embedding models. Two tiers are available:

| Tier | Model | Dim | Params |
| --- | --- | --- | --- |
| `small` (default) | `granite-embedding-small-english-r2` | 384 | 47M |
| `standard` | `granite-embedding-english-r2` | 768 | 149M |

**384d remains the default.** In the recorded 97-case model-tier comparison
on gmax's own repo, the larger 768d model scored **~10 points
*worse* on Recall@10** than 384d, consistently on both the MLX GPU and ONNX CPU
embedding paths, with and without ColBERT rerank:

| Model | Recall@10 | Reported MRR |
| --- | --- | --- |
| `small` / 384d | **0.72** | **0.51** |
| `standard` / 768d | 0.62 | 0.44 |

<sub>Historical gmax-repo comparison: 97 cases, MLX GPU, rerank off. CPU/q4 and rerank-on comparisons showed a similar gap. These figures are not a current-release benchmark; see the evaluation caveats below.</sub>

The larger tier performed worse on that fixture and doubles dense-vector width; compute and memory costs depend on the backend.
Unless you have a measured reason to switch (e.g. a recall complaint on a very
large repo — benchmark it first), stay on 384d.

The model tier is part of the persisted embedding generation. You can change the desired
configuration, but existing indexes remain on their built generation until you explicitly run the
guarded whole-corpus rebuild:

```bash
gmax config --model-tier standard   # changes desired configuration only
gmax config                         # shows configured vs built identity
gmax status                         # reports current / legacy / stale / unbuilt per project
gmax repair --rebuild               # guarded whole-corpus rebuild through the daemon
```

`legacy` means the existing index is compatible but its exact model fingerprint was inferred from
the previous registry shape. Run `gmax index` in that project to persist exact identity; no reset or
re-embedding is required when the cached files are unchanged.

Cache metadata migrations are lazy and do not require a reset. Catchup stamps compatible legacy
entries in place, hashes Markdown and MDX by exact bytes, and reprocesses only legacy Markdown or
paths whose declared vector state disagrees with LanceDB. Files that intentionally produce no
vectors remain valid cached entries.

A model change cannot be applied by a per-project `gmax index --reset`, even when vector widths
match: one query embedding cannot safely search rows from another embedding space. Stale-generation
search and sync fail before mutation, preserving the existing index. Run `gmax repair --rebuild` to
replace the whole corpus, or restore the prior model tier as the non-destructive alternative.

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
| `GMAX_WORKER_THREADS` | Worker processes for embedding; overrides `gmax config --worker-threads` | `min(cores, 4, max(2, floor(cores/2)))` |
| `GMAX_RESOURCE_BUDGET_MB` | macOS aggregate admission budget across clients, stores, workers and models; accepts 256–6144 MiB | `6144` |
| `GMAX_WORKER_RSS_RECYCLE_MB` | Recycle workers that remain above this RSS; `0` disables the check | `1536` |
| `GMAX_DEBUG` | Debug logging | Off |
| `GMAX_RERANK` | Force ColBERT rerank (`1`); concentrated candidates can also enable it automatically ([why](docs/known-limitations.md)) | Off |
| `GMAX_CONCENTRATION_THRESHOLD` | Top-ten candidate share in one file that enables ColBERT; set above `1` for a true rerank-off baseline | `0.7` |
| `GMAX_ANN` | Experimental IVF_FLAT vector index (`1`); leave off unless validating recall on your corpus | Off |

## Troubleshooting

```bash
gmax doctor                   # Check health
gmax doctor --fix             # Repair checks; full-table maintenance is disabled
gmax doctor --agent           # Machine-readable health output
gmax index                    # Reindex (auto-detects and repairs cache/vector mismatches)
gmax index --reset            # Full reindex from scratch
gmax watch restart            # Restart daemon
```

`gmax doctor` reports ANN index state. `ANN: vector index not built` is normal with the default exact-search configuration.

`gmax doctor` and `gmax status` report persistent safety stops and daemon startup quarantine. `doctor` exits with code 2 when startup is blocked; `status --json` includes `daemon.startupBlockedReason`. Installing an update preserves these stops. macOS kernel-zone probes use `zprint -L` to omit the wired-memory report and kernel symbolication while retaining the same zone counters and pressure thresholds.

When heavy work is paused, the daemon keeps metadata, bounded symbol/file lookups, stored skeletons by exact file path, and keyword search available. Search uses the existing FTS index and excludes unindexed rows, loads no embedding model, returns at most 20 results, and reports keyword-only scores and retained-index freshness. CLI agent output preserves the keyword-only warning, and daemon reads skip client-side model setup. Native queries have a two-second deadline and run one at a time with 48 MiB of combined Lance cache capacity. Indexing, watchers, vector/graph scans, and model launches remain paused. Missing FTS indexes return an error; paused search never rebuilds an index or falls back to a corpus scan.

To serve bounded reads under an existing startup quarantine, run `gmax watch --daemon --read-only -b`. This preserves the safety markers. `status --json` reports `daemon.service.mode` and its reason; `doctor` reports paused availability and skips native corpus diagnostics. Pausing is sticky for that daemon process. Full service requires a deliberate restart after host recovery and quarantine review. Known critical OS or kernel pressure still stops even the read-only service.

Full-table compaction and new FTS/ANN index builds are disabled in the containment release, including forced maintenance and doctor repair. Existing indexes remain readable; missing lexical indexes fall back to available retrieval. Do not repeatedly force repair, use future cutoffs or manually remove index fragments.

The package includes a separate prune-only helper with pinned Lance 12 dependencies, plus an exclusively leased Node wrapper. Runtime preparation uses `uv >=0.12.18`, an existing Python interpreter and locked wheels; it does not download Python, build from source, load an embedding model or run during installation. The helper currently supports macOS and Linux. No timer, CLI repair or startup path calls it automatically. Explicit recovery has separate production admission; packaging does not authorize live cleanup.

`gmax recover --table /path/to/lancedb/chunks.lance --json` reads the durable recovery receipt without starting a daemon or preparing Python. `--check` samples admission without pruning. `--prune --version <current-version> --cutoff <absolute-ISO-timestamp>` explicitly requests one offline prune. A prior uncertain attempt requires `--acknowledge-uncertain <attempt-id>` after inspection. Recovery never creates/clears quarantine, stops other owners, retries automatically or enables rewriting.

Production recovery currently requires macOS, a persistent `autostart-disabled` file in the selected store home, and closed store owners. Recovery uses the shared aggregate resource budget and requires measured OS pressure and healthy kernel pressure. The configured `critical-only` policy permits a known OS memory warning while retaining aggregate accounting; the default `strict` policy pauses on warnings. Immediately free RAM is measured for diagnostics but has no fixed minimum: macOS can reclaim cached memory, so a low free-page count alone must not prevent cleanup. The helper reserves 512 MiB of admission capacity; this is not an OS-enforced footprint cap. Recovery samples have an eight-second total ceiling, including a five-second kernel probe allowance, 1.5-second command allowance and three-second footprint allowance, with fresh sampling at deletion admission and five-second heartbeat scheduling. Unknown, stale, critical, kernel-warning or over-budget measurements refuse/interrupt recovery. A prune has a ten-minute wall-time ceiling so rate-limited deletion of thousands of manifests can finish; the 90-second CPU limit and guarded heartbeat remain. Pruning needs at least 1 MiB of measured metadata disk headroom, not full-table rewrite space. Initial wheel setup requires 512 MiB; an existing environment is checked against the lock offline without that download-space requirement.

The child waits for launch and deletion admission tokens, with verified helper PID/start identity recorded as the primary exclusive owner. Existing readers retain exclusion if the parent dies while the helper is alive. Current/tagged/post-cutoff metadata is verified after pruning; recovery refuses more than 256 protected versions before deletion to bound verification. Interrupted attempts require verification and explicit acknowledgement before retry. Linux/APFS fixtures exercise native retention and interruption; supported production host admission is tested separately and still runs freshly for each operation.

If a short-lived client child exits during memory sampling, confirmed dead processes can leave the sample while all surviving processes retain measured footprints. An uncertain exit, new process or changed identity requires a complete fresh measurement; a normal-pressure sample may do that once within the original deadline. It never accepts an unmeasured live process. Continued changes, unavailable measurements and critical pressure still refuse admission; warning admission follows the recovery policy above.

For an operator-coordinated recovery window:

1. Check live host pressure and service availability first. Keep development online when recovery admission is already known to refuse. Preserve the configured normal-service policy and any pre-existing safety markers.
2. Once admission is plausible, create a private, durable task-owned autostart marker and gracefully close the identified daemon and its managed children. Verify shared store owners have drained. `--check` samples resource admission; it does not drain owners or acquire the exclusive prune lease.
3. Take a fresh bounded version/tag inventory after draining, with a shared lease and small native Session caches. Close that reader before pruning. Choose an explicit real-clock cutoff and verify the union of current, tagged and post-cutoff versions fits the 256-version verification bound. A snapshot from before resumed indexing is unsuitable; never silently move the cutoff to fit the bound.
4. Run one `recover --prune` with that current version and cutoff. Both `--store <value> recover` and `--store=<value> recover` preserve recovery's table-version option; the explicit `--table` selects the recovery store. Require a verified result and completed receipt before claiming recovery. Record signed table allocated-byte recovery separately from global filesystem free-space change.
5. Wait for the recovery child and helper to close before lifting exclusion. Clear only the unchanged marker created by this operation, then restore normal service and verify search/watcher health and unchanged configuration. If ownership or the marker changed, preserve containment and inspect it. An uncertain receipt requires retained-state inspection and explicit acknowledgement before another attempt; never automatically retry.

Explicit helper calls persist a private `.gmax-prune-state.json` receipt outside the table before deletion. Cancellation, invalid results, lost ownership and abandoned running receipts remain uncertain; a verified explicit retry records the prior uncertain attempt. Successful receipts include before/after file lengths, allocated bytes and filesystem free space. These measurements do not imply zero retained copies or a macOS physical-footprint cap. Current, tagged and post-cutoff versions are protected; unverified files are retained. Full-table rewriting remains disabled regardless of receipt state.

`~/.gmax/logs/daemon.log` records containment skips and retained historical compaction outcomes, including duration, logical size, disk size before/after, free space, and bytes reclaimed. `gmax status --json` exposes the last outcome under `daemon.compaction`; its `at` timestamp identifies when it was recorded. Five-minute resource snapshots track footprint, RSS, heap, external/ArrayBuffer memory, Lance cache, workers and pending work for memory investigations. Reading status uses retained snapshots and does not scan the index directory. Logs rotate to `daemon.log.prev`.

`gmax doctor --fix` refuses work under quarantine and otherwise reports optimization skipped by containment. It exits nonzero when a requested optimization did not complete or an older daemon could not verify its outcome. A busy or failed daemon is never retried as a second writer in the CLI process.

### Known issues

For detection and recovery guidance, check
[`docs/known-limitations.md`](docs/known-limitations.md) — it covers what each case means and
whether you need to act.

| You see | What it means |
|---|---|
| `Optimize panicked ... inverted/builder.rs` | The historical FTS merge defect is fixed in the shipped LanceDB 0.39.0 runtime. If it recurs on a current release, preserve the version and logs and report a regression; the rebuild guard remains a recovery tripwire. |
| `disabling auto-rebuild until an optimize succeeds` | Recovery remains paused under containment. Preserve diagnostics; use existing indexes or vector retrieval rather than forcing optimize. |
| `ANN: vector index not built` | Normal — exact search is the default. |
| `cannot reach the daemon socket from this sandbox` (exit 2) | The shell is sandboxed. Add the two keys in [Running under the Claude Code sandbox](#running-under-the-claude-code-sandbox); `gmax doctor` warns about the same gap. |
| `npm audit` reports advisories on install | Record the installed version and dependency path and report new findings. JavaScript consumer audits do not cover the Python embedding environment; maintainers also audit its locked registry dependencies with `pnpm run audit:python` (Python 3.11+; no model load). |

## Contributing

See [CLAUDE.md](CLAUDE.md) for development setup, commands, and architecture details.

### Benchmarks

Two retrieval evaluation harnesses emit JSON via `:json` variants. Additional token and experimental-orientation harnesses are available as `bench:tokens` and `bench:surprises`.

```bash
pnpm bench:recall          # 97-case internal eval against gmax's own repo
pnpm bench:recall:json
pnpm bench:oss             # P1 definition-lookup across express, lodash, platform (sverklo-bench fixtures)
pnpm bench:oss:json
GMAX_EVAL_RERANK=1 pnpm bench:oss   # toggle ColBERT rerank
```

The OSS harness expects indexed express, lodash and platform fixtures at the paths defined in [src/eval-oss.ts](src/eval-oss.ts). The historical comparison in [known limitations](docs/known-limitations.md#colbert-rerank-is-opt-in-shape-sensitive-helps-monolithic-files-hurts-modular-repos) combines these with the internal fixture: four datasets / 131 cases. It is not a current release acceptance run.

Both retrieval harnesses request 20 results for diagnostics, but `mrrAt10` and Recall@10 credit only ranks 1–10. Later matches retain their actual ranks and count as found/hits, with zero reciprocal-rank credit. This cutoff correction shipped in v0.26.49; historical MRR figures recorded before the correction may include ranks 11–20 and require a new run or rescoring before comparison. Also set `GMAX_CONCENTRATION_THRESHOLD=2` for a true rerank-off comparison: `GMAX_EVAL_RERANK=0` alone does not disable automatic concentration gating. Freeze fixtures and record source, embedding/index identity and ranking configuration before drawing conclusions.

`pnpm bench:recall` also drives the model-tier comparison behind the 384d default — see [Model Tier](#model-tier) for why the larger 768d model is *not* the default.

#### Frozen multi-repository baseline

`bench:relevance` measures reviewed local fixtures through an already-ready daemon. It does not autostart a daemon or open a fallback search store. Keep private queries, source evidence and results under the ignored `docs/measurements/` directory. Review and freeze the fixture before seeing rankings; use a new fixture version when changing ground truth.

```bash
shasum -a 256 docs/measurements/relevance/fixture-v1.json
pnpm bench:relevance --fixture docs/measurements/relevance/fixture-v1.json \
  --sha256 <reviewed-fixture-digest> \
  --output docs/measurements/relevance/baseline-v1.json --repeats 2
```

The fixture schema is in [relevance-baseline.ts](src/lib/eval/relevance-baseline.ts). Its JSON contains `schemaVersion: 1`, `createdAt`, `purpose`, `corpora` and `cases`. Each corpus has an `id`, `root` (absolute or relative to the fixture) and `language`. Each case declares an `id`, `corpus`, `split` (`dev` or `heldout`), `origin` (`curated-source` or `observed-session`), `intent`, `query` and one or more `expected` targets. Targets require an exact relative `file`, definition `symbol`, one-based `startLine`/`endLine` and the SHA-256 of the source file.

A hit requires the exact file and either the definition symbol or overlap with the declared line range. The source runner also accepts target `match: "range"` to require range overlap without a symbol shortcut; omitted or `"symbol-or-range"` preserves legacy matching. Range overlap measures useful context discovery, not complete answer coverage. Choose answer-bearing ranges and reviewed alternatives: a declaration-only target can miss a useful function-body chunk. The October 4 baseline intentionally preserves its frozen declaration targets, so its 57.5% Recall@10 / 0.3275 MRR@10 describes target retrieval, not general answer quality. It covers 40 curated cases across TypeScript, JavaScript, Python and Swift; both repetitions produced identical ranks. These are not observed user-session misses or a ranking acceptance gate. Previously inspected cases must be treated as exposed development cases in successor measurements.

The report records source/index hashes, registry embedding identity, daemon snapshots, exclusions, per-case ranks, aggregate metrics and ordinary-session latency. A sibling `.samples.jsonl` checkpoints each completed request; the final JSON applies run-wide exclusions and is authoritative. Changed source/cache hashes, missing targets, unsettled indexes, search warnings and daemon replacement invalidate samples. The runner refuses to overwrite artifacts and exits 2 when any samples are excluded.

Requests use `rerank: false`, but the daemon's concentration gate can still enable reranking. Client environment settings cannot change an existing daemon's settings, and `scoreBreakdown.rerank` also holds the fallback base score when reranking is off.

v0.26.49 supports `--diagnostics`. This requires a ready daemon advertising `capabilities.searchDiagnostics: 1`; older daemons without that capability require an update. The evaluator refuses incompatible daemons before measuring and excludes responses missing requested diagnostics. Each sample records FTS availability/failure, effective settings and allowlisted daemon ranking environment, concentration-gate evaluation/activation and whether reranking was actually invoked.

The candidate trace contains pointers and stage ranks for at most the first 200 post-seed fusion candidates, plus full stage counts and an explicit truncation flag. Ranks cover vector/FTS, RRF, seeded fusion, stage-one selection, pooled filtering, selected rerank batch, final scoring, overlap deduplication and final display. Rerank-batch membership does not imply execution; use `gate.rerankInvoked`. Zero at a later stage means a traced candidate was removed; a target missing from a truncated trace may lie outside the reported head. Diagnostics add no database reads and preserve ranking/results. The frozen October 4 artifacts retain their original unknowns. Review ground truth and collect new diagnostic artifacts before tuning.

Each traced candidate also has an `outcome`: returned, stage-one/pooled cut, deduplicated, per-file limit or display limit. Display limit means the production loop filled its result window before examining that candidate; it does not assert that the candidate would pass the per-file cap.

#### Existing-index document retrieval evaluation

In a source checkout, [scripts/eval-documents.cjs](scripts/eval-documents.cjs) measures the released [document MCP contract](DOCUMENT-SEARCH.md) through an explicit installed entry point. It uses only Node built-ins and sequential `document_search_status` / `semantic_search` calls. It performs no model warmup, daemon startup, indexing, refusal retries or fallback to normal hybrid search.

```bash
node scripts/eval-documents.cjs \
  --fixture docs/measurements/documents/fixture-v1.json \
  --sha256 <reviewed-fixture-digest> \
  --root /absolute/already-indexed/project \
  --entry /absolute/installed/grepmax/dist/bin.js \
  --output docs/measurements/documents/baseline-v1.json
```

Freeze the JSON fixture before retrieving results. It contains `schemaVersion: 1`, `purpose`, explicit project-relative `prefixes`, and 1–100 `cases`. Each case has a unique `id`, a `query` (maximum 500 characters), and one or more `expected` targets: `{file, startLine, endLine, sourceSha256}`. Files are contained relative Markdown paths; ranges are one-based and answer-bearing; hashes cover exact source bytes. Keep private fixtures and evidence in ignored `docs/measurements/`. Optional `--repeats 1-3` repeats the same frozen cases without retries or warmup.

The report separates the rank of the expected document among distinct returned documents from the rank of an overlapping expected section among chunk pointers. Document Recall@10 credits the fraction of declared target documents retrieved; MRR@10 credits only ranks 1–10. Section overlap indicates source-context discovery, not complete answer coverage. Only the first 50 returned candidates are available; document deduplication cannot recover targets outside that window. Reviewed targets are not exhaustive judgments of all useful documents, so these metrics describe the frozen targets, not general recall.

Source and indexed hashes must match the fixture before querying; generation and project/store identity must agree across coverage and retrieval. Returned source ranges require reread/hash verification; new artifacts retain both the indexed pointer digest and current-source digest so later reviews can check provenance. Refusals, changed targets and unverified expected pointers are excluded from relevance metrics and counted separately; `usableFraction` includes every planned sample. Background indexing and partial/degraded index context are recorded without excluding targets whose coverage and hashes remain current. No queries, source bodies or raw diagnostics are copied into result artifacts. Reads are bounded to 2 MiB per source; MCP frames to 1 MiB. The report and sibling `.samples.jsonl` checkpoint refuse overwrite and use owner-only permissions. Exit 0 means an evaluation with usable samples completed, not that a quality threshold passed; exit 2 means no usable samples; exit 1 means preflight or transport/contract failure. No consumer rollout is implied.

To investigate scope competition, [scripts/eval-document-scopes.cjs](scripts/eval-document-scopes.cjs) compares the original fixture prefixes against declared narrower directories without changing queries or targets:

```bash
node scripts/eval-document-scopes.cjs \
  --fixture docs/measurements/documents/fixture-v1.json --sha256 <digest> \
  --root /absolute/already-indexed/project \
  --entry /absolute/installed/grepmax/dist/bin.js \
  --output docs/measurements/documents/paired-scope-v1.json \
  --narrow-prefix docs/services --narrow-prefix docs/modules
```

Declare and freeze the scope hypothesis before querying. Narrower prefixes must stay within the original scope and retain every target. Arm order alternates per case, with a one-second gap between pairs and no retries. Reports show each arm's standalone observations and separately compare only pairs where both arms are usable under the same resource generation, project and store. The live competing corpus can still change; this is a diagnostic comparison rather than an isolated causal test. Scopes chosen from known target families introduce a useful prior, so gains do not establish unscoped or held-out retrieval quality. Owner-only checkpoints, overwrite refusal and source/transport bounds are shared with the base evaluator. Exit 2 means no comparable pairs.

### Offline lexical candidate experiment

[scripts/eval-document-lexical.cjs](scripts/eval-document-lexical.cjs) tests lexical candidates and fixed document reciprocal-rank fusion against a prior paired scope report. It uses Node built-ins and filesystem Markdown only; it never contacts a daemon, opens a native store, loads a model or changes production retrieval.

Freeze an owner-only study plan before scoring, including the original fixture checksum, archived report checksum, canonical root, narrower relative prefixes, fixed algorithm parameters and resource limits. The selected scope must retain every target and match the archived narrow arm. Pass that plan's checksum explicitly:

```bash
NODE_OPTIONS=--max-old-space-size=384 node scripts/eval-document-lexical.cjs \
  --fixture docs/measurements/documents/fixture-v1.json \
  --plan docs/measurements/documents/lexical-plan.json --plan-sha256 <digest> \
  --archive docs/measurements/documents/paired-scope-v1.json \
  --snapshot docs/measurements/documents/new-private-snapshot \
  --output docs/measurements/documents/new-lexical-report.json
```

The prototype uses fixed 48-line windows with eight-line overlap, BM25 `k1=1.2` / `b=0.75`, 50 positive-score lexical candidates and equal-weight document RRF with constant 60. Targets are used for grading only. Stable path/line ties, no per-case overrides and no zero-score padding keep the experiment reproducible. Bounds are 512 files, 16 MiB total source, 2 MiB per file, 10,000 windows, one million token occurrences and 20,000 directory entries. Missing, aliased, changed or oversized source fails snapshot creation rather than silently dropping competing documents. A private snapshot preserves exact source bytes and a digest manifest; the report stores pointers, digests, IDs and scores without questions or source bodies. Existing output/snapshot paths are refused.

Lexical metrics cover cases whose frozen targets match the snapshot. Archive replay additionally requires original ready state/resource identity and every competitor pointer's indexed/current digest and range to match the snapshot; an invalid competitor excludes the entire case. Refused archive cases stay separate. Offline lexical availability does not exercise deployed busy/pressure admission. Archived dense candidates are not re-encoded over this snapshot, and narrower families chosen from known target locations introduce a prior. Report document gains/losses on the verified shared replay cohort; section overlap is diagnostic because window sizes and hybrid representatives differ from production chunks. A passing exploratory gate only supports proposing further matched qualification. No production integration or rollout follows automatically. Exit 0 means scoring completed with usable lexical cases, even when the gate fails; exit 2 means no usable lexical cases, and exit 1 means preflight or evaluation failure.

### Protected document fusion qualification

[scripts/eval-document-fusion.cjs](scripts/eval-document-fusion.cjs) qualifies a fixed candidate ordering in two modes: replay cached verified lexical/dense candidates, or collect one broader pass through the released existing-only MCP. It interleaves each arm's first three distinct documents (`lex1,dense1,lex2,dense2,lex3,dense3`), deduplicates while preserving the selected arm's pointer, then fills to 50 with the fixed RRF tail. This protects high-ranked lexical-only evidence; spending up to six slots can displace useful lower-ranked dense candidates. Expected targets never affect ranking.

```bash
NODE_OPTIONS=--max-old-space-size=384 node scripts/eval-document-fusion.cjs \
  --mode live --design <frozen-design.json> --design-sha256 <digest> \
  --fixture <frozen-fixture.json> --fixture-sha256 <digest> \
  --entry /absolute/path/to/installed/grepmax/dist/bin.js --entry-sha256 <digest> \
  --snapshot <new-private-snapshot-directory> --output <new-private-report.json>
```

For `--mode replay`, replace the entry arguments with `--input <prior-lexical-report.json> --input-sha256 <digest>` and point `--snapshot` at its immutable snapshot. Replay uses saved lexical candidates without rescoring queries. Live mode snapshots the complete predefined scope and builds the bounded filesystem index before MCP initialization; it permits one case-order pass with one-second gaps, without retries, warmup, runtime startup or native fallback. The existing-only entry must expose the expected restricted capabilities. Coverage, generation, project/store identity and every indexed/current competitor digest and range must verify. Refusals remain separate from relevance. A final full source-byte/file-set fence invalidates comparisons if the corpus changed; checkpoints are provisional and the final JSON is authoritative.

The lexical CLI retains its one-million-token default. A frozen fusion design may explicitly allow 1,100,000 token occurrences; all other source/window limits and the 384 MiB Node heap setting remain unchanged. The heap setting is not an operating-system physical memory cap. Outputs and snapshots refuse overwrite and use private permissions; reports exclude question text and source bodies. The broader study requires at least 16 of 20 comparable cases, no dense top-ten target losses, and protected document recall at least as high as either arm on the same cohort. Other predefined positive cohort bounds are supported. Exit 0 means collection completed with some comparable cases, even if the gate fails; exit 2 means none, and exit 1 means interrupted/preflight failure.

The October 8 experiment recovered both original residuals: Redis rank 1, People rank 3, 15/15 replay document hits with no dense top-ten target loss. Its broader 393-file, 20-case pass produced only two comparable cases (15 busy and three pressure refusals; one busy case also lacked indexed coverage), below the frozen 16-case minimum. Broader qualification is **insufficient**. Questions were source-curated after the rule freeze and held out from parameter selection, not independently adjudicated real-user questions. Representative/window differences prevent like-for-like section accuracy claims. This evaluation does not change production retrieval or authorize integration, release or rollout.

## Attribution

grepmax is built upon the foundation of [mgrep](https://github.com/mixedbread-ai/mgrep) by MixedBread. See the [NOTICE](NOTICE) file for details.

## License

Licensed under the Apache License, Version 2.0. See [LICENSE](LICENSE).

On macOS, heavy work uses a shared resource ledger and a bounded batch footprint probe covering every gmax process and its children. Native stores, workers and model launches reserve headroom before allocating it. Under the default `strict` policy, warning or unknown measurements pause heavy work; known critical pressure persists a stop under either policy. The 6 GiB admission budget is a conservative scheduling threshold, not an OS-enforced memory cap. It may be lowered with `GMAX_RESOURCE_BUDGET_MB`. Existing safety markers remain in place after upgrades.

MCP sessions started before this resource policy must reconnect after upgrading before heavy work can resume. Keyword search through the bounded read service stays available while those sessions are running. Cached resource snapshots in `gmax status --json` distinguish aggregate physical footprint from daemon RSS.

### Host guard policy

`hostGuardPolicy: "critical-only"` in `~/.gmax/config.json` (or
`GMAX_HOST_GUARD_POLICY=critical-only`) selects an explicit availability policy.
Warning and unavailable pressure probes remain diagnostic and do not pause
semantic search or indexing. Confirmed critical OS or kernel pressure still
persists a safety stop and shuts down. This mode disables aggregate memory
admission and the requirement to reconnect older MCP clients; native cache and
worker limits remain. The default `strict` policy keeps aggregate admission.
Restart the daemon after changing policy. An existing safety-stop marker requires
explicit operator review and clearing; selecting a policy never clears it.
Full-table compaction remains disabled in either policy.

Root `.gmaxignore` exclusions also filter native filesystem events. Simple
positive rules update both daemon and standalone subscriptions when the policy
changes. Rules with negations, escapes or advanced pattern syntax remain in the
indexing policy only, preserving re-included files. Source JSON outside an
excluded path stays indexable.
