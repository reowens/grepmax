---
name: osgrep
description: Semantic code search. Use alongside grep - grep for exact strings, osgrep for concepts.
allowed-tools: "mcp__osgrep__semantic_search, mcp__osgrep__code_skeleton, mcp__osgrep__trace_calls, mcp__osgrep__list_symbols, Bash(osgrep:*), Read"
---

## What osgrep does

Finds code by meaning. When you'd ask a colleague "where do we handle auth?", use osgrep.

- grep/ripgrep: exact string match, fast
- osgrep: concept match, finds code you couldn't grep for

## MCP tools (preferred)

Use these structured tools when available — they return typed JSON and don't need output parsing.

### semantic_search
Search code by meaning. Returns ranked snippets with file paths, line numbers, scores.
- `query` (required): Natural language. Be specific — more words = better results.
- `limit` (optional): Max results (default 10, max 50)
- `path` (optional): Restrict to path prefix (e.g. "src/auth/")
- `min_score` (optional): Filter by minimum relevance score (0-1)
- `max_per_file` (optional): Cap results per file for diversity

### code_skeleton
Show file structure — signatures with bodies collapsed (~4x fewer tokens).
- `target` (required): File path relative to project root

### trace_calls
Trace call graph — who calls a symbol and what it calls.
- `symbol` (required): Function/method/class name (e.g. "handleAuth")

### list_symbols
List indexed symbols with definition locations.
- `pattern` (optional): Filter by name (case-insensitive substring)
- `limit` (optional): Max results (default 20, max 100)
- `path` (optional): Only symbols under this path prefix

### index_status
Check index and daemon health — file count, chunks, embed mode, age, watching status.

## CLI fallback

If MCP tools aren't available, use the CLI via Bash:

```bash
osgrep "where do we validate user permissions"   # Semantic search
osgrep "authentication" --compact                 # Just file paths + line ranges
osgrep skeleton src/giant-2000-line-file.ts       # File structure
osgrep trace handleAuth                           # Call graph
osgrep symbols booking                            # Find symbols by name
```

## Output explained (CLI)
```
ORCHESTRATION src/auth/handler.ts:45
Defines: handleAuth | Calls: validate, checkRole, respond | Score: .94

export async function handleAuth(req: Request) {
  const token = req.headers.get("Authorization");
  const claims = await validateToken(token);
  ...
```

- **ORCHESTRATION** = contains logic, coordinates other code
- **DEFINITION** = types, interfaces, classes
- **Score** = relevance (1 = best match)
- **Calls** = what this code calls (helps trace flow)

## Tips

- More words = better results. "auth" is vague. "where does the server validate JWT tokens" is specific.
- ORCH results contain the logic — prioritize these.
- Don't read entire files. Use the line ranges from results.
- If results seem off, rephrase like you'd ask a teammate.
- Use `code_skeleton` before reading large files — understand structure first.
- Use `trace_calls` to understand how functions connect across the codebase.

## If Index is Building

If you see "Indexing" or daemon not ready: tell the user. Ask if they want to wait or proceed with partial results.
