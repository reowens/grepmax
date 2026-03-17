---
name: gmax
description: Semantic code search. Use alongside grep - grep for exact strings, gmax for concepts.
allowed-tools: "mcp__grepmax__semantic_search, mcp__grepmax__search_all, mcp__grepmax__code_skeleton, mcp__grepmax__trace_calls, mcp__grepmax__list_symbols, mcp__grepmax__index_status, Bash(gmax:*), Read"
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
- `query` (required): Natural language. More words = better results.
- `limit` (optional): Max results (default 3, max 50)
- `root` (optional): Directory to search. Use `root: "../"` to search a parent directory.
- `path` (optional): Restrict to path prefix (e.g. "src/auth/")
- `detail` (optional): `"pointer"` (default) or `"code"`
- `min_score` (optional): Filter by minimum relevance score (0-1)
- `max_per_file` (optional): Cap results per file for diversity

**When to use which mode:**
- `pointer` — navigation, finding locations, understanding architecture
- `code` — comparing implementations, finding duplicates, checking syntax

### search_all
Search ALL indexed code across every directory. Same modes as semantic_search.

### code_skeleton
File structure — signatures with bodies collapsed (~4x fewer tokens).
- `target` (required): File path relative to project root

### trace_calls
Call graph — who calls a symbol and what it calls. Unscoped — follows calls across all indexed directories.
- `symbol` (required): Function/method/class name

### list_symbols
List indexed symbols with definition locations.
- `pattern` (optional): Filter by name
- `limit` (optional): Max results (default 20)
- `path` (optional): Only symbols under this path prefix

### index_status
Check centralized index health — chunks, files, indexed directories, model info.

## Workflow

1. **Search** — `semantic_search` to find relevant code (pointers by default)
2. **Read** — `Read file:line` for the specific ranges you need
3. **Compare** — `semantic_search` with `detail: "code"` when comparing implementations
4. **Trace** — `trace_calls` to understand call flow across files
5. **Skeleton** — `code_skeleton` before reading large files

## If results seem stale

1. Check `index_status` — if watcher shows "syncing", results may be incomplete. Wait for it.
2. To force a re-index: `Bash(gmax index)` (indexes current directory)
3. To add summaries without re-indexing: `Bash(gmax summarize)`
4. Do NOT use `gmax reindex` — it doesn't exist.

## Tips

- More words = better results. "auth" is vague. "where does the server validate JWT tokens" is specific.
- ORCH results contain the logic — prioritize over DEF/IMPL.
- Summaries tell you what the code does without reading it. Use them to decide what to Read.
- Use `root` to search parent directories (monorepo, workspace).
- Use `search_all` sparingly — it searches everything indexed.
