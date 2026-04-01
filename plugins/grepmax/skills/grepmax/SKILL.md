---
name: grepmax
description: Semantic code search. Use alongside grep - grep for exact strings, gmax for concepts.
allowed-tools: "mcp__grepmax__semantic_search, mcp__grepmax__code_skeleton, mcp__grepmax__trace_calls, mcp__grepmax__list_symbols, mcp__grepmax__index_status, mcp__grepmax__summarize_directory, mcp__grepmax__summarize_project, mcp__grepmax__related_files, mcp__grepmax__recent_changes, Bash(gmax:*), Read"
---

## When to use what

- **Know the exact string/symbol?** → `Grep` tool (fastest, zero overhead)
- **Know the file already?** → `Read` tool directly
- **Searching by concept/behavior?** → `Bash(gmax "query" --agent)` (semantic search)
- **Need full function body?** → `Bash(gmax extract <symbol>)` (complete source with line numbers)
- **Quick symbol overview?** → `Bash(gmax peek <symbol>)` (signature + callers + callees)
- **Need file structure?** → `Bash(gmax skeleton <path>)`
- **Need call flow?** → `Bash(gmax trace <symbol>)`

## IMPORTANT: Use CLI, not MCP tools

**Always prefer `Bash(gmax ...)` over MCP tool calls.** Use `--agent` for the most token-efficient search output (one line per result with signature hints).

```
Bash(gmax "auth handler" --role ORCHESTRATION --lang ts --agent -m 3)
```

**Only use MCP tools** for `index_status` or `summarize_directory`. For everything else, use CLI.

## Project management

Projects must be added before CLI search works. MCP tools auto-add on first use, but CLI requires an explicit step:

```
gmax add                        # add + index current directory
gmax add ~/projects/myapp       # add a specific project
gmax status                     # see all indexed projects and their state
gmax remove                     # remove current project from the index
gmax index                      # reindex an already-added project
```

If search returns "This project hasn't been added to gmax yet", run `Bash(gmax add)` first.

## CLI commands

### Search — `gmax "query" --agent`

The `--agent` flag produces compact, token-efficient output for AI agents. It is supported on: `search`, `trace`, `symbols`, `related`, `recent`, `status`, and `project`.

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

All search flags: `--agent --plain -m <n> --per-file <n> --min-score <n> --root <dir> --file <name> --exclude <prefix> --lang <ext> --role <role> --symbol --imports --name <regex> -C <n> --compact --content --scores --skeleton --explain --context-for-llm --budget <tokens>`

#### When `--agent` isn't enough

If you need more context than the one-line hint, use `--skeleton` instead:
```
gmax "auth middleware" --skeleton -m 2     # file skeletons for top matches
```
This shows function signatures, what each calls, and complexity — enough to decide what to Read.

#### Full function bodies without follow-up reads

Use `--context-for-llm` to get complete function bodies + imports per result in one call:
```
gmax "auth middleware" --context-for-llm -m 3      # full bodies with imports
gmax "auth" --context-for-llm --budget 4000 -m 5   # cap output at ~4000 tokens
```

#### Debug search ranking

Use `--explain` to see why results ranked where they did:
```
gmax "auth handler" --explain                       # scoring breakdown per result
gmax "auth handler" --explain --agent               # compact explain suffix
```

### Trace — `gmax trace <symbol>`
```
gmax trace handleAuth                      # 1-hop: callers + callees
gmax trace handleAuth -d 2                 # 2-hop: callers-of-callers
gmax trace handleAuth --root ~/project     # trace in a different project
gmax trace handleAuth --agent              # compact: symbol\tpath:line, <- callers, -> callees
```

### Extract — `gmax extract <symbol>`
```
gmax extract handleAuth                    # full function body with line numbers
gmax extract handleAuth --agent            # compact: path:start-end then raw code
gmax extract handleAuth --imports          # prepend file imports
gmax extract handleAuth --root ~/project   # extract from different project
```

### Peek — `gmax peek <symbol>`
```
gmax peek handleAuth                       # signature + callers + callees
gmax peek handleAuth --agent               # compact TSV output
gmax peek handleAuth -d 2                  # 2-hop callers
gmax peek handleAuth --root ~/project      # peek in different project
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

### Symbols — `gmax symbols`
```
gmax symbols                               # list indexed symbols
gmax symbols auth -p src/ --root ~/proj    # filter by name, path, project
gmax symbols --agent                       # compact: symbol\tpath:line\tcount
```

### Diff — `gmax diff [ref]`
```
gmax diff                              # uncommitted changes
gmax diff HEAD~5                       # last 5 commits
gmax diff main                         # branch changes vs main
gmax diff main --query "auth changes"  # semantic search within changed files
gmax diff --agent                      # compact output
```

### Test — `gmax test <symbol|file>`
```
gmax test handleAuth                   # tests calling handleAuth
gmax test src/lib/auth.ts              # tests for symbols in this file
gmax test handleAuth -d 2              # 2-hop: tests calling callers too
gmax test handleAuth --agent           # compact output
```

### Impact — `gmax impact <symbol|file>`
```
gmax impact handleAuth                 # dependents + affected tests
gmax impact src/lib/auth.ts            # everything depending on this file
gmax impact handleAuth --agent         # compact output
```

### Similar — `gmax similar <symbol|file>`
```
gmax similar handleAuth                # functions doing similar things
gmax similar src/lib/auth.ts           # files with similar structure
gmax similar handleAuth -m 5 --agent   # top 5, compact output
```

### Context — `gmax context <topic> --budget <tokens>`
```
gmax context "authentication system" --budget 4000
gmax context "payment flow" --budget 8000
gmax context src/lib/auth/ --budget 3000
```

### Other
```
gmax status                                # show all indexed projects
gmax status --agent                        # compact: name\tchunks\tage\tstatus
gmax recent --agent                        # compact: path\tage
gmax related src/file.ts --agent           # compact: dep:/rev: path\tcount
gmax project --agent                       # compact: key\tvalue pairs
gmax index                                 # reindex current directory
gmax config                                # view/change settings
gmax doctor                                # health check
```

## Workflow

1. **Add** — `Bash(gmax add)` to register and index a new project
2. **Explore** — `Bash(gmax project)` for overview of a new codebase
3. **Search** — `Bash(gmax "query" --agent)` to find code. Add `--symbol` for function/class names.
4. **Peek** — `Bash(gmax peek <symbol>)` for a quick overview (signature + callers + callees)
5. **Extract** — `Bash(gmax extract <symbol>)` for the full function body with line numbers
6. **Skeleton** — `Bash(gmax skeleton <path>)` before reading large files, or use `--skeleton` on search
7. **Read** — `Read file:line` for specific ranges identified by search/skeleton
8. **Trace** — `Bash(gmax trace <symbol>)` for deep call flow (multi-hop)
9. **Diff** — `Bash(gmax diff [ref])` to see what changed and search within changes
10. **Test** — `Bash(gmax test <symbol>)` to find tests covering a symbol before editing
11. **Impact** — `Bash(gmax impact <symbol>)` for blast radius before significant changes
12. **Similar** — `Bash(gmax similar <symbol>)` to find similar patterns for DRY analysis
13. **Context** — `Bash(gmax context "topic" --budget 4000)` for a token-budgeted topic summary
14. **Related** — `Bash(gmax related <file>)` to see what else to look at
15. **Status** — `Bash(gmax status)` to check index state across all projects

## MCP tools

Use MCP only for `index_status` and `summarize_directory`. Use CLI for everything else. For cross-project search, use `scope: "all"` on semantic_search (replaces search_all).

## Tips

- **Use `--agent` for compact output** — supported on search, trace, symbols, related, recent, status, project.
- **Be specific.** 5+ words. "auth" returns noise. "where does the server validate JWT tokens" is specific.
- **Use `--role ORCHESTRATION`** to skip type definitions and find the actual logic.
- **Use `--symbol`** when the query is a function/class name — gets search + trace in one call.
- **Use `--skeleton`** when `--agent` results aren't enough — shows file structure for top matches.
- **Use `--imports`** when you need to understand a file's dependencies.
- **Use `--root <dir>`** to search/trace/query a different project from your current directory.
- **Don't search for exact strings** — use grep/Grep for that. gmax finds concepts.

## If search fails or returns nothing

1. Check if the project is added: `Bash(gmax status)`
2. If not added: `Bash(gmax add)`
3. If stale: `Bash(gmax index)` to force re-index
