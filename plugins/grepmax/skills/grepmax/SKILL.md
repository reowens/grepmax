---
name: grepmax
description: Semantic code search. Use alongside grep - grep for exact strings, gmax for concepts.
allowed-tools: "mcp__grepmax__semantic_search, mcp__grepmax__search_all, mcp__grepmax__code_skeleton, mcp__grepmax__trace_calls, mcp__grepmax__list_symbols, mcp__grepmax__index_status, mcp__grepmax__summarize_directory, mcp__grepmax__summarize_project, mcp__grepmax__related_files, mcp__grepmax__recent_changes, Bash(gmax:*), Read"
---

## What gmax does

Semantic code search — finds code by meaning, not just strings.

- grep/ripgrep: exact string match
- gmax: concept match ("where do we handle auth?", "how does booking flow work?")

## MCP tools

### semantic_search
Search code by meaning. Two output modes:

**Pointer mode (default)** — returns metadata + LLM-generated summary per result:
```
handleAuth [exported ORCH C:8] src/auth/handler.ts:45-90
  Validates JWT from Authorization header, checks RBAC permissions, returns 401 on failure
  parent:AuthController calls:validateToken,checkRole,respond
```

**Code mode (`detail: "code"`)** — includes 4-line numbered code snippets:
```
handleAuth [exported ORCH C:8] src/auth/handler.ts:45-90
  Validates JWT from Authorization header, checks RBAC permissions, returns 401 on failure
  parent:AuthController calls:validateToken,checkRole,respond
45│  const token = req.headers.get("Authorization");
46│  const claims = await validateToken(token);
47│  if (!claims) return unauthorized();
48│  const allowed = await checkRole(claims.role, req.path);
```

Parameters:
- `query` (required): Natural language. Be specific — 5+ words gives much better results than 1-2 words.
- `limit` (optional): Max results (default 3, max 50)
- `root` (optional): Absolute path to search a different indexed directory.
- `path` (optional): Restrict to path prefix (e.g. "src/auth/"). Relative to the search root.
- `detail` (optional): `"pointer"` (default), `"code"` (4-line snippets), or `"full"` (complete chunk with line numbers)
- `context_lines` (optional): Include N lines before/after the chunk (like grep -C). Only with detail "code" or "full". Max 20.
- `min_score` (optional): Filter by minimum relevance score (0-1)
- `max_per_file` (optional): Cap results per file for diversity
- `file` (optional): Filter to files matching this name (e.g. "syncer.ts"). Matches filename, not full path.
- `exclude` (optional): Exclude files under this path prefix (e.g. "tests/" or "dist/")
- `language` (optional): Filter by file extension (e.g. "ts", "py", "go"). Omit the dot.
- `role` (optional): Filter by chunk role: "ORCHESTRATION" (logic/flow), "DEFINITION" (types), or "IMPLEMENTATION"
- `mode` (optional): `"default"` (semantic only) or `"symbol"` (semantic + call graph appended). Use "symbol" when query is a function or class name — gets search results + callers/callees in one call.
- `include_imports` (optional): Prepend file's import/require statements to each result. Deduped per file — see dependencies at a glance.
- `name_pattern` (optional): Regex to filter by symbol name (e.g. "handle.*Auth"). Case-insensitive. Applied after search.

**When to use which mode:**
- `pointer` — navigation, finding locations, understanding architecture
- `code` — comparing implementations, finding duplicates, checking syntax

### search_all
Search ALL indexed code across every directory. Same parameters as semantic_search (query, limit, detail, min_score, max_per_file, file, exclude, language, role) but without `root` or `path`.

Additional parameters:
- `projects` (optional): Comma-separated project names to include (e.g. "platform,osgrep"). Use `index_status` to see names.
- `exclude_projects` (optional): Comma-separated project names to exclude (e.g. "capstone,power")

Use sparingly. Prefer `semantic_search` when you know which directory to search.

### code_skeleton
File or directory structure — signatures with bodies collapsed (~4x fewer tokens).
- `target` (required): File path, directory path (e.g. "src/lib/search/"), or comma-separated files
- `limit` (optional): Max files for directory mode (default 10, max 20)
- `format` (optional): `"text"` (default) or `"json"` (structured symbol list with name, line, signature, type, exported)

### trace_calls
Call graph — who imports a symbol, who calls it, and what it calls. Includes file:line locations. Unscoped — follows calls across all indexed directories.
- `symbol` (required): Function/method/class name
- `depth` (optional): Traversal depth for callers (default 1, max 3). depth: 2 shows callers-of-callers with indentation.

Output: definition, "Imported by" (files with import statements), "Callers" (functions that call it), "Calls" (what it calls).

### list_symbols
List indexed symbols with definition locations, role, and export status.
- `pattern` (optional): Filter by name (case-insensitive substring match)
- `limit` (optional): Max results (default 20, max 100)
- `path` (optional): Only symbols under this path prefix

Output: `symbolName [ORCH] exported  src/path/file.ts:42`

### summarize_project
High-level project overview — languages, directory structure, role distribution, key symbols, entry points. Use when first exploring a new codebase.
- `root` (optional): Project root path. Defaults to current project.

### related_files
Find files related to a given file by shared symbol references. Shows dependencies (what this file calls) and dependents (what calls this file).
- `file` (required): File path relative to project root
- `limit` (optional): Max results per direction (default 10)

### recent_changes
Show recently modified files in the index. Useful after pulls or merges to see what changed.
- `limit` (optional): Max files (default 20)
- `root` (optional): Project root (defaults to current project)

### index_status
Check centralized index health — chunks, files, indexed directories, model info, watcher status.

### summarize_directory
Generate LLM summaries for indexed code in a directory. Summaries are stored and returned in search results. Requires the summarizer server (auto-started by the plugin hook).
- `path` (optional): Directory to summarize. Defaults to project root.
- `limit` (optional): Max chunks to summarize per call (default 200, max 5000). Run again to continue.

## Workflow

1. **Explore** — `summarize_project` for high-level overview of a new codebase
2. **Search** — `semantic_search` to find relevant code (pointers by default). Use `mode: "symbol"` for function/class names.
3. **Read** — `Read file:line` for the specific ranges you need
4. **Skeleton** — `code_skeleton` before reading large files or directories
5. **Trace** — `trace_calls` to understand call flow, imports, and callers (use `depth: 2` for full chains)
6. **Context** — `related_files` to see what else you need to look at when editing
7. **Changes** — `recent_changes` after pulls to see what's been modified

## If results seem stale

The watcher auto-starts when the MCP server connects — it detects file changes and re-indexes in the background. Usually results are fresh without manual intervention.

1. Check `index_status` — if watcher shows "syncing", wait for it to finish.
2. To force a full re-index: `Bash(gmax index)` (indexes current directory)
3. To add summaries without re-indexing: `Bash(gmax summarize)`
4. Do NOT use `gmax reindex` — it doesn't exist.

## Search warnings

If search results include a warning like "Full-text search unavailable", results may be less precise. This resolves automatically — the index retries FTS every 5 minutes.

## CLI vs MCP — when to use which

**Prefer CLI (`Bash(gmax ...)`) for repeated searches.** The CLI is ~2x more token-efficient because MCP tool schemas add ~800 tokens of overhead per call. Every CLI flag maps to an MCP param:

```
Bash(gmax "auth handler" --role ORCHESTRATION --lang ts --plain -m 3)
```

is equivalent to `semantic_search` with `role: "ORCHESTRATION", language: "ts", limit: 3` — but costs half the tokens.

**CLI commands for all MCP tools:**
- `gmax "query" --plain` → `semantic_search`
- `gmax trace <symbol> -d 2` → `trace_calls` with depth
- `gmax skeleton <target> --json` → `code_skeleton`
- `gmax project` → `summarize_project`
- `gmax related <file>` → `related_files`
- `gmax recent` → `recent_changes`

**Use MCP tools when:** first exploring (tool descriptions guide usage), or when you need pointer mode output (more structured than CLI).

## Tips

- **Be specific.** "auth" returns noise. "where does the server validate JWT tokens from the Authorization header" returns exactly what you need. Aim for 5+ words.
- **Use `--plain` for CLI searches** — agent-friendly output without ANSI codes.
- **ORCH results contain the logic** — use `--role ORCHESTRATION` to filter noise.
- **Summaries tell you what the code does** without reading it. Use them to decide what to `Read`.
- **Use `--symbol` on CLI** to get search results + call graph in one shot.
- **Don't search for exact strings** — use grep/Grep for that. gmax finds concepts, not literals.
