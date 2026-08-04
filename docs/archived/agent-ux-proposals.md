---
type: plan
status: archived
created: 2026-05-07
updated: 2026-08-04T11:07:45Z
surfaces:
  - search
  - cli
  - mcp
audience: internal
related_docs:
  - ../known-limitations.md
  - ../agent-pov-suggestions.md
related_plans:
  - ../plans/2026-05-25-semantic-search-landscape.md
  - graphify-derived-improvements.md
  - ../plans/embedding-reembed-atomic-cutover.md
  - 2026-06-23-index-versioning-and-daemon-refactor.md
  - 2026-06-28-repo-audit-hardening.md
current_state: >
  All scoped Agent UX work is shipped. Phase 7 impact rollups shipped in `a71c616`, Phase 9
  SQL-template skeleton summaries shipped in `504c055`, and Phase 12's daemon managers and
  search-output extraction shipped in `79f12d7` and `fbb8396`. Remaining ideas are
  measure-first reopen triggers, not an active backlog.
next_step: >
  None. Reopen only for a measured recall or repeat-latency gap, a selected replacement
  embedding model, or concrete DSL corpus failures.
summary: Living plan for agent-UX backlog after the v0.16.x dogfooding pass. Phases capture the open P3/P4 catalog items plus the small refactors that surfaced during dogfooding in `~/Development/beyond/platform`. Most phases are independent and small; the design-project ones (`gmax impact <file>`, code/docs split) are flagged.
---

# gmax — Agent UX Backlog

> v0.16.0 → v0.16.5 shipped Phase 0–5. v0.17.4 shipped the first agent-facing followups from later dogfooding: deterministic path context and CLI/MCP pointer-format parity. The P0–P5 catalog (preserved below as supporting detail) named items as "live work, not historical filler" — this plan re-surfaces them as phases so they show in `dotmd actionable`.

## Next Step

NEXT TIER EXHAUSTED. Every scoped item is shipped or measure-first-deferred. Phase 12's
manager and search-output extractions are also complete; no opportunistic refactor remains
owned by this plan.

## Problem

Two rounds of empirical dogfooding in `~/Development/beyond/platform` in May 2026 produced a backlog of agent-UX wins and feature-gap fills. v0.16.0–v0.16.5 shipped the Phase 0–5 items (P0–P2 categories cleared, plus SessionStart hint restructure). v0.17.4 followed with deterministic `gmax context <path>` and shared CLI/MCP pointer-mode search formatting after a fresh agent POV sweep. The remaining P3/P4 items + the small refactors haven't been expressed as a tracked plan, so they've been invisible to `dotmd context`.

## Goals

- Each remaining P3/P4 item from the dogfooding catalog has a phase entry with shape-of-work and (where relevant) measurement plan.
- Internal-refactor opportunities (search.ts / daemon.ts splits, dedicated query-only worker) surface alongside feature work rather than getting lost.
- The full P0–P5 catalog detail stays accessible as background for future sessions.

## Non-Goals

- **`gmax callers <symbol>` as a standalone command.** `gmax trace --inbound` covers this; the standalone is redundant. Skip unless a UX argument lands.
- **`skeleton <project-name>` → "all top-level files."** Feature creep — refuse and hint, which the current `skeleton <dir>` clean-refusal already does.
- **Fuzzy/prefix matching for `gmax remove`.** False-positives on destructive actions are bad.
- **Fuzzy match for typos** on `Symbol not found: X`. Real risk of confidently-wrong suggestions.

## What Exists Today

| Release | Theme | Highlights |
|---------|-------|-----------|
| v0.16.0 | ship-already-in-tree | Corruption detection + maintenance hygiene, perf hot path, daemon-mediated search, FSEvents poll-mode auto-recovery |
| v0.16.1 | UX footguns + small wins | `remove <name>` resolution, `skeleton <dir>` clean refusal, peek/extract cross-language disambiguation, search `--agent` relevance scores, exported-`const` indexing, role-tag legend in SessionStart hint |
| v0.16.2 (keystone) | monorepo scoping | `--root <name>` resolves registry names; `--in <subpath>` / `--exclude <subpath>` threaded through `search`/`peek`/`extract`/`trace`/`impact`/`similar`/`test-find`/`related` |
| v0.16.3 | log surface | `gmax log <path-or-symbol>` (git-log-style); `recent` and `diff` deprecated with forwarding hint |
| v0.16.4 | capability fills | peek/extract tests footer default-on, `gmax test` import-fallback (`via-import` label), `gmax related` basename-mention fallback, file-level grouping in `search --agent`, `gmax trace --inbound` with call-site snippets |
| v0.16.5 | hint restructure | SessionStart hint grouped by use-case; `--in`/`--exclude`/`--root <name>`/`gmax log`/`trace --inbound` surfaced; `Bash(...)` wrapping dropped |
| v0.17.4 | agent context/output parity | `gmax context <path>` gives deterministic file/dir context; CLI local/server search and MCP pointer-mode `semantic_search` share the same agent formatter |

Phase 0–5 checklist (all shipped): v0.16.0 cut → v0.16.1 footguns → v0.16.2 monorepo keystone → v0.16.3 `gmax log` → v0.16.4 capability fills → v0.16.5 hint restructure → README + CLAUDE.md + known-limitations.md updated. Agent followup: v0.17.4 deterministic path context + CLI/MCP pointer-format parity.

---

## Relevance Review — 2026-06-03 (v0.17.18)

Full relevance pass run after the `semantic-search-landscape` plan closed (its bench-moving backlog is exhausted). Every phase below re-verified against current code; verdicts here, original phase bodies preserved as detail with inline status tags.

### Closed — shipped or obsolete
- **Phase 7 headline — `impact <file>` — ✅ DONE.** File-path acceptance already shipped: `impact.ts:16` takes `<symbol or file path>`; `lib/graph/impact.ts:33-57` resolves a file to its `defined_symbols`. The doc's "today it takes a symbol" framing is obsolete. Only the design-project rollup polish (per-export, package grouping, top-K sampling, test-exclude flag, SDL-awareness) remains → moved to **Later**.
- **Phase 13 — dedicated query-only worker — ❌ OBSOLETE.** Superseded by startup prewarm (`daemon.ts:316-350`, two warmup `encodeQuery`s) + priority dispatch (`pool.ts:180-188`, query/rerank jump the indexing backlog). A dedicated worker re-adds the ~300MB–1GB resident the team deliberately cut to `MIN_KEEP_WORKERS = 1` (`pool.ts:168`). **Closed.**

### Relevance increased
- **Phase 10 — call-graph distance reranking — ⬆️ UNBLOCKED.** Its sole stated blocker ("MCP/agent-context auto-passes an anchor — same blocker as landscape Phase 4") shipped as the seed protocol in v0.17.17: MCP `seed_files`/`seed_symbols` + CLI `--seed-file`/`--seed-symbol` flow into `searcher.ts:437,454`. The graph primitive already returns hop distance (`graph-builder.ts:286-302` `getNeighbors`). It is **distinct from** seeding (membership match vs. graph proximity — seeding structurally can't boost a chunk two call-hops from the anchor with no symbol overlap) and can reuse seeding's proven relevance-gated RRF-bump pattern. **Needs a premise check first** (does graph-distance move agent-relevant results given bench is at ceiling?) before building.

### Low-value recall plays — defer, measure before building
`bench:oss` is near-ceiling (express 0.889 / lodash 0.900 / platform 1.000), so recall-axis features have little demonstrable headroom; the plan's own 2026-05-07 decision log already demoted HyDE/expansion for the same reason.
- **Phase 1 — HyDE** — 🟡 infra ready (`llm/server.ts`), zero recall-headroom signal. Hold until a held-out fixture set with real recall gaps exists.
- **Phase 2 — static query expansion** — 🟡 genuinely distinct from seeding, cheaper than HyDE (no LLM in hot path), but same no-signal problem.
- **Phase 5 — semantic result cache** — 🟡 cold-cost framing overstated; prewarm + priority queue already mitigate. Build only if rerank-on-repeat latency is measured as real pain.
- **Phase 8 — code/docs split** — 🟡 the heavy doc-indexing pipeline is unjustified; interim `GMAX_DOC_PENALTY` knob covers the practical need. Reduced to the **S2** cleanup.
- **Phase 11 — embedding model versioning** — ⏸️ speculative; no better-model trigger in flight. Defer until a model upgrade is actually on the table.

### Side Issues — fix regardless of phase priority
- **S1 — MIN_KEEP doc drift.** CLAUDE.md (Worker pool section) and the `daemon.ts:322` prewarm comment both claim workers keep "min 2 alive"; the code is `MIN_KEEP_WORKERS = 1` (`pool.ts:168`). Fix both comments to match.
- **S2 — `GMAX_DOC_PENALTY` half-wired.** The env var tunes only the path-extension penalty (`searcher.ts:364`); the role-based `DOCS *= 0.6` (`searcher.ts:341`) is a separate hardcoded penalty it doesn't touch, so a doc-role `.md` chunk gets stacked, partly-untunable penalties. Unify both branches under the env var (this *is* the surviving useful slice of Phase 8).
- **S3 — stale references in this doc.** Phase 8 cited `searcher.ts:278-305` → now `340-367`; Phase 12 cited `search.ts ~675` → now **1292** and `daemon.ts ~1500` → now **1623**. Fixed inline below.

## Execution Sequence — chug order

Stable phase IDs preserved (don't renumber — other docs reference them); this is the order to work them.

**Now — quick wins, low risk: ✅ ALL SHIPPED v0.17.19 (2026-06-03)**
1. ✅ **S1 + S2 + S3 side-issue sweep** (46ea324) — MIN_KEEP comments corrected (CLAUDE.md + `daemon.ts:322`), `GMAX_DOC_PENALTY` unified into one env-tunable penalty applied once (`searcher.ts`), stale doc refs fixed. Bench-neutral.
2. ✅ **Phase 3b — `gmax help-agent`** (a44f9dc) — `src/commands/help-agent.ts` + canonical `src/lib/help/agent-cheatsheet.ts`; the SessionStart hook now require()s the compiled module from the installed package (inline fallback retained). +test.
3. ✅ **Phase 3a + 3c — not-found + agent recovery** (be2b971) — scoped to Surface B (not-found/empty), merged 3c. New `src/lib/utils/agent-errors.ts` (`symbolNotFoundLines`/`fileNotFoundLines`) wired into peek/extract/trace/dead/impact/similar/related: human keeps the rich block (now unified), agent gets a compact `next:` recovery line. Catch-block hard failures intentionally left alone. +7 tests. (Original idea of touching every catch block was descoped — Surface A is arbitrary exceptions where a canned hint is noise.)

**Next — medium, scoped features:**
5. ✅ **Phase 6 — cross-project search** (`--all-projects` / `--projects <list>`) — SHIPPED 2026-06-03. Multi-prefix LanceDB scoping (reused `project_roots` filter) + per-project output grouping (`src/lib/utils/cross-project.ts`). See Phase 6 body.
6. ✅ **Phase 4 — token-aware `--budget`** — SHIPPED 2026-06-03. Premise check reshaped it: the win was knapsack-continue budget packing (greedy `break` wasted ~40% of budget), not a density reorder. `src/lib/utils/budget-pack.ts` + wiring in search.ts/context.ts. See Phase 4 body.
7. ⏸️ **Phase 10 — call-graph distance rerank** — PREMISE CHECK RAN 2026-06-03 → **DEFER, do not build.** Graph density patchy, seeding already 9/9 on anchor cases, the distinct mechanism is relevance-gate-neutered or noise-prone, and structural proximity is already served by trace/peek/impact. Measure-first (fixture class) if ever revisited. See Phase 10 body. Moved to Deferred.

**Later — design projects / larger / opportunistic:**
8. ✅ **Phase 7 polish — `impact` rollup** — implemented 2026-07-01: per-export / package-grouped / top-K sampled dependent and test presentation, preserving existing flat output compatibility.
9. ✅ **Phase 9 — template-literal DSL skeletons** — implemented 2026-07-01 as the narrowed SQL-template skeleton summary MVP. Do not build the full GraphQL/SQL/CSS parser without new evidence.
10. ✅ **Phase 12 — search.ts / daemon.ts refactor splits** — SHIPPED. Search acquisition/output
    and daemon search handling were extracted first; watcher, MLX, and process managers followed
    in `79f12d7`, with search output finalized in `fbb8396`.

**Deferred / measure-first:** Phase 1 (HyDE), Phase 2 (query expansion), Phase 5 (semantic cache), Phase 8 heavy pipeline, Phase 11 (embedding versioning), **Phase 10 (call-graph distance rerank — premise check ran 2026-06-03, value not there; fixture-first if revisited)**.
**Closed:** Phase 7 headline (shipped v-prior), Phase 13 (obsolete).
**Shipped this pass:** Phase 6 (cross-project, v0.17.20), Phase 4 (token-aware `--budget`, v0.17.21).

With Phase 10 deferred and Phases 7/9/12 shipped, every scoped feature is complete or
measure-first-deferred.

---

## Phases

### Phase 1 — HyDE opt-in (P4 #9) ⬜

**Why.** Instead of embedding the user's terse query directly, prompt the local LLM to synthesize 1–3 plausible *code documents* that would answer the query, embed those, retrieve neighbors. Reported 15–25% recall lift in Phind / Sourcegraph experiments.

**Shape of work.**
- `--hyde` flag on `gmax search` (and corresponding MCP option).
- Reuse the local llama-server pipeline already running for `review`/`summarize` (`src/lib/llm/server.ts`).
- Latency cost ≈ one local LLM generation per query; gate behind the flag until measured.

**Measurement.** Sweep against the 4-fixture eval instrument (`pnpm bench:oss`). Promote to default only if recall@10 wins on a held-out set assembled from real agent traces.

**Caveat from dogfooding.** Friction observed in May 2026 wasn't recall-shaped — most search misses were monorepo-scoping issues (resolved by `--in`/`--exclude`). HyDE may not be the right next bet on the recall axis; measurement decides.

### Phase 2 — Static query expansion (P4 #10) ⬜

**Why.** Pre-process the query into 2–3 reformulations (synonyms, different phrasings, AST-aware variants), run all variants through retrieval, fuse with RRF. Reported 10–20% recall lift, very cheap (no LLM in hot path).

**Shape of work.**
- Static synonym map as a JSON file (`"auth" → ["authentication", "login", "jwt", "session"]`, `"error handling" → ["exception", "try-catch", "errback", "failure"]`).
- RRF-fuse the variants in `src/lib/search/searcher.ts`.
- `--expand-llm` follow-up if static map is insufficient.

**Independent of Phase 1.**

### Phase 3 — Small UX polish bundle (P3 #6, #7, #8) ✅ SHIPPED v0.17.19 (2026-06-03)

**Status:** all three shipped. #7 (`gmax help-agent`) = commit a44f9dc; #6 (agent recovery `next:` line) + #8 (unified empty/not-found) = commit be2b971, scoped to the not-found/empty surface via `src/lib/utils/agent-errors.ts`.

**Why.** Three small items that don't justify their own phase but should ship together when the relevant files are touched.

**Items.**
- **P3 #6 — Trailing `next:` line on `--agent` errors.** Formatter helper every command's error path runs through, so agents always get a recovery suggestion. Risk: noise on errors with no good next step.
- **P3 #7 — `gmax help-agent` cheatsheet.** Prints the same content as the SessionStart hint but on demand, so a session that has compacted away the original injection can re-summon it.
- **P3 #8 — Unified empty-result style.** Currently varies per command. `search` from non-project cwd is the gold standard (`This project hasn't been added... Run: gmax add /private/tmp`). Generalize to every command's empty/error path.

### Phase 4 — Token-aware filtering for `--budget` (P4 #15) ✅ SHIPPED

**Status (2026-06-03):** shipped, after a premise check **reshaped** it. The proposed "bits-per-token reorder" turned out to be the wrong primitive — the demonstrable inefficiency is the greedy `break`, not relevance mis-ranking. Concrete case (`gmax "...worker pool dispatch..." --context-for-llm --budget 1500`): old code emitted **2 results / 880 tokens (59% of budget)** because the 3rd chunk busted the budget by ~14 tokens and `break` aborted the whole loop, stranding smaller still-relevant chunks below it. A full density *reorder* would mostly just bury the most-relevant chunk (for function-sized tree-sitter chunks the "one giant chunk hogs budget" pathology is rare), so it was rejected.

**What shipped.** New `src/lib/utils/budget-pack.ts` `packByBudget(candidates, budget, opts)`: knapsack-style greedy fill (skip an oversized chunk, keep filling with smaller ones) + a *conservative* density tiebreaker that only reorders chunks whose scores are within `tieEpsilon` (0.02) — so it never buries a clearly-more-relevant chunk. Selected items return in relevance order (packing is selection, not presentation); `atLeastOne` preserves "you always get the top hit." Wired into `gmax search --context-for-llm --budget` (`search.ts`) and `gmax context` Key Functions + skeleton loops (`context.ts`). After: the same budget-1500 query emits **3 results / 1161 tokens (77%)**; `gmax context --budget 4000` fills to 96%. +7 tests (`tests/budget-pack.test.ts`). **Bench-neutral by construction** — lives in the presentation layer, `searcher.ts` scoring untouched.

**Decision (honored).** Density only influences budget-packing in the context/`--context-for-llm` modes (opt-in by nature); the general `gmax search` ranking is untouched, so no "silent long-chunk penalty" surprise.

### Phase 5 — Semantic result cache (P4 #17) ⬜

**Why.** The daemon receives the same or near-identical query repeatedly within a session (agents often retry with small variations). Cache `query_hash → top-K results` for ~5 min, served before vectorSearch.

**Shape of work.**
- LRU in `src/lib/daemon/daemon.ts` keyed by `(projectRoot, query, filtersHash)`.
- Bust on any batch-processor flush (file changes invalidate the project's cache entries).

**Independent of all other phases.**

### Phase 6 — Cross-project search via `--all-projects` / `--projects <list>` (P4 #13) ✅ SHIPPED

**Status (2026-06-03):** shipped. CLI `gmax search` gained `--all-projects`, `--projects <list>`, and `--exclude-projects <list>`. New `src/lib/utils/cross-project.ts` (`resolveCrossProjectScope` / `projectForPath` / `groupResultsByProject`) maps the flags onto the pre-existing `project_roots` / `exclude_project_roots` filter clauses (`searcher.ts:113-129`) the MCP `scope:'all'` path already used; cross-project drops the single-project `pathPrefix` so the OR-group LIKE clauses scope alone. Output is grouped by owning project (longest-root-prefix match) across agent / compact / plain / default modes, each group relativized against its own root. `--skeleton` / `--context-for-llm` / `--symbol` are rejected up front (single-project by nature); `--in` / `[path]` warn-and-ignore. Both the daemon-mediated and in-process search paths carry it (filters already flow through IPC unchanged — the running daemon needed no upgrade). +10 tests (`tests/cross-project.test.ts`). **Follow-up not taken:** MCP cross-project already works functionally but returns a flat list — per-project grouping there is a cheap future polish.



**Why.** Today every command is single-project. Agents working across microservices or polyglot setups (8+ projects watched concurrently) sometimes want "where do *any* of my projects do X?"

**Shape of work.**
- Multi-prefix scoping in LanceDB: `path LIKE '<a>%' OR path LIKE '<b>%'` (or N parallel queries fused with RRF).
- Output format: group hits by project to avoid mixing idioms (Swift + TS + Python in one flat list is noise).
- Likely most useful for `search` only — cross-project symbol commands are rarely what you want.

### Phase 7 — `gmax impact <file>` accepting file paths ✅ headline DONE / 🎨 rollup polish = Later (design project)

**Status (2026-06-03):** the headline ask **shipped** — `impact.ts:16` accepts `<symbol or file path>`, `lib/graph/impact.ts:33-57` resolves a file to its `defined_symbols`. **Test-exclude flag SHIPPED 2026-06-03:** `--no-tests` skips the affected-test traversal and omits the section (production blast radius only); uses the robust `isTestPath` regex, so more reliable than `--exclude tests/`. +2 tests. The remaining rollup items below (per-export / package-grouping / top-K sampling / SDL-awareness) are still the open "design project" part; sequenced under **Later #9**.

**Why.** Today `gmax impact` takes a symbol. Accepting file paths would answer "what depends on this file?" — a common monorepo question. Empirical extremes from dogfooding: a huge SDL export and a 127-importer UI primitive — both are the design constraints.

**Implemented 2026-07-01.** Phase 7 shipped as a rollup/presentation layer over existing graph data,
not a new graph model.

**MVP behavior.** Existing symbol-target output and default `--agent` `dep:` / `test:` lines are
preserved. File targets in human output render rollup by default with `--flat` as an escape hatch. For
symbol targets and agent mode, explicit `--rollup` emits TSV rollup rows. `--top <n>` caps sampled
dependents/tests in each section. `--no-tests` semantics are unchanged: skip traversal and omit test
sections. MCP `impact_analysis` accepts `rollup:true` and `top`.

**Implementation shape.** Add `findDependentsDetailed()` in `src/lib/graph/impact.ts` so dependent
files retain the matched target symbols, not just `sharedSymbols`. Build a pure rollup object from
detailed dependents plus existing `findTests()` results: per-export counts, package groups, top
dependents, and grouped tests. Use a conservative package heuristic (`packages/<name>` when present,
else a stable first-directory bucket). Add human and TSV agent formatters; agent rollup rows should be
deterministic (`summary`, `export`, `pkg`, `dep`, `test`). Thread optional `rollup`/`top` through MCP
`impact_analysis` after the CLI behavior is covered.

**Non-goals for MVP.** Do not add standalone `.graphql` indexing or GraphQL operation dependency
graphs. Do not implement SDL structural impact in the first pass; keep it as Phase 7B if examples
require it. Do not parse SQL/template-literal DSLs here; that belongs to the narrowed Phase 9 SQL
skeleton MVP. Do not add new LanceDB columns, reindex requirements, or LLM summaries.

**Acceptance.** Existing impact tests keep passing; default symbol output and default agent output are
compatible. File-target human output shows target export count, production dependent count, package
count, affected test count, per-export rollup, package grouping, and top-K representative dependents.
`--no-tests` avoids calling `findTests()` and omits test sections in both flat and rollup modes.
`--agent --rollup` emits deterministic TSV rows suitable for MCP/agent parsing.

### Phase 8 — Code/docs split (P4 #11) ⬜ (design project)

**Why.** Today docs get a flat 0.6× role penalty (`searcher.ts:341`) **plus** a path-extension penalty (`searcher.ts:356-367`) — two separate, partly-untunable penalties (see S2). A `docs/architecture.md` describing how auth works gets penalized below an `auth.ts` function whose comments mention the same words — the wrong outcome when the agent's actual question is "how does auth work?"

**Shape of work.**
- Frontmatter awareness (status, type, audience as ranking signals).
- Doc-doc graph (markdown link extraction → reference edges between docs).
- Lifecycle/freshness signals (created/updated timestamps from frontmatter).
- Substantial — effectively a doc indexing pipeline parallel to the code pipeline.

**Interim knob.** `GMAX_DOC_PENALTY` is env-overridable. Ratchet up as a stopgap.

**Verification (2026-05-07).** osgrep's README claim ("Queries both 'Code' and 'Docs' separately") is overstated — both osgrep `searcher.ts:202` and gmax `searcher.ts:278-305` do the same thing: one unified vector query + one unified FTS query → RRF merge → role-based score adjustment afterward.

### Phase 9 — Skeleton template-literal-aware DSL parsing ✅ narrowed MVP shipped 2026-07-01

**Why.** Same family of design work as Phase 7. High payoff for monorepos that lean on template-literal DSLs (GraphQL SDL, SQL, CSS-in-JS).

**Shipped scope.** The broad per-DSL extractor was rejected after corpus review. The implemented MVP is a lightweight TS/JS skeleton-summary hint for hidden SQL tagged templates: ``sql`...` `` and ``.sql`...` `` inside elided function bodies produce compact hints such as `SQL: SELECT users; INSERT audit_log`. Template interpolations become placeholders, the full SQL text remains elided, and non-SQL tags are ignored.

**Still not built.** No GraphQL/CSS parser, no standalone `.graphql` indexing, no new LanceDB columns, and no reindex requirement beyond normal stored-skeleton refresh.

### Phase 10 — Call-graph distance reranking (P4 #14) ⏭ DEFER — premise check failed to justify a build (2026-06-03)

**Premise-check verdict (2026-06-03): DO NOT BUILD the rerank now. Measure-first if ever revisited.** Ran the check the plan demanded; the build is not justified. Four findings:

1. **Graph density is real but patchy** (`eval-graph-totals.ts`, live on platform): 47.5% of chunks carry `referenced_symbols` (avg 54.8/chunk) — far better than the old "0 totals" probe. But uneven: `ErrorCodes`=63 / `BeyondError`=12 ref-chunks, yet `resolveActor`/`errorHandler`=**0** despite being defined. Distance signal exists for some symbols, is absent for others.
2. **Seeding already does the anchor-biasing job** (`eval-seed.ts`, live): **9/9 pass** (route 4/4, recover 1/1, guard 4/4). File+symbol seeding already routes ambiguous queries to the anchor's subsystem and even recovers an out-of-top-25 answer to #1. On every anchor-bearing fixture we have, the membership signal is sufficient.
3. **The relevance gate neuters graph-distance's *distinct* case.** The safety invariant is `bestRank ≤ maxRank(8)` (`searcher.ts:594-600,663`): a boost only fires for candidates already in the top-8 of some retriever. Graph-distance's claimed advantage is "boost a chunk 2 hops out with no symbol overlap" — but such a chunk is semantically far from the query, so it sits at rank >8 in every retriever → **gated out, exactly like an off-topic seed**. The residual that *isn't* gated out — a mid-ranked (2–8) **callee-definition** semantic search already found but ranked below a false-friend — is real but narrow, and **no fixture measures it**. Dropping the gate to admit the deep case re-introduces the structural noise the whole seed design exists to prevent. Penalizing *distant* modules (the other half of the proposal) is worse: it would demote a semantically-perfect answer that merely lives in a far module (e.g. a shared util).
4. **Structural proximity is already a first-class surface.** An agent that wants "what's near this in the call graph" has purpose-built commands — `gmax trace` (`--inbound` callers), `gmax peek` (callers+callees), `gmax impact`, `gmax related`. Bolting graph-distance onto *semantic* search (where the query already expresses the semantic target) is the wrong surface, and adds a per-query BFS cost (`getNeighbors` does one DB lookup per neighbor, `graph-builder.ts:290-302`).

**Net:** bench at ceiling (no measurable headroom) + seeding already 9/9 + the one distinct mechanism is gate-neutered or noise-prone + dedicated graph commands already serve the need. **Deferred, measure-first.** Reopen only if a real agent-trace shows a recurring "semantic search missed a graph-near answer that seeding couldn't recover" pattern — and at that point the *first* step is a callee-definition fixture class (an `eval-graph-rerank.ts` of route/guard cases), exactly how seeding was de-risked via `eval-seed.ts`. Do not build the rerank before that fixture exists and moves.

**Status history:** the "MCP anchor wiring" blocker was cleared by the v0.17.17 seed protocol (`seed_files`/`seed_symbols` → `searcher.ts`); graph primitive already returns hop distance (`graph-builder.ts:290-302`). Technically unblocked — but the premise check above says the value isn't there.

**Why.** When the query has a known anchor (the symbol/file the agent was just reading), boost results that are *near* it in the call graph and penalize distant modules.

**Shape of work.**
- Graph is already built (`src/lib/graph/graph-builder.ts`).
- Anchor-by-flag is feasible today (`gmax search 'X' --near auth.ts`) but few agents would type it.
- Real unblock: MCP/agent-context auto-passes an anchor. Same blocker as Phase 4 of the landscape plan (G3 chat seeding).

**Coupling.** This and G3 (Aider-style chat seeding) share the MCP anchor protocol. Worth designing the anchor stream once, using both downstream.

### Phase 11 — Embedding model versioning (P4 #18) ⬜ → SCOPED in `docs/plans/2026-06-23-index-versioning-and-daemon-refactor.md` (Item 1: Phase 1A visibility now / Phase 1B migration deferred)

**Why.** Foundation for evolving embeddings without a global reindex. `vectorDim` is already in `config.json`.

**Shape of work.**
- Two-table LanceDB layout (or a `model_version` column on `chunks` with index on it).
- Background re-embed worker streams the corpus through the new model into the new column.
- Atomic cutover once parity verified. The cutover dance is the hard part, not the column schema.

**When to pick up.** When a meaningfully better embedding lands (Granite v2, Qwen3-embed, etc.) and a reindex would be disruptive enough to justify the migration machinery.

### Phase 12 — search.ts / daemon.ts refactor splits ✅ shipped

**Why.** Both files are long but coherent — and have GROWN since this item was written (2026-06-03 counts): `src/commands/search.ts` is **1292** lines (was ~675); `src/lib/daemon/daemon.ts` is **1623** lines (was ~1500) — has search, FSEvents recovery, prewarm, idle, MLX management, watcher logic, IPC dispatch. Refactor opportunistically.

**Shape of work.**
- `search.ts`: extract a single `runSearch(opts) → SearchResponse` picking the path (daemon-mediated vs in-process), leaving `action` as glue.
- `daemon.ts`: split into `daemon.ts` (lifecycle), `watcher-manager.ts` (subscribe/recover/poll), `search-handler.ts` (the `search()` method).
- Completed by `79f12d7` and `fbb8396`.

### Phase 13 — Dedicated query-only worker ⏭ CLOSED 2026-06-03 (obsolete)

**Status (2026-06-03):** closed — superseded by startup prewarm (`daemon.ts:316-350`, two warmup `encodeQuery`s warm LanceDB + Granite + ColBERT) and priority dispatch (`pool.ts:180-188`, query/rerank jump the indexing backlog). A dedicated resident worker re-adds the ~300MB–1GB the team intentionally cut to `MIN_KEEP_WORKERS = 1` (`pool.ts:168`). Not worth the memory.

**Why (original).** Closes the post-restart slow window — the first query after daemon restart pays cold-start cost on the worker pool.

**Shape of work.** Keep one extra worker process warm, dedicated to query embedding (not indexing). One extra resident worker.

---

## Deferred

Items that don't justify a phase right now but might later:

- **Hierarchical result grouping beyond file groups in `--agent` output (P4 #16).** File-level grouping and shared CLI/MCP pointer formatting have shipped. Deeper module/dir grouping remains unproven; measure before building.
- **LLM-driven query expansion (`--expand-llm`).** Follow-up to Phase 2 if the static map is insufficient.

## Decisions

- **2026-05-07** — HyDE and static query expansion demoted from "urgent" to "opt-in flag work." Dogfooding friction in `platform` wasn't recall-shaped — most misses were monorepo-scoping, which `--in` / `--exclude` (Phase 2 keystone) resolved. Still worth shipping behind flags and measuring.
- **2026-05-07** — `gmax log` strongly promoted; closes a whole task class (git-history queries scoped to a path or symbol). Shipped v0.16.3.
- **2026-05-07** — `--in` / `--exclude` confirmed as the keystone monorepo fix. Shipped v0.16.2.
- **2026-05-07** — Seven small items surfaced during dogfooding (cross-language disambiguation, search relevance scores, exported-`const` indexing, role-tag legend, test-find import-fallback, related importer-fallback, `trace --inbound`) — all shipped across v0.16.1 → v0.16.4.
- **2026-05-30** — Fresh agent POV sweep shipped v0.17.4 followups: deterministic `gmax context <path>` and one shared agent search formatter for CLI local/server paths plus MCP pointer mode.
- **2026-06-03** — Phase 6 (cross-project search) shipped v0.17.20; Phase 4 (token-aware `--budget`) shipped v0.17.21. Phase 4's premise check reshaped it: the bits-per-token *reorder* was the wrong primitive — the demonstrable waste was the greedy `break` (59% budget utilization), so it shipped as knapsack-continue packing + a tie-only density tiebreaker, presentation-layer only (bench-neutral).
- **2026-06-03** — **Phase 10 (call-graph distance rerank) DEFERRED after a premise check** (the discipline that earlier killed type-position refs and de-risked pooled-ColBERT). Evidence: graph density patchy (47.5%, some symbols 0 refs); seeding already 9/9 on anchor-bearing fixtures (`eval-seed.ts`); the one mechanism distinct from seeding (boost a graph-near, symbol-disjoint chunk) is either rejected by the `bestRank≤8` relevance gate (semantically-far → deep in every retriever) or, if the gate is dropped, re-injects structural noise; and structural-proximity exploration is already a first-class surface via `trace`/`peek`/`impact`/`related`. Reopen only on a measured agent-trace miss pattern, fixture-first. This exhausts the Next tier.

## Open Questions

- **SessionStart hint length budget.** Current ~600 chars; the v0.16.5 restructure landed ~900 chars. Acceptable for context cost on every session? Could trim by removing the per-command one-liners — verb names carry most of the info.
- **Phase 1 (HyDE) measurement set.** What's the held-out fixture set? The 4-fixture instrument has known coverage holes (4 platform hard-miss cases that can't currently be recovered — see [the landscape plan's Bundle B background](../plans/2026-05-25-semantic-search-landscape.md#background)). HyDE might help on those, or might not.
- **Phase 7 (`impact <file>`) design constraints.** Big SDL exports and 127-importer UI primitives are the two extremes — does one rollup format serve both, or does the command need different presentation modes?

---

## Background — Catalog (P0–P5 supporting detail)

The catalog below is the original 2026-05-07 detail capturing each item with symptoms, fix sketches, and open questions. P0–P2 items shipped in v0.16.x; P3–P5 items map to the phases above.

The audience for these fixes is brother/sister Claude Code sessions running in other repos, who learn gmax from one sentence injected by `plugins/grepmax/hooks/start.js:155`. They will never read `--help`. They pattern-match on the examples and recover poorly from terse errors.

Sources for the feature-gap section: perplexity research on Sourcegraph Cody / Cursor / Aider / Continue / Codeium / Greptile / Phind / GitHub Copilot Workspace, plus a direct comparison against `osgrep@0.5.16`.

### P0 — destructive + silent

#### 1. `gmax remove <name>` — resolve registered project names ✅

**Symptom.** `gmax remove beyond-canvas` from `~/Development/beyond/tools/gmax` deleted the gmax index instead of beyond-canvas. The arg was treated as a path; non-existent path → fell through to cwd.

**Fix shipped (v0.16.1).** In `src/commands/remove.ts`, when the arg has no path separator and doesn't exist as a directory:
1. Look up `projects.json` for an exact name match.
2. On match: prompt with the full resolved path before delete. (`--force` skips the prompt but keeps the resolution.)
3. On no match: refuse, list registered projects, exit non-zero.

### P1 — agent failure modes that waste turns

#### 2. `gmax skeleton <directory>` — refuse cleanly ✅

**Symptom.** `gmax skeleton .` resolved `.` to `.gitignore` and printed `// Skeleton unavailable: Unknown file extension`. Wastes tokens, doesn't suggest recovery.

**Fix shipped (v0.16.1).** Before file resolution, if the arg `stat`s as a directory, exit with a one-line agent-friendly message hinting at `gmax search` / single-file `skeleton`.

#### 3. `Symbol not found: X` — add next-step hints ✅

**Symptom.** `gmax peek emit` from gmax cwd returned `Symbol not found: emit`. The same symbol exists in stripes. Agent has no signal that another scope might help.

**Fix shipped (v0.16.1).** In the shared "no match" path used by `peek` / `extract` / `trace` / `test` / `impact`:
- If `X` is found in another indexed project, name the project and emit the exact rerun command.
- Otherwise: `Try: gmax search "X" --agent`.

### P2 — discoverability

#### 4. Restructure the SessionStart hint ✅

**Fix shipped (v0.16.5).** Grouped by use-case (find / understand / survey / recovery), surfaces `--in`/`--exclude`/`--root <name>`/`gmax log`/`trace --inbound`/role-tag legend; subagent-start hint trimmed; `Bash(...)` wrapping dropped.

#### 5. `--root <name>` resolves registered project names ✅

**Fix shipped (v0.16.2).** Resolution order:
1. Path separator OR existing directory → path.
2. Else lookup `projects.json` by name. Match → resolved root.
3. No match → error with `Available projects: <list>`.

### P3 — nice-to-haves → Phase 3 above

- **#6** Trailing `next:` line on `--agent` errors.
- **#7** `gmax help-agent` cheatsheet.
- **#8** Unified empty-result style.

### P4 — Feature gaps vs leading semantic search tools

Items below mapped to phases. Detail preserved for design context.

#### 9. HyDE — `--hyde` opt-in → Phase 1

(Detail above in Phase 1.)

#### 10. Query expansion → Phase 2

(Detail above in Phase 2.)

#### 11. Code/Docs split → Phase 8

(Detail above in Phase 8.)

#### 12. Test discovery auto-attached to symbol commands ✅

**Shipped v0.16.4.** peek/extract tests footer default-on.

#### 13. Cross-project search → Phase 6

(Detail above in Phase 6.)

#### 14. Call-graph distance reranking → Phase 10

(Detail above in Phase 10.)

#### 15. Token-aware filtering for `--budget` → Phase 4

(Detail above in Phase 4.)

#### 16. Hierarchical result grouping → Deferred

Pure output-formatting change in `src/commands/search.ts` agent-mode rendering. Token cost of group headers vs comprehension benefit; agents handle flat lists fine. Worth measuring before building.

#### 17. Semantic result cache → Phase 5

(Detail above in Phase 5.)

#### 18. Embedding model versioning → Phase 11

(Detail above in Phase 11.)

### P5 — Observations from osgrep parent comparison

`osgrep@0.5.16` is the fork ancestor. Comparing the two:

- **Command surface:** gmax is a strict superset. We have all 15 osgrep commands plus 20 more (`add`, `config`, `context`, `diff`, `extract`, `impact`, `investigate`, `llm`, `peek`, `plugin`, `project`, `recent`, `related`, `remove`, `review`, `similar`, `status`, `summarize`, `test-find`, `watch`). Nothing they have that we don't.
- **Search options:** gmax has `--agent`, `--explain`, `--context-for-llm`, `--budget`, `--root`, `--file`, `--exclude`, `--lang`, `--role`, `--symbol`, `--imports`, `--name`, `-C` — none of which osgrep has. We're meaningfully ahead on agent ergonomics.
- **Architecture divergences gmax has on top of osgrep:**
  - MLX GPU embed server vs osgrep's CPU-only ONNX (~5x faster).
  - Singleton daemon w/ socket IPC vs osgrep's per-project HTTP server.
  - `@parcel/watcher` (native FSEvents) vs `chokidar`.
  - Custom child-process worker pool vs `piscina` thread pool.
  - LMDB MetaCache layer for skip-unchanged-files.
- **What osgrep does that we should reconsider:** the three-mode `skeleton` (#2 above). Otherwise we're feature-positive everywhere checked.

### Code hygiene findings (2026-05-07)

- **TODO/FIXME/HACK count:** 0 in `src/`.
- **Stale `osgrep` references in `src/`:** 0. Clean fork separation.
- **`src/commands/search.ts` is 675 lines** → Phase 12.
- **`src/lib/daemon/daemon.ts` is ~1500 lines** → Phase 12.

## Version History

- **2026-08-04T11:07:45Z** Archived — All scoped UX phases shipped; remaining ideas require new measured triggers.
- **2026-05-07** Created after two rounds of dogfooding in `platform`. v0.16.0 cut from current commits.
- **2026-05-07 → 2026-05-15** v0.16.1 → v0.16.5 shipped Phase 0–5.
- **2026-05-30** v0.17.4 shipped deterministic path context and CLI/MCP pointer formatter parity.
- **2026-05-28** Restructured from `type: doc, status: reference` → `type: plan, status: active` with phased open backlog. P0–P5 catalog preserved as supporting detail under Background.
- **2026-08-04** Final review confirmed Phases 7, 9, and 12 shipped; remaining ideas are
  measurement-gated and this plan is ready to archive.

## Closeout

All scoped UX phases shipped. The final larger items landed in `a71c616`, `504c055`,
`79f12d7`, and `fbb8396`. HyDE, query expansion, semantic cache, graph-distance rerank,
embedding migration, and broad DSL parsing remain explicitly trigger-gated and should get
new focused plans if evidence justifies them.
