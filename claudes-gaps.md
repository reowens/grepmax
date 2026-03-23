# Claude's Gaps — Features that would make gmax better for AI agents

*Written by Claude, from direct experience using gmax via MCP in real coding sessions.*
*Last updated: v0.7.8 (2026-03-22)*

---

## Shipped

### v0.7.5
- **Callee file paths in `trace_calls`** — callees now show `-> symbol file:line`
- **File name filter** — `file: "syncer.ts"` matches any path ending in that filename
- **Exclude filter** — `exclude: "tests/"` removes paths from results
- **Per-project chunk counts** — `index_status` shows chunk count per indexed directory

### v0.7.6
- **Directory skeleton** — `code_skeleton target: "src/lib/search/"` returns all files
- **Batch skeleton** — comma-separated targets in one call

### v0.7.7
- **Full content mode** — `detail: "full"` returns complete chunk with line numbers
- **Language filter** — `language: "ts"` restricts to file extension
- **Role filter** — `role: "ORCHESTRATION"` shows only logic/flow code

### v0.7.8
- **Project filter for search_all** — `projects: "platform,osgrep"` or `exclude_projects: "capstone"`

---

## Phase 4 — Quick wins (easy, high impact)

### Line numbers in skeleton output
Skeleton shows `function initialSync(...)` but no line number. I can't jump to it without searching again. Adding `// :164` annotations makes skeletons directly navigable.

**Effort:** Easy — the skeletonizer already has line info from Tree-sitter nodes, just not formatting it.

### Symbol type info in `list_symbols`
Returns `symbol\tfile:line` but doesn't say function vs class vs interface vs type. When searching `Auth`, 15 results and no way to tell which is the class vs the type.

**Want:** `AuthService [class]\tsrc/auth/service.ts:12` — add role/type annotation.

**Effort:** Easy — `defined_symbols` chunks have `role` and could infer type from Tree-sitter node type stored during chunking.

### Context lines in search results
A chunk at lines 45-90 might depend on variables at line 30. Need N lines before/after to understand it.

**Want:** `context_lines: 5` param on semantic_search that includes surrounding lines.

**Effort:** Easy — read the file, grab `startLine - N` to `endLine + N`, format with line numbers.

---

## Phase 5 — Medium effort, high impact

### Project overview tool (`summarize_project`)
When encountering a new codebase, I need "what is this, what are the entry points, what are the subsystems?" Currently takes 5-10 tool calls to piece together.

**Want:** `summarize_project` MCP tool that returns: project name, language breakdown, top-level directory structure, entry points (files with main/index/app), key symbols by chunk count, total files/chunks.

**Effort:** Medium — aggregate from existing index data (path patterns, symbol counts, role distribution).

### Import context in search results
When a result appears in `syncer.ts`, I don't know what it depends on without a Read call.

**Want:** `include_imports: true` flag that prepends the file's import block to each result.

**Effort:** Medium — read first N lines until imports end, language-aware detection.

### Combined symbol + semantic search
Search for "handleAuth" → get definition + implementation + callers in one shot.

**Want:** `mode: "symbol"` that auto-detects symbol-like queries and appends trace data.

**Effort:** Medium — symbol detection heuristic + inline trace.

### Multi-hop trace (`depth: 2`)
"What calls the thing that calls handleAuth?" requires two trace calls.

**Want:** `depth` param for N-hop graph traversal with cycle detection.

**Effort:** Medium — recursive traversal, deduplicate nodes.

---

## Phase 6 — Medium effort, moderate impact

### Recent changes awareness
After watcher re-indexes, can't see what was updated. No way to focus on actively modified code.

**Want:** `recent_changes` tool or `--recent` flag that sorts by index time / shows recently modified files.

**Effort:** Medium — MetaCache has mtimeMs, could sort/filter by it.

### Related files discovery
When editing `syncer.ts`, what other files typically change with it?

**Want:** `related_files` tool powered by co-import analysis (files that share imports/symbols).

**Effort:** Medium — analyze import overlap from indexed chunks.

### Find usages (import tracking)
`trace_calls` finds callers but not files that import/re-export a symbol.

**Want:** `imports` section in trace output showing files that import the symbol.

**Effort:** Medium — scan import statements in content field.

### Structured skeleton output
Skeleton is a text blob. JSON output with `{name, line, signature, type}` per symbol would enable programmatic navigation.

**Want:** `--json` flag or `format: "json"` param on code_skeleton.

**Effort:** Medium — skeletonizer already has structured data, just needs a JSON formatter.

---

## Nice to have

### Stale result indicator
`stale: true` per result based on file mtime vs index time.

### Search confidence explanation
Why a result is High/Medium/Low confidence.

### Regex name pattern filter
`name_pattern: "handle.*Auth"` to filter by symbol naming pattern.

---

## What's already great

- **Pointer mode** is the right default — metadata without code saves massive context
- **Role classification + filter** lets me skip noise and find orchestration code
- **Summaries** are the killer feature — understand code without reading it
- **`code_skeleton`** with directory/batch mode is indispensable
- **`detail: "full"`** eliminates most Read calls after search
- **`language` filter** essential in polyglot repos
- **`projects`/`exclude_projects`** on search_all scopes cross-project search
- **Non-blocking indexing** with progress feedback prevents hanging
- **FTS warnings** surface degraded search instead of silently failing
- **Composable filters** — language + role + file + exclude + projects all work together
- **Callee file paths** in trace eliminate follow-up searches
