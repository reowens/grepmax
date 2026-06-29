---
type: plan
status: active
created: 2026-06-28T22:05:47Z
updated: 2026-06-29T08:40:18Z
surfaces:
  - graph
  - search
  - index
  - embeddings
modules:
  - src/lib/graph/graph-builder.ts
  - src/lib/index/chunker.ts
  - src/lib/graph/callsites.ts
  - src/eval.ts
  - src/lib/store/meta-cache.ts
domain: call-graph precision + token-efficiency improvements derived from a graphify teardown
audience: internal
summary: Graphify-derived roadmap for call-graph precision, audit cycle detection, and remaining orientation signals.
parent_plan:
related_plans: ../agent-ux-proposals.md
related_docs:
current_state: >
  Phase 1 is shipped. Phase 2 call-graph precision is effectively complete through the
  v0.21.2-v0.22.0 line: builtin callee suppression, the additive
  `member_referenced_symbols` substrate, same-file/same-family callee preference,
  language-family anchoring for inbound consumers, caller-side builtin-member suppression,
  confidence tiers, peek/trace/MCP edge-kind presentation, and `gmax audit` file dependency
  cycles as bounded SCCs over unambiguous in-project symbol references. The plain member split
  was rejected after measuring a real ~1,100 project-method edge recall loss. The import-evidence
  resolver was remeasured on a member-populated index and is not worth building now (~181
  occurrences, mostly `log`). Remaining Graphify-derived roadmap is Phase 3 orientation:
  embedding-native "surprising connections" only.
next_step: >
  If continuing Graphify work, evaluate embedding-native "surprising connections" as a
  measure-first orientation signal. Do not build the plain member split, general import-evidence
  resolver, or literal import-cycle detector unless new corpus measurements change the premise.
---

# Graphify Derived Improvements

## Problem

A teardown of **graphify** (safishamsi/graphify — a Python tool that turns a repo
into an embedding-free NetworkX knowledge graph) surfaced concrete techniques gmax
could adopt. Three parallel agents read graphify's full implementation and compared
it against gmax's actual source; the load-bearing claims were then verified by hand
against gmax HEAD (see "Verified findings" below).

The meta-finding: where gmax is **embedding-centric** (search, incremental indexing)
it equals or beats graphify. Where gmax is **graph-centric** (the `trace`/`impact`/
`related`/`peek` call graph) it is the **weakest part of the tool** — bare-name
matching with no disambiguation produces phantom edges, exactly the problem graphify
poured engineering into. That, plus the absence of a token-savings benchmark, is
where the value is.

This plan is sibling to **agent-ux-proposals**, which works the call-graph *recall*
side (type-position edges, `trace --inbound`/`dead` recall). This plan is the
*precision* side (suppressing phantom/ambiguous edges) — complementary, not
overlapping.

## Verified findings (against gmax HEAD)

- `getCallers(sym)` is an unfiltered `array_contains(referenced_symbols, sym)` with
  no language or member-call guard — `graph-builder.ts:87-93`.
- `obj.method()` is flattened to bare `method` and pushed into the same list as a
  free `method()` call — `chunker.ts:766-800`. So `getCallers("get")` returns every
  chunk that calls any `.get()`.
- `getCallees`/`resolveLocation` take `.limit(1)` — an **arbitrary** definition when
  a name exists in multiple files — `graph-builder.ts:113, 362`.
- The builtin denylist is **display-only** ("Only consulted for UNRESOLVED names") —
  `callsites.ts:96-97, 262`. It never suppresses a bad edge.
- `eval.ts` measures Recall@10/MRR only; there is **zero** token-savings metric.

## Phases

### Phase 1 — Do first (low effort, independently shippable, no schema change) ✅ shipped

1. **Token-savings benchmark.** ✅ DONE (`src/eval-tokens.ts`, `bench:tokens`).
   Measured on the gmax index (97 cases): **gmax pointer median 8.5×** (p25 3.0×,
   p75 17.9×, mean 12.3×); **gmax pointer+symbol median 4.4×** (p25 1.6×, p75 8.6×,
   mean 5.4×). Defensible single-to-low-double-digit numbers that substantiate the
   shipped "~4× fewer tokens" skeleton claim, with a conservative whole-file-Read
   baseline (single file → ratio is a floor). A sibling harness to `eval.ts` that, per case,
   compares whole-file-Read tokens (what an agent does after grep) vs the bytes gmax
   actually returns (`semantic_search detail:pointer` + `code_skeleton` +
   `extract_symbol`). Reuse the existing `len/4` estimator (`mcp.ts:714/2216`) and
   `eval.ts` `cases[].expectedPath`. **Do NOT copy graphify's methodology** — its
   "70×/100×" compares one subgraph to the *entire corpus* (`corpus_words=nodes*50`,
   `benchmark.py:113`), which no agent reads; it is inflated. An honest Read-baseline
   yields a defensible single-to-low-double-digit number that substantiates the
   already-shipped "~4× fewer tokens" skeleton claim. Highest value-to-effort.

2. **Cross-language phantom-edge guard.** ✅ DONE. Added `languageFamily` +
   `languageFamilyForPath` to `core/languages.ts` (JS/TS/JSX/TSX → one family; C/C++
   → one; everything else its own), and a query-time guard in `graph-builder.ts`:
   `getCallers(symbol, anchorFamily?)` drops callers from a *different known* family
   (unclassifiable rows kept → never lose a real edge), `resolveLocation(symbol,
   anchorFamily?)` prefers the same-family definition over the old arbitrary
   `.limit(1)`. Anchored from the center in `buildGraph`, from `caller.file` in
   multi-hop `expandCallers`, from the origin in `getNeighbors`, and self-resolved in
   `callersOf`. No schema change. Tests in `languages.test.ts` + `graph-builder.test.ts`.

3. **Markdown frontmatter-insensitive hashing.** ✅ DONE. Added
   `stripMarkdownFrontmatter` + `computeContentHash(buffer, path)` to
   `file-utils.ts` (strips a whole-line `^---$`…`^---/...$` block, anchored at file
   start with optional BOM — NOT a `startsWith`, so a thematic break with no closing
   fence is left intact). Wired into all three hash paths (orchestrator worker,
   batch-processor catchup, watcher-manager fast-path) so they agree. One-time
   re-embed of existing `.md` on next index is expected and self-healing. Tests in
   `file-utils.test.ts`. (graphify: `cache.py:71-83`.)

### Phase 2 — Call-graph accuracy pass ✅ resolved (v0.21.2-v0.22.0)

4. **Member-call edges.** ✅ Shipped via the measured query-time precision path, not the
   plain split. `member_referenced_symbols` exists as an additive substrate, callers are
   tagged/sorted by edge kind, and builtin-named member callers are suppressed. The measured
   plain split would have dropped ~1,100 genuine project-method edges, so it remains rejected.

5. **Import-evidence disambiguation.** 🚫 Remeasured on a clean member-populated index and
   explicitly not worth building now: ~181 high-confidence occurrences, mostly one logger
   symbol. Reopen only if a larger corpus shows the free-ambiguity rate rising well above ~2%.

6. **Confidence tiers on edges.** ✅ Shipped. Caller edges are tagged/sorted, and
   peek/trace/MCP surface low-confidence member/type edges instead of presenting every edge as
   equally factual.

### Phase 3 — Orientation signal (medium effort, embedding-native) 🟡 in-progress

7. **Embedding-native "surprising connections."** graphify *infers* semantic
   similarity; gmax has real vectors. Cross `find_similar` (`mcp.ts:2107`) with the
   call graph to surface pairs highly similar in embedding space but with **no call
   edge and in different directories** = duplicate/parallel logic. A genuine
   orientation signal `project` lacks, computed natively. (graphify: `analyze.py:252`.)

8. **File-level dependency-cycle detection in `audit`.** ✅ SHIPPED. `computeAudit`
   collapses unambiguous in-project symbol references to file edges, skips builtin and
   ambiguous names, enumerates bounded SCCs, and surfaces them in CLI + MCP audit output.
   This intentionally reports symbol-derived dependency cycles, not literal parsed import
   cycles. (graphify: `analyze.py:628`.)

## Explicitly NOT adopting

- **Already ≥ graphify:** git hooks & flock (gmax's single-writer daemon +
  `@parcel/watcher` + catchup wins), god-nodes (`audit` ranks by distinct cross-file
  inbound refs, better than raw degree), stat-cache + APFS mtime truncation,
  querylog, token-budgeted retrieval.
- **Skip:** community detection (directories ≈ communities; no networkx in TS),
  MinHash dedup (gmax gets semantic near-dup free via vectors), content-hash reuse
  (marginal vs path-keyed cache), SCIP ingestion (heavy graft, poor fit for
  zero-config default), `suggest_questions` + lessons-memory (different product
  surface), cargo/pg introspection, two-hash manifest, per-entry version stamping
  (optimization of an already-safe project-granularity `repair --rebuild`).

## Token benchmark — implementation spec (preplanned 2026-06-28)

Detailed, hand-off-ready scope for Phase 1 #1. A second preplan pass verified every
"reuse" claim against gmax HEAD; the one broken assumption is flagged.

### File & wiring
- New `src/eval-tokens.ts`, sibling to `eval.ts`/`eval-oss.ts`.
- `package.json`: add `"bench:tokens": "npx tsx src/eval-tokens.ts"` +
  `"bench:tokens:json": "GMAX_EVAL_JSON=1 npx tsx src/eval-tokens.ts"`.
- Reuse the harness bootstrap from `eval.ts:585-644` verbatim: pin
  `GMAX_WORKER_COUNT=1`, open `VectorDB`+`Searcher` on cwd, bail if `hasAnyRows()`
  is false. Loop the **same 97 `cases`** (imported from `eval.ts`; each has
  `query` + `expectedPath`). No new fixtures.

### Per-case measurement
- **Baseline (no gmax — grep then Read the file):** read the first `expectedPath`
  (pipe-split on `|`, mirroring `evaluateCase`'s path handling at `eval.ts:552-555`),
  full file → `estTokens(fileBytes)`. Conservative: real agents read several files
  after grep, so a one-file baseline UNDER-counts → the ratio is a floor.
- **gmax: pointer** — `searcher.search(query, 20, {rerank})` →
  `formatMcpPointerSearchResults(res.data, projectRoot, { query })` (EXPORTED at
  `mcp.ts:142`, callable with just `{query}`) → `estTokens(rendered)`.
- **gmax: pointer + symbol** — pointer bytes PLUS the top hit's symbol body: read the
  top result's file, slice lines `[startLine .. endLine]` (fields exposed on the
  result: `r.startLine ?? r.generated_metadata?.start_line`, same for end —
  `mcp.ts:464-466`), `estTokens(slice)`. The top hit's symbol name is
  `defined_symbols[0]` (`mcp.ts:467,471`) if a label is wanted in output.

### PREPLAN CORRECTION (do not skip)
The earlier scope said "reuse `handleExtractSymbol`". **That is wrong** —
`handleExtractSymbol` (`mcp.ts:865`) is a NESTED, non-exported function bound to the
MCP handler's `searcher`/`graphBuilder`/`skeletonizer` closures; it cannot be
imported. Use the **line-range slice** above instead — it is what `extract_symbol`
fundamentally returns (the symbol's line span), and it has zero dependency on MCP
internals. `Searcher` and `formatMcpPointerSearchResults` ARE importable; the extract
handler is not.

### Estimator
`estTokens = (s: string) => Math.ceil(s.length / 4)` — mirror `mcp.ts:2216`. It's a
char/4 proxy, not a real tokenizer (graphify uses tiktoken). Fine here because BOTH
sides use the same estimator, so the ratio is largely estimator-invariant. Note the
caveat in output; don't reach for a tokenizer dep.

### Reporting
- Per-case rows + aggregate **median** ratio (ratios are skewed — median is the
  honest headline, not mean/max), plus p25/p75 and mean for context. Report both
  gmax variants (pointer, pointer+symbol).
- Dual-mode like `eval.ts`: `GMAX_EVAL_JSON=1`/`--json` → single JSON object on
  stdout, human preamble routed to stderr (`eval.ts:617-623` pattern).

### Honesty guardrails (the whole point)
- REJECT graphify's methodology: its "70×/100×" compares one query to reading the
  ENTIRE repo (`corpus_words = nodes*50`, `benchmark.py:113`) — no agent does that;
  it's inflated. The whole-file Read baseline is what an agent actually does.
- Single-file baseline under-counts → ratio is a conservative floor.
- Measure gmax's REAL rendered output bytes, not an idealized chunk.

### Preconditions / risks
- Needs an indexed store for cwd AND query-embedding available (MLX :8100 or ONNX
  fallback) — identical precondition to `eval.ts`; document it in the file header.
- `formatMcpPointerSearchResults` pulls `McpPointerFormatOptions`; passing only
  `{query}` uses defaults (minScore 0, no maxPerFile, no imports) — that's the right
  "discovery" rendering to measure.

### Expected outcome & effort — ACTUAL (2026-06-28)
Built as scoped: `src/eval-tokens.ts` + `bench:tokens`/`bench:tokens:json`, no
schema change, no new deps. Reused the exported `searchResult{Path,StartLine,EndLine}`
helpers in `commands/mcp.ts` (they already do the `r.startLine ?? generated_metadata`
nullish handling) rather than re-deriving the field access. Measured on the gmax
index (97 cases): **gmax pointer median 8.5×** (p25 3.0×, p75 17.9×, mean 12.3×);
**gmax pointer+symbol median 4.4×** (p25 1.6×, p75 8.6×, mean 5.4×). The
pointer+symbol median lands right on the advertised "~4× fewer tokens"
(`code_skeleton`, `mcp.ts:756`). Some small-file cases show pointer+symbol < 1×
(reading the 20-result pointer list + a full symbol body costs more than reading
one ~460-token file) — faithfully reported, not hidden; the median is the headline.

## Phase 2 — call-graph accuracy pass: implementation spec (preplanned 2026-06-28)

Hand-off-ready scope for items #4–#6. Verified against HEAD **v0.21.2 (`4b88e2d`)**
by three parallel source reads; the load-bearing claims (schema-migration mechanics,
the #4 design fork, the absent import resolver) re-verified by hand. **All line refs
are CURRENT** — the Phase-1 phantom-edge guard shifted `graph-builder.ts` numbers, so
older notes are stale.

### Shared mechanics — adding a list column + the CHUNKER_VERSION bump

Both #4-stronger and (optionally) #5 ride on adding a LanceDB list column. The
existing `type_referenced_symbols` is the exact template; mirror it across **6 layers**:

1. `chunker.ts`: `Chunk` interface field (~:55) · array decl + adder (~:633 / `addTypeRef`
   ~:655) · emit in `chunks.push` (~:1003) · filter in `scopeSymbolsToContent` (~:1099,
   else `{...chunk}` sub-chunk spreads fabricate phantom edges).
2. `types.ts`: `PreparedChunk` (:28) and `ChunkType` (:70).
3. `orchestrator.ts:238-259`: the **single** camel→snake mapping site (add a line ~:255).
   Downstream (`syncer`, `batch-processor`, `insertBatch`) is pass-through.
4. `vector-db.ts`: `buildSchema` (:371) · `seedRow` (:271) · `insertBatch` normalization
   (:512) · **and generalize `evolveSchema` (:389-407)**.
5. `config.ts`: bump `CHUNKER_VERSION` 3→4 (:61) + append a `CHUNKER_VERSION_HISTORY`
   entry (~:86). The constant must equal the highest `v`.

**⚠ TRAP (highest-risk gotcha): `evolveSchema`'s early-return at `vector-db.ts:392`**
(`if (fields.has("type_referenced_symbols")) return;`) short-circuits the *whole*
method — a table that already has `type_referenced_symbols` (i.e. every existing
index) would **never** get the new column added. Must be rewritten to check each
column independently and `addColumns` only the missing ones. Forgetting this silently
ships a half-migrated index.

**Migration story: a full rebuild is NOT required.** The column is nullable; for live
daemons `evolveSchema.addColumns` back-fills it in-place, existing rows read `[]` until
their file is reindexed (which is when real values populate anyway). Fresh tables get
it from `buildSchema`. Bulk back-fill happens via `gmax repair --rebuild`
(`daemon.ts:780` `repairRebuild` → `vectorDb.drop()` :805 → lazy recreate) /
`index --reset` / `doctor --fix`. v3 (the `type_referenced_symbols` add) is the precise
precedent.

### #4 — Member-call edges (biggest phantom-edge source)

**Cheap half — BUILTIN_CALLEES at edge time. NO schema change; ships independently
(even as a 0.21.x patch).** The denylist (`callsites.ts:100-259`, `isBuiltinCallee`
:262) is currently consulted **only at display** — `peek.ts:261`, `project.ts:120`,
`audit.ts:132` — so `trace`, MCP `peek_symbol`, MCP `trace_calls`, and BFS traversal
all still emit builtin callee edges (`.map`, `.get`, `forEach`). Callee edges are
materialized at exactly two points, neither filtered: `getCallees` return
(`graph-builder.ts:139`) and `buildGraph`'s `calleeNames` (`graph-builder.ts:184`,
sourced from `mapRowToNode` `calls: referencedSymbols` :483). Apply `isBuiltinCallee`
at those two points. ~10 lines.

**Stronger half — `member_referenced_symbols` column.** Follow the shared mechanics
above. **⚠ DESIGN FORK — get sign-off before coding:** `chunker.ts:780` pushes member
names into `referencedSymbols` *unconditionally* (both `obj.method()` and free
`method()` land in the same array). The member-detection fork already exists at
`:766-778` (`member_expression`/`attribute`) and `:787-797` (Swift/Kotlin
`navigation_expression`), so that's the natural place to record member-ness. Then:
- **Option (a) additive** — *also* push member names into a new column but keep them in
  `referencedSymbols`. Severity `"additive"`. **Does NOT fix the bug** — `getCallers`
  still unions the polluted `referenced_symbols`, so `getCallers("get")` still matches
  every `.get()`.
- **Option (b) split (RECOMMENDED)** — *move* member names OUT of `referencedSymbols`
  into `member_referenced_symbols`. This is what actually suppresses the phantom.
  Severity **`"breaking"`** (old indexes over-match until reindex; mirrors v2's
  sub-chunk-scoping rationale).

  Recall tradeoff to state honestly: member calls to genuinely-indexed methods
  (`this.helper()`) become invisible to plain `getCallers` until a receiver-type-aware
  resolver exists. That's acceptable here — this is the **precision** plan; recall is
  the sibling **agent-ux-proposals** plan's job, and the new column is exactly the
  substrate a later member-aware resolver would consume. **Do NOT union
  `member_referenced_symbols` into `getCallers` (`graph-builder.ts:98`)** — that
  re-introduces the phantom. Keep it separately queryable.

### #4-stronger — INVESTIGATION + measurement (preplanned 2026-06-28, post-v0.21.3)

Investigation pass before any code. Measured against the live gmax index **reindexed
under v0.21.3** — note this matters: the additive column (`62c5bf5`) only populates when
the *indexing binary* contains the code, and it did not ship globally until v0.21.3.
A measurement run against a pre-0.21.3 index sees an EMPTY member column (this is what
made the #5 free-axis numbers member-polluted — re-measure #5 after this reindex).

**No chunker bug — chained calls ARE captured.** `table.query().limit().where()` records
`query`/`limit`/`where` as members correctly (110/113/95 as-member vs 1/1/0 free-only).
The "chained-member detection gap" hypothesised in the #5 pass was a stale-binary
artifact, not a defect. **Drop that item from the #5 plan.** Additive invariant holds:
all 8,069 member names are also in `referenced_symbols` (0 orphaned).

**Mechanics are SMALL (the schema work is already done).** `62c5bf5` added the column
across all 6 layers. A plain split is then ~4 lines: at `chunker.ts:803-806` (and the
Swift/Kotlin twin :828-829) change `referencedSymbols.push(funcName); if(isMember)
addMemberRef(funcName)` → `if(isMember) addMemberRef(funcName); else
referencedSymbols.push(funcName)`. `scopeSymbolsToContent` already filters both columns
(:1128-1135). Plus `CHUNKER_VERSION` 4→5 (**"breaking"**) + reindex. The plumbing is
trivial; the RECALL CONSEQUENCE is the whole decision.

**MEASURED split recall cost (8,069 member edges = 13.2% of all 61k call edges):**
- builtin-only noise (good to drop): **3,814 (47.3%)**
- external/third-party, not indexed (phantom anyway): **1,478 (18.3%)**
- builtin-name that is ALSO a project def (receiver-hard, genuinely ambiguous): **509 (6.3%)**
- "distinctive" = name matches a project def, non-builtin: **2,268 (28.1%)** — BUT this
  bucket is ~half **external-method-name collisions** (`log` 251, `error` 180, `limit`
  113, `query` 110, `where` 95, `select` 94, `toArray` 113, `close` 87 ≈ 1,100, all
  external/builder methods whose name merely collides with a project symbol) and ~half
  **genuine `this.method()`/`db.ensureTable()` calls** (`ensureTable` 99, `dispatch`,
  `watchProject`, `shutdown`, `withProjectLock`, `encodeQuery`, `optimize`, `destroy`,
  `resetActivity` … ≈ **1,100**).

**⇒ A plain split removes ~5,300 noise edges (the win) but ALSO silences ~1,100 genuine
project-method caller edges (~15% of member edges, ~1.9% of all edges).** That is a
real, user-visible recall cliff: `trace ensureTable --inbound` loses its 99 member
callers. Name-blind classification cannot separate the ~1,100 keepers from the ~1,100
colliders — both are "member call whose name matches a project def."

**⚠ REFRAMED FORK — the decision is NOT additive-vs-split (plain split is now shown
costly); it is HOW to suppress member phantoms without the recall cliff:**

- **(A) Plain split (the plan's literal option b).** Move all members out; `getCallers`
  sees free-only. Max precision, but eats the ~1,100-edge recall cliff until a
  receiver-aware resolver exists. **#5 does NOT provide that** — #5 is the same-name-def
  axis (which file?), orthogonal to the receiver axis (which object's method?). So "ship
  the split, #5 fixes recall later" is **false**; nothing on the roadmap restores it.
- **(B) RECOMMENDED — query-time precision pass, keep additive, defer the move.** Two
  cheap, no-reindex, no-CHUNKER-bump moves using the column already shipped: (1) extend
  the #4-cheap builtin suppression (already on the *callee* side, `8087e1c`) to the
  **caller** side — drop `getCallers`/`buildGraph` matches that are member calls to a
  BUILTIN name (removes the 47.3% builtin-member noise with zero recall loss); (2) pull
  **#6 forward as a confidence signal** — rank free-call callers above member-call
  callers in `trace`/`peek` so receiver-hard guesses read as low-confidence, not facts.
  Captures most of the precision win, no recall cliff, no breaking reindex.
- **(C) Receiver-type-aware split (the "right" but heavy path).** Infer the receiver's
  type so `db.ensureTable()` is kept and `arr.limit()` dropped. Correct, but needs
  variable-type tracking the tree-sitter chunker deliberately lacks — out of scope for a
  zero-config tool. Note it; don't build it now.

**Recommendation: do (B), NOT the plain split.** The measurement turns the plan's
"acceptable recall tradeoff" claim into a quantified ~1,100-edge regression with no
roadmap item to recover it. (B) banks the bulk of the precision (the 65.6% builtin+
external noise) at zero recall cost and leaves the additive column as the substrate for
a future (C). Re-measure #5 on the freshly-reindexed (member-populated) corpus before
sizing it — the prior #5 numbers were inflated by member noise the empty column failed
to exclude.

**Honesty guardrail:** never present the plain-split precision gain without the ~1,100-
edge recall cost beside it (`eval-graph-*` before/after). The split LOOKS like pure
precision; it is a 5:1 precision:recall trade, and the recall half is genuine method calls.

### #5 — Import-evidence disambiguation (biggest accuracy lever; biggest cost)

**⚠ DECISIVE finding — the plan's "needs structured imports first" is confirmed and is
*most* of the work: NO structured import parser AND NO module-specifier→file-path
resolver exist anywhere in the repo.** Both are net-new. Grep for
`resolveModule|moduleSpecifier|import_specifier|named_imports|tsconfig paths` → zero
resolver. Every `path.resolve` in the tree resolves CLI/project roots, never an import
specifier against a caller dir.

Supporting facts:
- The `imports` schema column exists (`vector-db.ts:372`) but is **always written `[]`**
  — `orchestrator.toPreparedChunks` (:238-259) omits it, defaulted at `vector-db.ts:513`.
  A dead column.
- The chunker DOES capture raw import statement text per file (`chunker.ts:559`,
  `FileMetadata.imports`) but **drops it before persistence** (folds it into embedded
  display text only).
- `extractImports` (`import-extractor.ts`) returns a **raw text blob** by re-reading the
  file; used only for display splicing (`mcp.ts:438`).
- `resolveLocation` (`graph-builder.ts:393-418`) already has the 25-candidate fetch +
  pick-or-fallback skeleton, but takes **no caller context** → a caller-file path must
  be threaded through its **4 call sites**: `callersOf` (:328), `getNeighbors` origin
  (:367) + per-hop (:371), and `risk.ts:107`.

**Build:** (1) a structured import parser → `{importedName → moduleSpecifier}` for a
caller file; (2) a specifier→absolute-path resolver (relative-join + index/extension
resolution; tsconfig `paths`/barrels later); (3) glue in `resolveLocation`:
intersect the imported source with the candidate definition files, and **return `null`
(skip) when import evidence exists but matches no candidate** — skipping rather than
guessing IS the accuracy win.

**Delivery — two options:**
- **(A) query-time, NO schema change (RECOMMENDED for v1):** parse via
  `extractImports(callerPath)` re-read, cache per file (like `mcp.ts` `importCache`).
  Only runs when `rows.length > 1` (genuinely ambiguous) — the common 1-candidate case
  pays nothing, so cost is bounded.
- **(B) populate the dead `imports` column** with structured data at chunk time — a
  perf optimization that avoids re-reads but needs the shared schema migration. Defer.

Start the resolver conservative: relative + index/ext only; **skip on anything
unresolvable** (path aliases, barrels, cross-language import semantics). Wrong > missing
is the failure mode to avoid.

### #5 — INVESTIGATION + measurement (preplanned 2026-06-28, post-`62c5bf5`)

Investigation pass before any code (reo paces). Line refs re-verified at HEAD; the
lever was **measured** by dry-running a prototype resolver over the live gmax index.
⚠ The first run (numbers in this section) hit an index whose `member_referenced_symbols`
was still EMPTY (stale indexing binary) — see "#5 RE-MEASURED on the CLEAN index" below
for the corrected, much smaller figures and the revised "do not build" recommendation.
Throwaway tsx scripts, reverted.

**Line refs corrected at HEAD** (Phase-1 + #4 shifted them again):
- `resolveLocation` → `graph-builder.ts:403` (was ~:393); already does a 25-candidate
  fetch when `anchorFamily` is set (`.limit(anchorFamily ? 25 : 1)` :415).
- `callersOf` :334 · `getNeighbors` origin :373 / per-hop :377 · `risk.ts` is
  **`src/lib/review/risk.ts:107`**.
- `buildGraph`'s callee loop with the arbitrary `.limit(1)` is at **:187–205**.
- `imports` column still dead: `metadata.imports` IS attached to the intermediate
  chunk at `orchestrator.ts:218`, but **dropped** in `toPreparedChunks` (:238–260 has
  no `imports` field) → persisted as `[]`. Confirmed.
- `extractImports` (`import-extractor.ts`) is a raw-text blob and **`break`s at the
  first non-import line** (top-of-file only). Fine for JS/TS; means (B) chunk-time
  capture buys nothing over a query-time re-read.

**MEASURED lever (gmax: 3103 chunks, 61,173 call edges):**
- Builtins are **49%** of all call edges (the display denylist's scope).
- Raw "ambiguous within family" across all `referenced_symbols`: **17.4%** of edges /
  **48.5%** of *resolvable* edges. But this is dominated by **member calls + builtins**
  (`log`, `get`, `.limit`, `.where`, `.select`, `.toArray`, `.query`, chalk `.bold/.dim`)
  — the **member axis (#4)**, which import evidence **cannot** touch. The 48% is a
  mirage; do not cite it as #5's lever.
- After excluding members + builtins + **self-file** definitions, the genuinely
  ambiguous *free-function* edges #5 faces = **7,425** (~12% of all edges).
- **#5 resolver DRY-RUN** on those 7,425 (relative-only import parse, per-file cached):
  - **NARROWABLE** (imports collapse to exactly 1 candidate) → #5 draws the right edge:
    **585 (7.9%)**; high-confidence subset where the import *names the symbol*: **205 (2.8%)**.
  - **SKIPPABLE** (import evidence exists, matches **no** candidate) → #5 skips:
    **4,784 (64.4%)**. This is the "wrong > missing" feature firing — but most are
    member-call noise (`.limit`/`.where`/`.select`) that the **#4-stronger split would
    remove upstream** before #5 ever sees them.
  - **BLIND** (no relative import evidence) → #5 can't help: **2,056 (27.7%)**.
- A cheap **prefer-self-file** rule resolves **2,025** ambiguous edges for free (no parser).

**Three corrections to the plan's #5 framing (load-bearing):**
1. **The `resolveLocation` "4 call sites" are the wrong target.** `callersOf` and
   `getNeighbors`-origin call `resolveLocation(symbol)` to find the **queried symbol's
   OWN** location (to anchor its language family) — there is **no caller file** to
   disambiguate by. #5 is fundamentally an **OUTBOUND/callee** feature: given "file F
   calls name N", which *definition* of N? That context exists at **`buildGraph`'s
   callee loop (:187–205)** and `getCallees`, where the caller file = `center.file` is
   known. That loop's `.limit(1)` is the real arbitrary-pick #5 should replace. The
   multi-hop callee BFS (`getNeighbors` :377) would also benefit but needs
   `bfsNeighbors` to thread the referencing file — defer that plumbing.
2. **`member_referenced_symbols` is dormant/empty until reindex** (additive option (a),
   `62c5bf5`). Member-call names still sit in `referenced_symbols`, inflating both the
   ambiguity and the skip bucket. The split (#4-stronger option (b)) — plus a chunker
   fix for **chained** member calls (`table.query().limit().where()`, which the current
   `member_expression`/`attribute` detection misses) — should land **before** #5 so the
   resolver faces a clean residual.
3. **#5's positive lever is small (~205–585 edges, <1% of all edges); its value is
   mostly the SKIP.** And the skip mostly overlaps with what #4's split removes upstream.
   So #5 is **not** independently the "biggest accuracy lever" the header claims — it is
   the *last* precision fix, gated on #4-stronger, with a modest standalone win.

**FORK SETTLED → (A) query-time, no schema change.** The dry-run parsed every caller
file's imports across the whole repo in <1s (per-file cached, only runs when
`rows.length > 1`). (B) populating the dead column buys nothing measurable and costs a
migration — **deferred indefinitely**, not "later".

**Recommended build order — SUPERSEDED 2026-06-29** (kept for provenance; see the clean
re-measurement above and the #4-stronger investigation):
1. **Prefer-self-file** — ✅ DONE, shipped v0.21.3 (`0d06d9e`).
2. **#4-stronger** — investigation says do **(B) query-time precision pass**, NOT the
   plain split (the split's recall cost is ~1,100 genuine method edges). The "chained-
   member chunker fix" was a stale-binary mirage — there is no such bug.
3. **#5** — clean re-measurement says **do not build the net-new resolver** (~181
   occurrences, one symbol dominating). Fold a minimal imported-name check into
   prefer-self only if the `log`-class case ever matters.

**Honesty guardrail reaffirmed:** never cite the 48% raw-ambiguity figure as #5's lever
— it is member/builtin noise. #5's defensible claim is "skips ~Nk phantom callee edges
and correctly resolves ~200 genuine same-name imports," measured *after* #4 lands.

#### #5 RE-MEASURED on the CLEAN (member-populated) index — 2026-06-29

⚠ The numbers above were computed against an index whose `member_referenced_symbols`
column was **empty** (the indexing binary predated `62c5bf5` until v0.21.3), so member
calls were NOT excluded — they inflated every "free-axis" figure. Re-ran the identical
dry-run after reindexing under v0.21.3 (column populated). The picture collapses:

- member calls are **68.97%** of all referenced-symbol occurrences (were silently 0%);
  builtins another 10.26%. (Note: `referenced_symbols` is **not deduped** at the call
  site `chunker.ts:803`, so these are occurrence counts, not distinct edges — distinct
  counts are smaller still, which only *strengthens* the conclusion below.)
- **AMBIGUOUS free edges facing #5: 1,250 — just 2.04% of all edges** (was 7,425).
  - NARROWABLE (import → 1 candidate): **192 (15.4%)**; named-exact: **181**.
  - SKIPPABLE: 704 (56.3%). BLIND: 354 (28.3%).
- **#5 high-confidence WINS = 181 occurrences = 0.30% of all edges — and ~80% of those
  are a SINGLE symbol (`log` 154, the logger import).** Strip `log` and #5 correctly
  resolves a few dozen distinct call sites across the whole repo.
- The SKIPPABLE bucket is now dominated by local-helper name collisions (`rel` 536,
  `onProgress`, `listProjects`) — #5 correctly skipping them is right, but it's
  preventing phantoms, not adding signal, and overlaps with prefer-self + #4 handling.

**REVISED #5 recommendation → DO NOT build the net-new import parser/resolver.** On clean
data the yield is ~181 occurrences (≈ a few dozen distinct sites, one symbol dominating)
for the ~2–3 day net-new parser + specifier→path resolver — a poor effort:value trade.
The *skip-not-guess* value (the genuinely good part) is largely already delivered by
prefer-self (`0d06d9e`) + #4's builtin/member handling. If the `log`-class case ever
matters, fold a **minimal** "imported-name → prefer that file" check into the existing
prefer-self resolver (a few lines, query-time, no parser) rather than a general resolver.
Re-open #5 only if a future, larger/more-polyglot corpus shows the free-ambiguity rate
climbing well above 2%.

### #6 — Confidence tiers (presentation; depends on #4/#5; do last)

No edge provenance exists anywhere (the only `confidence` is search-result scoring,
`searcher.ts:1051`, unrelated). `GraphNode` (`graph-builder.ts:20-28`) is built in **one
place** — `mapRowToNode` (:478-486) — so add `confidence?: "EXTRACTED" | "INFERRED"`
there. **Signal source:** the `referenced_symbols` (call-position = EXTRACTED) vs
`type_referenced_symbols` (type-position = INFERRED) split, unioned and *lost* at
`getCallers` (:98). **NOTE:** `getCallers`'s SELECT (`:87-95`) does **not** currently
fetch `type_referenced_symbols` — add it so the tag can be derived from which list
matched (with #4-stronger landed, that's a 3-tier signal). No rank sort exists anywhere
— callers come back in raw `.limit(100)` scan order then sliced; inject a stable
confidence-sort before the `.slice(0, N)` caps in `peek` (`MAX_CALLERS`), `trace`'s tree
walk, and MCP `handlePeekSymbol`/`handleDead`/`handleTraceCalls`.

**STATUS 2026-06-29: (B) SHIPPED** (`af1c4a0` + `0942a68`). `getCallers` now tags
caller edges (free→EXTRACTED, member/type→INFERRED), stable-sorts free first, and
suppresses builtin-named member callers. Peek, trace, and MCP now surface the edge-kind
tag visually, so receiver-hard guesses no longer read as equally factual. This resolves
#4-stronger via (B), not the shelved plain split, and completes #6.

### (B) precision unit — INVESTIGATION + measurement (preplanned 2026-06-29)

After the #4-stronger + clean-#5 measurements deflated the plain-split and the import
resolver, **#6 + caller-side builtin-member suppression** is the high-value residue of
the whole accuracy pass. This is the (B) path. Investigation = measurement + site map;
no code (reo is mid-refactor in `graph-builder.ts` — see coordination note).

**⚠ COORDINATION:** reo is actively editing `graph-builder.ts` (added a `GraphDefinition`
interface `{file,line,family,isExported}` and a prefer-self→prefer-family fallback in the
callee loop). The two graph-builder edits (B) needs — `GraphNode.confidence` + widening
`getCallers`'s SELECT — overlap that refactor. Land them WITH reo's change, not against it.

**MEASURED #6 lever (the reason to do this):** of caller edges whose target is a
project-defined symbol (real trace targets), **~50% are member calls** `x.T()`:
- occurrence-weighted: 22,056 edges → free `T()` **49.8%** vs member `x.T()` **50.2%**.
- distinct `(callerFile,target)`: 2,110 → member **40.9%**.
- of member edges: **19.2% are builtin-named** (suppressible noise), 80.8% distinctive
  (keep, but mark low-confidence).

So #6 re-ranks/tags **~half** of all caller edges — and the consumer caps amplify it:
`peek` shows only `MAX_CALLERS = 5` (`peek.ts:26`, sliced :304 + :367), MCP caps at
`maxCallers` (`mcp.ts:1081`). Half the callers are member calls in **arbitrary scan
order** today, so a free-first sort changes *which 5 you see*. Zero recall cost (rank +
tag, never remove). This is a bigger, safer win than #5 (2% of edges) or the #4 split.

**Two parts:**
- **(B)(1) caller-side builtin-member suppression.** `8087e1c` suppressed builtin
  *callee* edges (outbound) but `getCallers` (inbound) still emits them. Drop caller
  matches that are member calls to a BUILTIN name. Removes 2,130 occ / **155 distinct**
  pure-noise edges, zero recall loss. Tiny; mostly matters when a traced symbol shares a
  builtin name.
- **(B)(2) = #6 confidence tiers (the main event).** 3-tier signal per caller edge:
  - free call (`T ∈ referenced_symbols`, `T ∉ member_referenced_symbols`) → **EXTRACTED** (high)
  - member call (`T ∈ member_referenced_symbols`) → **INFERRED-member** (low)
  - type-position only (`T ∈ type_referenced_symbols`) → **INFERRED-type** (lowest)

**Site map (re-verify at code time; graph-builder lines drift under reo's edits):**
1. `GraphNode` gains `confidence?: "EXTRACTED" | "INFERRED"` (+ maybe a sub-reason).
   Built in ONE place — `mapRowToNode` — which must learn which list matched (pass the
   member/type membership of `targetSymbol`).
2. `getCallers`'s SELECT must add `member_referenced_symbols` **and**
   `type_referenced_symbols` (it currently fetches neither) so the tier is derivable.
3. Stable confidence-sort (EXTRACTED → INFERRED-member → INFERRED-type, then existing
   order) before the caps: `peek.ts` `MAX_CALLERS` slices (:304, :367), `trace.ts`'s
   caller-collapse walk (the `walkCallers`/`buildInboundTree` dedupe ~:57-90/:121-140),
   and MCP `handlePeekSymbol` (:1081) / `handleTraceCalls` (:768) / `handleDead`.
4. (B)(1): in `getCallers`, drop rows where the match is member-only AND
   `isBuiltinCallee(symbol)` — but only when the symbol isn't *also* a free call elsewhere.

**Effort:** (B)(1) ~¼ day; #6 ~½–1 day. No `CHUNKER_VERSION` bump, no schema change, no
reindex — purely query-time + a SELECT widening. The additive member column shipped in
`62c5bf5` is the substrate; (B) is its first real consumer.

**Honesty guardrail:** #6 is presentation — it must not silently DROP edges (except the
(B)(1) builtin-member ones). A de-ranked member edge is still reachable; never let the
confidence sort hide a real edge below the cap without a "+N more" affordance (peek
already prints `... N more`).

### Ordering, effort & release shape

- **Phase 1:** shipped.
- **Phase 2:** shipped or explicitly rejected by measurement. #4-cheap, the additive member
  substrate, prefer-self/same-family resolution, query-time precision path, and #6 confidence
  presentation are done. The plain member split and general #5 import resolver are not build
  targets without new evidence.
- **Next:** Phase 3 orientation. Prefer file-level import-cycle detection in `gmax audit` as
  the first concrete item; it is deterministic, read-only, and slots into an existing command.

### Honesty guardrails

- #4-stronger's precision gain has a measurable **recall cost** (member→indexed-method
  edges leave plain `getCallers`). Measure both with the `eval-graph-*` harnesses
  before/after; never claim precision without reporting recall.
- #5 must **skip, not guess** — an edge presented as fact that's wrong is worse than a
  missing one. The skip path is the feature.
- Re-verify `mapRowToNode`/`getCallers` line numbers at implementation time: this spec
  was cut at v0.21.2 and any intervening edit shifts them.

## Provenance

Derived 2026-06-28 from a YouTube walkthrough (ChskqGovoHg) + a clone of
safishamsi/graphify @ v0.9.1. Three general-purpose agents produced subsystem
reports (extraction/graph, incremental/caching, query/analysis); full reports were
in the session task outputs. Verification of the call-graph claims was done by hand
against gmax HEAD before this plan was written.
