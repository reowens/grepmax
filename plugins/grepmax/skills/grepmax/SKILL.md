---
name: grepmax
description: Semantic code search. Use alongside grep - grep for exact strings, gmax for concepts.
allowed-tools: "mcp__grepmax__semantic_search, mcp__grepmax__code_skeleton, mcp__grepmax__trace_calls, mcp__grepmax__list_symbols, mcp__grepmax__index_status, mcp__grepmax__summarize_directory, mcp__grepmax__summarize_project, mcp__grepmax__related_files, mcp__grepmax__recent_changes, Bash(gmax:*), Read"
---

## When to use what

- **Know the exact string/symbol?** → `Grep` tool (fastest, zero overhead)
- **Know the file already?** → `Read` tool directly
- **Searching by concept/behavior?** → `Bash(gmax "query" --agent)` (semantic search)
- **Need file structure?** → `Bash(gmax skeleton <path>)`
- **Need call flow?** → `Bash(gmax trace <symbol>)`

## IMPORTANT: Use CLI, not MCP tools

**Always prefer `Bash(gmax ...)` over MCP tool calls.** Use `--agent` for the most token-efficient search output (one line per result with signature hints).

```
Bash(gmax "auth handler" --role ORCHESTRATION --lang ts --agent -m 3)
```

**Only use MCP tools** for `index_status` or `summarize_directory`. For everything else, use CLI.

## CLI commands (use these)

### Search — `gmax "query" --agent`

The `--agent` flag is **search-only**. Do NOT use it on `trace`, `skeleton`, or other commands.

```
gmax "where do we handle authentication" --agent
gmax "database connection pooling" --role ORCHESTRATION --agent -m 5
gmax "error handling" --lang ts --exclude tests/ --agent
gmax "VectorDB" --symbol --agent          # search + call graph in one shot
gmax "handler" --name "handle.*" --agent   # regex filter on symbol names
gmax "auth" --file handler.ts --agent      # filter by filename
gmax "auth" --root ~/other/project --agent # search a different project
gmax "auth" --imports --agent              # show file imports per file
```

Output: `file:line symbol [ROLE] — signature_hint` (one line per result)

All search flags: `--agent --plain -m <n> --per-file <n> --min-score <n> --root <dir> --file <name> --exclude <prefix> --lang <ext> --role <role> --symbol --imports --name <regex> -C <n> --compact --content --scores --skeleton`

#### When `--agent` isn't enough

If you need more context than the one-line hint, use `--skeleton` instead:
```
gmax "auth middleware" --skeleton -m 2     # file skeletons for top matches
```
This shows function signatures, what each calls, and complexity — enough to decide what to Read.

### Trace — `gmax trace <symbol>`
```
gmax trace handleAuth                      # 1-hop: callers + callees
gmax trace handleAuth -d 2                 # 2-hop: callers-of-callers
gmax trace handleAuth --root ~/project     # trace in a different project
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
gmax project --root ~/other/project        # different project
```

### Related files — `gmax related <file>`
```
gmax related src/lib/index/syncer.ts       # dependencies + dependents
gmax related src/lib/index/syncer.ts --root ~/project
```

### Recent changes — `gmax recent`
```
gmax recent                                # recently modified files
```

### Other
```
gmax symbols                               # list indexed symbols
gmax symbols auth -p src/ --root ~/proj    # filter by name, path, project
gmax index                                 # reindex current directory
gmax list                                  # show indexed projects
gmax config                                # view/change settings
gmax doctor                                # health check
```

## Workflow

1. **Explore** — `Bash(gmax project)` for overview of a new codebase
2. **Search** — `Bash(gmax "query" --agent)` to find code. Add `--symbol` for function/class names.
3. **Skeleton** — `Bash(gmax skeleton <path>)` before reading large files, or use `--skeleton` on search
4. **Read** — `Read file:line` for specific ranges identified by search/skeleton
5. **Trace** — `Bash(gmax trace <symbol>)` for call flow
6. **Context** — `Bash(gmax related <file>)` to see what else to look at
7. **Changes** — `Bash(gmax recent)` after pulls

## MCP tools

Use MCP only for `index_status` and `summarize_directory`. Use CLI for everything else. For cross-project search, use `scope: "all"` on semantic_search (replaces search_all).

## Tips

- **Use `--agent` on search only** — one line per result with signature hints.
- **Be specific.** 5+ words. "auth" returns noise. "where does the server validate JWT tokens" is specific.
- **Use `--role ORCHESTRATION`** to skip type definitions and find the actual logic.
- **Use `--symbol`** when the query is a function/class name — gets search + trace in one call.
- **Use `--skeleton`** when `--agent` results aren't enough — shows file structure for top matches.
- **Use `--imports`** when you need to understand a file's dependencies.
- **Use `--root <dir>`** to search/trace/query a different project from your current directory.
- **Don't search for exact strings** — use grep/Grep for that. gmax finds concepts.

## If results seem stale

The watcher auto-starts on first CLI search. Usually results are fresh without manual intervention.
1. `Bash(gmax index)` to force re-index
2. Do NOT use `gmax reindex` — it doesn't exist.
