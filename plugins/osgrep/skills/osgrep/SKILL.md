---
name: osgrep
description: Semantic code search and call-graph tracing for AI agents. Finds code by concept, surfaces roles (ORCHESTRATION vs DEFINITION), and traces dependencies. Output is compact TSV for low token use.
allowed-tools: "Bash(osgrep:*), Read"
license: Apache-2.0
---

## ⚠️ CRITICAL: Handling "Indexing" State
If any `osgrep` command returns a status indicating **"Indexing"**, **"Building"**, or **"Syncing"**:
1. **STOP** your current train of thought.
2. **INFORM** the user: "The semantic index is currently building. Search results will be incomplete."
3. **ASK**: "Do you want me to proceed with partial results, or wait for indexing to finish?"
   *(Do not assume you should proceed without confirmation).*

## Core Commands
- Search: `osgrep "how does auth work"`
- Trace: `osgrep trace "AuthService"`
- Symbols: `osgrep symbols "Auth"`

## Output (Default = Compact TSV)
- One line per hit: `path\tlines\tscore\trole\tconf\tdefined\tpreview`
- Header includes query and count.
- Roles are short (`ORCH/DEF/IMPL`), confidence is `H/M/L`, scores are short (`.942`).
- Use `path` + `lines` with `Read` to fetch real code.

## When to Use
- Find implementations: “where is validation logic”
- Understand concepts: “how does middleware work”
- Explore architecture: “authentication system”
- Trace impact: “who calls X / what does X call”

## Quick Patterns
1) “How does X work?”
   - `osgrep "how does X work"`
   - Read the top ORCH hits.
2) “Who calls this?”
   - `osgrep --trace "SymbolName"`
   - Read callers/callees, then jump with `Read`.
3) Narrow scope:
   - `osgrep "auth middleware" src/server`

## Command Reference

### `search [pattern] [path]`
Semantic search. Returns ranked results with roles (ORCH/DEF/IMPL).
- `--compact`: TSV output (default for agents).
- `--max-count N`: Limit results.

### `trace <symbol>`
Show call graph for a specific symbol.
- Callers: Who calls this?
- Callees: What does this call?
- Definition: Where is it defined?

### `symbols [filter]`
List defined symbols.
- No args: List top 20 most referenced symbols.
- With filter: List symbols matching the pattern.
- `-l N`: Limit number of results.

## Useful Options

- `--scores` - Show relevance scores (0-1) for each result
- `--min-score <n>` - Filter out low-confidence results (e.g., `--min-score 0.5`)
- `-m <n>` - Limit max results (default: 10)
- `--compact` - Show file paths only

Example with filtering:
```bash
osgrep "authentication" --scores --min-score 0.5
```

## Tips
- Previews are hints; not a full substitute for reading the file.
- Results are hybrid (semantic + literal); longer natural language queries work best.
- If results span many dirs, start with ORCH hits to map the flow.

## Typical Workflow

1. **Discover** - Use `search` to find relevant code by concept
    ```bash
    osgrep "worker pool lifecycle" --compact
    # → src/lib/workers/pool.ts:112 WorkerPool
    ```

2. **Explore** - Use `symbols` to see related symbols
    ```bash
    osgrep symbols Worker
    # → WorkerPool, WorkerOrchestrator, spawnWorker, etc.
    ```

3. **Trace** - Use `trace` to map dependencies
    ```bash
    osgrep trace WorkerPool
    # → Shows callers, callees, definition
    ```

4. **Read** - Use the file paths from above with `Read` tool
    ```bash
    Read src/lib/workers/pool.ts:112-186
    ```