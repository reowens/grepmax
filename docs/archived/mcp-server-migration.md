---
type: plan
status: archived
created: 2026-06-28T07:05:38Z
updated: 2026-08-04T11:08:10Z
surfaces:
modules:
domain:
audience: internal
parent_plan:
related_plans:
  - 2026-06-28-repo-audit-hardening.md
related_docs:
current_state: >
  The Server-to-McpServer migration shipped in `e80daca`; the result-shape follow-up shipped
  in `04a87a4`. The current server registers 27 tools with Zod schemas, explicit registered-project
  scoping, protocol coverage, and subsequent lifecycle/performance hardening.
next_step: >
  None. Dependency pins are independent maintenance constraints, not unfinished migration work.
---

# Mcp Server Migration

## Problem

A maintenance/hardening sweep (2026-06-27/28) shipped README accuracy fixes, MCP
cross-project usability (server `instructions`, `list_projects` tool, scope
fallback), dependency hygiene (dead-dep removal + in-range updates + 4 major
bumps), a repo-wide biome cleanup, and a `pnpm format` footgun fix. Several
follow-ups were deliberately deferred. This plan tracks them. The one actionable
item is the **optional** MCP `Server` → `McpServer` migration (fully scoped
below); the rest are deliberate holds.

## Open task backlog

| # | Item | Status | Why deferred |
|---|------|--------|--------------|
| 1 | MCP `Server` → `McpServer` migration | ✅ shipped | done 2026-06-28; see "Shipped" note below |
| 2 | apache-arrow 18 → 21 | 🔒 blocked | LanceDB peerDep caps at `<=18.1.0`; wait for LanceDB |
| 3 | onnxruntime-node 1.24.3 → 1.27 | ⏸️ hold | native ABI, exact-pinned; bump only with per-platform native-load test |
| 4 | biome 2.4.10 → 2.5.1 | ⏸️ hold | minor; its formatter defaults differ → would re-churn the just-cleaned repo |
| 5 | Sentinel absorption (`NEXT.md`) | strategic | separate initiative; gmax index/search become Sentinel's core |

The dependency rows are historical context. Apache Arrow remains capped by LanceDB 0.30's
peer dependency; ONNX Runtime and Biome remain deliberate pins. None blocks this migration.

## ✅ Shipped: MCP `Server` → `McpServer` migration (2026-06-28, SDK 1.29.0)

**Shipped 2026-06-28.** Done exactly as scoped: 26 `registerTool()` calls over Zod
raw shapes (required mirrors the old `required:[]`, everything else `.optional()`,
field docs via `.describe()`, the 2 enums + 1 string-array preserved), swapped to
`new McpServer(serverInfo, options)`, deleted the `TOOLS` array + `ListTools`/26-case
`CallTool` switch, extracted the 4 inline handlers (investigate/review_commit/
review_risk/review_report) verbatim, and kept all other `handleX` bodies + `ok()`/
`err()` unchanged. A `tool()` registrar re-applies the old per-call timing + query
logging. Acceptance met: `tsc` clean, `biome check` clean, 515/515 tests, build
clean, full stdio-MCP smoke (26 advertised; 24 invoked OK; `_meta` alwaysLoad
preserved; Zod rejects missing required args, surfaced as an `isError` result per
SDK design). Isolated to `src/commands/mcp.ts`; one `git revert` undoes it. The
scoping notes below are retained for history.

**Not forced.** The SDK marks the low-level `Server` `@deprecated` but explicitly
sanctions it "for advanced use cases" — gmax's 26-tool single-`CallToolRequestSchema`
switch with custom `_meta` qualifies. `tsc` passes clean; the deprecation is an
editor-only hint (see the documenting comment at the `Server` import in
`src/commands/mcp.ts`). Payoff: removes the hint + free Zod input validation.

**Verified facts (installed SDK 1.29.0, not perplexity's stale general answer):**
- Constructor is `new McpServer(serverInfo, options?)` — TWO args, same shape as
  today's `Server`. Our `instructions` + `capabilities` move over verbatim.
- `registerTool(name, {title?, description?, inputSchema?, outputSchema?,
  annotations?, _meta?}, cb)`. `_meta` is supported → `anthropic/alwaysLoad` works.
- `inputSchema` accepts **Zod only** (`ZodRawShapeCompat = Record<string, ZodSchema>`
  or a full Zod schema) — **NOT** plain JSON Schema. This is the whole cost: all 26
  hand-written JSON-Schema inputs must be rewritten as Zod raw shapes.
- Handler is `(args, extra) => CallToolResult`; `args` is the validated object.
  Current handlers take `(args)` and parse defensively → compatible as-is.
- `zod@4.4.3` is already a dependency; no new dep. `ok()`/`err()` already return
  `CallToolResult` with `isError` → unchanged.

**Work:**
1. Convert 26 tools' JSON-Schema `inputSchema` → Zod raw shapes. Complexity is low:
   mostly flat string/number/boolean; only 2 enums (`get_neighbors`, `find_paths`)
   and 1 string-array (`subgraph_for_files`). Rule: anything not in the old
   `required:[]` gets `.optional()`; preserve field docs via `.describe()`.
   `semantic_search` (~20 fields) is the one big one; the rest are 1–3 fields.
2. Swap constructor to `McpServer`; delete the `TOOLS` array (mcp.ts ~lines 44–543),
   the `ListToolsRequestSchema` handler, and the 26-case `CallToolRequestSchema`
   switch. Replace with 26 `registerTool(name, {...}, args => handleX(args))` calls.
3. Keep all `handleX` bodies + `ok()`/`err()` unchanged.

**Required-field map (drives `.optional()`):** single-required — semantic_search(query),
code_skeleton(target), trace_calls/extract_symbol/peek_symbol/dead/get_neighbors(symbol),
related_files(file), find_tests/impact_analysis/find_similar(target), build_context(topic),
investigate(question); two — find_paths(from,to); array — subgraph_for_files(files);
zero-arg — audit, list_symbols, index_status, list_projects, summarize_directory,
summarize_project, recent_changes, diff_changes, review_commit, review_report, review_risk.

**Risk: medium.** One vector — Zod now validates inputs the loose switch tolerated.
A field wrongly marked required rejects previously-working calls. Mitigation: mirror
the old `required:[]` exactly, everything else `.optional()`; Zod objects strip (not
reject) unknown keys, so extra fields stay safe. **Reversibility: easy** — isolated
to `mcp.ts`, one `git revert`.

**Effort: ~half-day (~4h):** ~1.5h schema conversion, ~1h rewire + delete dispatch,
~1h smoke-test all 26 tools over the MCP protocol + run the 515-test suite, ~0.5h buffer.

**Acceptance:** all 26 tools smoke-tested via stdio MCP; `biome check` clean; build,
typecheck, 515 tests pass; deprecation hint gone (drop the documenting comment).

## Done this session (context, all committed to `main`)

- `feat(mcp)`: server `instructions`, `list_projects` tool (alwaysLoad), and
  `semantic_search` scope fallback (search-all when cwd isn't a registered project).
- README: structure-aware vs text-indexed language tiers (SQL was overclaimed; added
  Scala/Lua); documented missing search flags (`--in`, `--seed-*`, `--compact`,
  `--plain`, etc.); added the 5 undocumented MCP tools + `list_projects`; npm badges;
  `--agent` ~89% wording.
- `chore(deps)`: removed dead `piscina` + `@anthropic-ai/claude-agent-sdk`; added
  `tsx`; in-range updates; majors node-gyp 13, @types/node 26, uuid 14, commander 15
  (+ `engines: node>=22.12`). Held: apache-arrow (LanceDB cap), onnxruntime (ABI), biome.
- `style/fix(biome)`: repo-wide formatter pass + full lint cleanup; `biome check` clean.
- `refactor(mcp,scripts)`: `format` → `biome format --write` (safe); new `lint:fix` =
  `biome check --write`; trimmed `index_status` to a health overview (delegates the
  per-project listing to `list_projects`).
- `refactor(mcp)`: **MCP `Server` → `McpServer` migration shipped** — 26
  `registerTool()` calls over Zod raw shapes; `TOOLS` array + dispatch switch
  removed; deprecation hint gone; verified by tsc/biome/515 tests + full stdio-MCP
  smoke test.

## Version History

- **2026-08-04T11:08:10Z** Archived — McpServer migration shipped; dependency pins are independent maintenance constraints.
- **2026-06-28T07:35:33Z** Status: active → partial.
- 2026-06-28 — MCP `Server`→`McpServer` migration **shipped** (the headline
  actionable item); plan moved to `partial` (shipped + deferred-hold tail).
- 2026-06-28 — created; tracks post-maintenance backlog, headlined by the scoped
  (optional) MCP `Server`→`McpServer` migration.
- **2026-08-04** Final review: migration remains shipped with 27 current tools; unrelated
  dependency holds no longer keep this plan live.

## Closeout

Migration shipped in `e80daca`, with `04a87a4` fixing MCP search-result shape consumers.
Subsequent project-scope, lifecycle, and daemon-search changes are covered by their own plans
and tests. Dependency upgrades should be handled as focused maintenance when their blockers lift.
