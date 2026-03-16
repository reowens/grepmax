---
name: gmax
description: Semantic code search. Use alongside grep - grep for exact strings, gmax for concepts.
allowed-tools: "mcp__grepmax__semantic_search, mcp__grepmax__search_all, mcp__grepmax__code_skeleton, mcp__grepmax__trace_calls, mcp__grepmax__list_symbols, mcp__grepmax__index_status, Bash(gmax:*), Read"
---

## What gmax does

Finds code by meaning. When you'd ask a colleague "where do we handle auth?", use gmax.

- grep/ripgrep: exact string match, fast
- gmax: concept match, finds code you couldn't grep for

## MCP tools

### semantic_search
Search code by meaning. Returns **pointers** by default — symbol, file:line, role, calls. No code snippets unless requested.
- `query` (required): Natural language. Be specific — more words = better results.
- `limit` (optional): Max results (default 3, max 50)
- `root` (optional): Directory to search. Defaults to project root. Use to search a parent directory (e.g. `root: "../"` to search the monorepo).
- `path` (optional): Restrict to path prefix (e.g. "src/auth/")
- `detail` (optional): `"pointer"` (default) or `"code"` (adds 4-line numbered snippets)
- `min_score` (optional): Filter by minimum relevance score (0-1)
- `max_per_file` (optional): Cap results per file for diversity

**Output format (pointer mode):**
```
handleAuth [exported ORCH C:8] src/auth/handler.ts:45-90
  parent:AuthController calls:validateToken,checkRole,respond
```

**When to use `detail: "code"`:** Only when you need to see the actual code before deciding to Read — e.g. comparing implementations, checking syntax. For navigation ("where is X?"), pointer mode is sufficient.

### search_all
Search ALL indexed code across every directory. Same output format as semantic_search. Use when code could be anywhere — e.g. tracing a function across projects.

### code_skeleton
Show file structure — signatures with bodies collapsed (~4x fewer tokens).
- `target` (required): File path relative to project root

### trace_calls
Trace call graph — who calls a symbol and what it calls. Unscoped — follows calls across all indexed directories.
- `symbol` (required): Function/method/class name (e.g. "handleAuth")

### list_symbols
List indexed symbols with definition locations.
- `pattern` (optional): Filter by name (case-insensitive substring)
- `limit` (optional): Max results (default 20, max 100)
- `path` (optional): Only symbols under this path prefix

### index_status
Check centralized index health — chunk count, files, indexed directories, model info.

## Workflow

1. **Locate** — `semantic_search` with pointer mode to find relevant code
2. **Read** — `Read file:line` for the specific ranges you need
3. **Trace** — `trace_calls` to understand how functions connect
4. **Skeleton** — `code_skeleton` before reading large files

Don't read entire files. Use the line ranges from search results.

## Tips

- More words = better results. "auth" is vague. "where does the server validate JWT tokens" is specific.
- ORCH results contain the logic — prioritize these over DEF/IMPL.
- Use `root` to search parent directories (monorepo, workspace).
- Use `search_all` sparingly — it searches everything indexed.
