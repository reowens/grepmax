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
- Search: `osgrep "where is JWT token validation and expiration checking"`
- Trace: `osgrep trace "AuthService"`
- Symbols: `osgrep symbols "Auth"`

## ⚡ Query Tips: Be SPECIFIC
**Semantic search works best with detailed, contextual queries.**
- ✅ GOOD: "where is JWT token validation and expiration checking"
- ✅ GOOD: "how does the worker pool handle crashed processes"
- ✅ GOOD: "middleware that checks user permissions before API calls"
- ❌ WEAK: "auth logic" (too vague, poor semantic signal)
- ❌ WEAK: "validation" (too generic, needs context)

**More words = better semantic matching.** Add context, intent, and specifics.

## Output (Default = Compact TSV)
- One line per hit: `path\tlines\tscore\trole\tconf\tdefined\tpreview`
- Header includes query and count.
- Roles are short (`ORCH/DEF/IMPL`), confidence is `H/M/L`, scores are short (`.942`).
- Use `path` + `lines` with `Read` to fetch real code.

## When to Use
- Find implementations: "where does the code validate user input before database insertion"
- Understand concepts: "how does express middleware chain requests to handlers"
- Explore architecture: "authentication flow from login to session creation"
- Trace impact: "who calls X / what does X call"

## Quick Patterns
1) "How does X work?"
   - `osgrep "how does the authentication middleware verify JWT tokens and check permissions"`
   - Read the top ORCH hits.
2) "Who calls this?"
   - `osgrep --trace "SymbolName"`
   - Read callers/callees, then jump with `Read`.
3) Narrow scope:
   - `osgrep "middleware that authenticates API requests using bearer tokens" src/server`
   
**Remember:** Longer, more specific queries significantly improve semantic search quality.

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
- `-m <n>` - Limit max results (default: 10)
- `--compact` - Show file paths only

Example with filtering:
```bash
osgrep "user authentication with password hashing and session tokens"
```

## Tips
- Previews are hints; not a full substitute for reading the file.
- **Results are hybrid (semantic + literal); LONGER, MORE SPECIFIC natural language queries work significantly better than short generic terms.**
- Think of queries like asking a colleague: be specific about what you're looking for.
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