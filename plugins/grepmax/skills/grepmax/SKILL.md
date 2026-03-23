---
name: grepmax
description: Semantic code search. Use alongside grep - grep for exact strings, gmax for concepts.
allowed-tools: "mcp__grepmax__semantic_search, mcp__grepmax__search_all, mcp__grepmax__code_skeleton, mcp__grepmax__trace_calls, mcp__grepmax__list_symbols, mcp__grepmax__index_status, mcp__grepmax__summarize_directory, mcp__grepmax__summarize_project, mcp__grepmax__related_files, mcp__grepmax__recent_changes, Bash(gmax:*), Read"
---

## What gmax does

Semantic code search — finds code by meaning, not just strings.

- grep/ripgrep: exact string match
- gmax: concept match ("where do we handle auth?", "how does booking flow work?")

## IMPORTANT: Use CLI, not MCP tools

**Always prefer `Bash(gmax ...)` over MCP tool calls.** The CLI is ~2x more token-efficient because MCP tool schemas add ~800 tokens of overhead per call. The CLI has full feature parity with every MCP tool.

```
Bash(gmax "auth handler" --role ORCHESTRATION --lang ts --plain -m 3)
```

**Only use MCP tools** for `index_status` (quick health check) or `summarize_directory` (LLM summaries). For everything else, use CLI.

## CLI commands (use these)

### Search — `gmax "query" --plain`
```
gmax "where do we handle authentication" --plain
gmax "database connection pooling" --role ORCHESTRATION --plain -m 5
gmax "error handling" --lang ts --exclude tests/ --plain
gmax "VectorDB" --symbol --plain          # search + call graph in one shot
gmax "handler" --name "handle.*" --plain   # regex filter on symbol names
gmax "auth" --file handler.ts --plain      # filter by filename
gmax "query" -C 5 --plain                  # include context lines
gmax "query" --imports --plain             # show file imports
```

All flags: `--plain -m <n> --per-file <n> --min-score <n> --root <dir> --file <name> --exclude <prefix> --lang <ext> --role <role> --symbol --imports --name <regex> -C <n> --compact --content --scores --skeleton`

### Trace — `gmax trace <symbol>`
```
gmax trace handleAuth                      # 1-hop: callers + callees
gmax trace handleAuth -d 2                 # 2-hop: callers-of-callers
```

### Skeleton — `gmax skeleton <target>`
```
gmax skeleton src/lib/auth.ts              # single file
gmax skeleton src/lib/search/              # entire directory
gmax skeleton src/a.ts,src/b.ts            # batch
gmax skeleton src/lib/auth.ts --json       # structured JSON output
```

### Project overview — `gmax project`
```
gmax project                               # languages, structure, key symbols
```

### Related files — `gmax related <file>`
```
gmax related src/lib/index/syncer.ts       # dependencies + dependents
```

### Recent changes — `gmax recent`
```
gmax recent                                # recently modified files
```

### Other
```
gmax symbols                               # list indexed symbols
gmax symbols auth -p src/                  # filter by name and path
gmax index                                 # reindex current directory
gmax config                                # view/change settings
gmax doctor                                # health check
```

## Workflow

1. **Explore** — `Bash(gmax project)` for overview of a new codebase
2. **Search** — `Bash(gmax "query" --plain)` to find code. Add `--symbol` for function/class names.
3. **Read** — `Read file:line` for specific ranges
4. **Skeleton** — `Bash(gmax skeleton <path>)` before reading large files
5. **Trace** — `Bash(gmax trace <symbol> -d 2)` for call flow
6. **Context** — `Bash(gmax related <file>)` to see what else to look at
7. **Changes** — `Bash(gmax recent)` after pulls

## MCP tools (only when CLI isn't suitable)

MCP tools are available but consume more tokens. Use them only for:
- `index_status` — quick health check (no CLI equivalent that's cheaper)
- `summarize_directory` — LLM summary generation
- `semantic_search` with `detail: "pointer"` — when you need the structured pointer format

Full MCP tool documentation: semantic_search (16 params), search_all, code_skeleton, trace_calls, list_symbols, index_status, summarize_project, related_files, recent_changes, summarize_directory.

## Tips

- **Always use `--plain`** on CLI searches — agent-friendly output without ANSI codes.
- **Be specific.** 5+ words. "auth" returns noise. "where does the server validate JWT tokens" is specific.
- **Use `--role ORCHESTRATION`** to skip type definitions and find the actual logic.
- **Use `--symbol`** when the query is a function/class name — gets search + trace in one call.
- **Don't search for exact strings** — use grep/Grep for that. gmax finds concepts.

## If results seem stale

The watcher auto-starts on first CLI search. Usually results are fresh without manual intervention.
1. `Bash(gmax index)` to force re-index
2. Do NOT use `gmax reindex` — it doesn't exist.
