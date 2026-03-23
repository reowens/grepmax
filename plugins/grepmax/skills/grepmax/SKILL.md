---
name: grepmax
description: Semantic code search. Use alongside grep - grep for exact strings, gmax for concepts.
allowed-tools: "mcp__grepmax__semantic_search, mcp__grepmax__search_all, mcp__grepmax__code_skeleton, mcp__grepmax__trace_calls, mcp__grepmax__list_symbols, mcp__grepmax__index_status, mcp__grepmax__summarize_directory, Bash(gmax:*), Read"
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

### trace_calls
Call graph — who calls a symbol and what it calls. Callers and callees include file:line locations. Unscoped — follows calls across all indexed directories.
- `symbol` (required): Function/method/class name

### list_symbols
List indexed symbols with definition locations, role, and export status.
- `pattern` (optional): Filter by name (case-insensitive substring match)
- `limit` (optional): Max results (default 20, max 100)
- `path` (optional): Only symbols under this path prefix

Output: `symbolName [ORCH] exported  src/path/file.ts:42`

### index_status
Check centralized index health — chunks, files, indexed directories, model info, watcher status.

### summarize_directory
Generate LLM summaries for indexed code in a directory. Summaries are stored and returned in search results. Requires the summarizer server (auto-started by the plugin hook).
- `path` (optional): Directory to summarize. Defaults to project root.
- `limit` (optional): Max chunks to summarize per call (default 200, max 5000). Run again to continue.

## Workflow

1. **Search** — `semantic_search` to find relevant code (pointers by default)
2. **Read** — `Read file:line` for the specific ranges you need
3. **Compare** — `semantic_search` with `detail: "code"` when comparing implementations
4. **Trace** — `trace_calls` to understand call flow across files
5. **Skeleton** — `code_skeleton` before reading large files

## If results seem stale

The watcher auto-starts when the MCP server connects — it detects file changes and re-indexes in the background. Usually results are fresh without manual intervention.

1. Check `index_status` — if watcher shows "syncing", wait for it to finish.
2. To force a full re-index: `Bash(gmax index)` (indexes current directory)
3. To add summaries without re-indexing: `Bash(gmax summarize)`
4. Do NOT use `gmax reindex` — it doesn't exist.

## Search warnings

If search results include a warning like "Full-text search unavailable", results may be less precise. This resolves automatically — the index retries FTS every 5 minutes.

## Tips

- **Be specific.** "auth" returns noise. "where does the server validate JWT tokens from the Authorization header" returns exactly what you need. Aim for 5+ words.
- **ORCH results contain the logic** — prioritize over DEF/IMPL results.
- **Summaries tell you what the code does** without reading it. Use them to decide what to `Read`.
- **Use `root` for cross-project search** — absolute path to another indexed directory.
- **Use `max_per_file`** when results cluster in one file but you need diversity.
- **Don't search for exact strings** — use grep/Grep for that. gmax finds concepts, not literals.
