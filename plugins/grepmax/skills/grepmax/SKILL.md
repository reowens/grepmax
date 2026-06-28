---
name: grepmax
description: Semantic code search. Use alongside grep - grep for exact strings, gmax for concepts.
allowed-tools: "Bash(gmax:*), Read"
---

## When to use what

- **Know the exact string/symbol?** → `Grep` tool (fastest, zero overhead)
- **Know the file already?** → `Read` tool directly
- **Searching by concept/behavior?** → `Bash(gmax "query" --agent)` (semantic search)
- **Need full function body?** → `Bash(gmax extract <symbol>)` (complete source with line numbers)
- **Quick symbol overview?** → `Bash(gmax peek <symbol>)` (signature + callers + callees)
- **Need file structure?** → `Bash(gmax skeleton <path>)`
- **Need call flow?** → `Bash(gmax trace <symbol>)`
- **Is a symbol unused?** → `Bash(gmax dead <symbol>)` (call-graph check — hypothesis, not proof)

## Quick start

Use `--agent` for the most token-efficient output (one line per result with signature hints).

```
Bash(gmax "auth handler" --role ORCHESTRATION --lang ts --agent -m 3)
```

## Project management

Projects must be added before search works. These commands auto-start the daemon if not running:

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

The `--agent` flag produces compact, token-efficient output for AI agents. It works on most commands — `search`, `peek`, `extract`, `trace`, `test`, `impact`, `similar`, `dead`, `log`, `related`, `symbols`, `status`, `project`, `context`, `skeleton`, and `doctor`.

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

Output: `file:line symbol [ROLE] — signature_hint` (one line per result). When multiple hits land in the same file, they collapse under a `path/to/file.ts (N hits):` header with indented children — saves the repeated path prefix.

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
gmax trace handleAuth --inbound --agent    # callers-only with call-site snippets (path:line\tsymbol\tsnippet)
gmax trace handleAuth --inbound --no-snippets   # drop the snippet column
gmax trace handleAuth --inbound --limit 20      # show up to 20 callers (default 10, max 30)
```

### Extract — `gmax extract <symbol>`
```
gmax extract handleAuth                    # full function body with line numbers
gmax extract handleAuth --agent            # compact: path:start-end then raw code
gmax extract handleAuth --imports          # prepend file imports
gmax extract handleAuth --root ~/project   # extract from different project
gmax extract handleAuth --no-tests         # suppress tests footer (default-on)
```
Output ends with a `--- tests:` footer listing tests that exercise the symbol (default-on; opt-out with `--no-tests`).

### Peek — `gmax peek <symbol>`
```
gmax peek handleAuth                       # signature + callers + callees
gmax peek handleAuth --agent               # compact TSV output
gmax peek handleAuth -d 2                  # 2-hop callers
gmax peek handleAuth --root ~/project      # peek in different project
gmax peek handleAuth --no-tests            # suppress tests footer (default-on)
```
Agent output ends with `t: <test-file>:line\t<test-symbol>\t<hop-label>` rows where hop-label is `direct`, `N-hop`, or `via-import`.

### Skeleton — `gmax skeleton <target>`
```
gmax skeleton src/lib/auth.ts              # single file
gmax skeleton handleAuth                   # by symbol name (finds its file)
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
When both directions are empty, falls back to files mentioning the input file's basename. Generic basenames (`index`, `main`, `lib`, etc.) skip the fallback.

### Commit history — `gmax log <path-or-symbol>`
```
gmax log src/lib/auth.ts                   # commits touching this file
gmax log src/lib/                          # commits touching this directory
gmax log handleAuth                        # commits across all files defining the symbol
gmax log handleAuth --in src/              # restrict symbol resolution to a sub-path
gmax log src/lib/auth.ts --limit 5         # last 5 commits
gmax log src/lib/auth.ts --from main       # commits since main (range main..HEAD)
gmax log src/lib/auth.ts --since "2 weeks ago"
gmax log src/lib/auth.ts --author Robert
gmax log src/lib/auth.ts --no-follow       # disable rename tracking (default: on for files)
gmax log src/lib/auth.ts --agent           # TSV: hash\tisoDate\tauthor\tsubject\tfilesChanged\tins\tdel\ttouchedFiles
```

### Symbols — `gmax symbols`
```
gmax symbols                               # list indexed symbols
gmax symbols auth -p src/ --root ~/proj    # filter by name, path, project
gmax symbols --agent                       # compact: symbol\tpath:line\tcount
```

### Test — `gmax test <symbol|file>`
```
gmax test handleAuth                   # tests calling handleAuth (call-graph + import-fallback)
gmax test src/lib/auth.ts              # tests for symbols in this file
gmax test handleAuth -d 2              # 2-hop: tests calling callers too
gmax test handleAuth --agent           # compact output
```
Hop labels: `direct` (calls the symbol), `N-hop` (calls a transitive caller), `via-import` (test references the symbol via import or mock when no call-graph match exists).

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

### Dead — `gmax dead <symbol>`
```
gmax dead handleAuth                   # zero-inbound-callers check via the call graph
gmax dead handleAuth --agent           # TSV: status\tdef:line\tcaller_count\tcallers_top3
gmax dead handleAuth --in src/         # restrict to a sub-path
```
Status is `DEAD` (no callers, not exported), `PUBLIC EXPORT` (no internal callers but the defining chunk is exported — check external usage), or `LIVE` (with caller count + top-3 file:line). The call graph reflects what tree-sitter chunked: dynamic dispatch, reflection, eval, and string-built call sites won't show up — `DEAD` is a hypothesis, not a proof.

### Context — `gmax context <topic-or-path> --budget <tokens>`
```
gmax context "authentication system" --budget 4000
gmax context "payment flow" --budget 8000
gmax context src/lib/auth.ts --budget 3000
gmax context src/lib/auth/ --budget 3000
```
Use the path form when you already know the file or directory; it skips semantic search and gives deterministic structure/excerpt context.

### Investigate — `gmax investigate "question"` (requires LLM)
```
gmax investigate "how does authentication work?"
gmax investigate "what would break if I changed VectorDB?" -v
gmax investigate "where are API routes defined?" --root ~/project --rounds 5
```
Agentic Q&A: a local LLM autonomously uses gmax tools (search, trace, peek, impact, related) to gather evidence and answer. Requires `gmax llm on && gmax llm start`. Use `-v` to see tool calls and reasoning.

### Other
```
gmax status                                # show all indexed projects
gmax status --agent                        # compact: name\tchunks\tage\tstatus
gmax related src/file.ts --agent           # compact: dep:/rev: path\tcount
gmax project --agent                       # compact: key\tvalue pairs
gmax index                                 # reindex current directory
gmax config                                # view/change settings
gmax doctor                                # health check
gmax doctor --fix                          # auto-repair (compact, prune, clear stale locks)
gmax llm on/off/start/stop/status          # manage local LLM server
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
9. **Log** — `Bash(gmax log <path-or-symbol>)` for git commit history on a path or symbol
10. **Test** — `Bash(gmax test <symbol>)` to find tests covering a symbol before editing
11. **Impact** — `Bash(gmax impact <symbol>)` for blast radius before significant changes
12. **Similar** — `Bash(gmax similar <symbol>)` to find similar patterns for DRY analysis
13. **Dead** — `Bash(gmax dead <symbol>)` to check if a symbol has zero inbound callers (hypothesis, not proof)
14. **Context** — `Bash(gmax context "topic-or-path" --budget 4000)` for token-budgeted topic or path context
15. **Related** — `Bash(gmax related <file>)` to see what else to look at
16. **Status** — `Bash(gmax status)` to check index state across all projects

## Tips

- **Use `--agent` for compact output** — works on most commands: search, peek, extract, trace, log, test, impact, similar, dead, related, status, project, doctor.
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
3. If stale: `Bash(gmax index)` to re-index (auto-detects and repairs cache/vector mismatches)
