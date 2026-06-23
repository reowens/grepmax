---
type: doc
status: reference
created: 2026-04-09
updated: 2026-06-22T18:00:00Z
summary: Live catalog of open gmax limitations with detection + recovery steps.
audience: internal
related_plans:
  - docs/plans/2026-05-25-semantic-search-landscape.md
related_docs:
  - docs/agent-ux-proposals.md
---

# Known Limitations

Last updated 2026-06-22.

## Chunker `referenced_symbols` extracts call-expression names, not identifier-as-value references

Added 2026-05-26. Confirmed during Bundle B G1' Phase 0 sanity check.

**Mostly fixed 2026-06-02 (all 14 grammars).** The chunker now emits identifier-as-value edges for `new ClassName(…)` / `ClassName{…}`, `instanceof ClassName` / `x is T`, and `Enum.MEMBER` / `Enum::MEMBER` (member/scope access gated to a Capitalized leaf head) across **every grammar** — TS/JS plus Python, Go, Rust, Java, C#, Ruby, Kotlin, Swift, Scala, PHP — via grammar-keyed node-type dispatch in `chunker.ts::extractRefs`. Verified on real platform source: `BeyondError`/`ErrorCodes` produce `referenced_symbols` edges in their caller chunks and `GraphBuilder.buildGraph` surfaces those callers (`tests/graph-edges.identifier-as-value.test.ts`); the other 10 languages each get a class+enum edge in `tests/graph-edges.identifier-as-value.multigrammar.test.ts`. Real-Rust spot-check (`dirplayer-rs/.../sprite.rs`): 12/16 def-chunks gained clean `ColorRef`/`Sprite`/`CastMemberRef` edges, all previously absent. TS/JS read-only A/B over the platform corpus: +1.1% `referenced_symbols` bytes, 0% embedded-content growth.

Corpus-wide chunk-level density (eval-graph-totals reproduced fan-free over 121k platform TS/JS chunks; `ref-chunks` is a pure chunking property, so no reindex needed to measure it):

| Target | Shape | Before | After |
|---|---|---|---|
| `BeyondError` | class (`new`/`instanceof`) | 0 | **12** |
| `ErrorCodes` | enum (`.MEMBER`) | 0 | **62** |
| `resolveActor` | ordinary call (already-covered shape; current code references `resolveActorV2`) | 0 | 0 |
| `errorHandler` | callback-as-value (out of scope) | 0 | 0 |

The two in-scope class/enum targets go from an empty graph to real caller edges. The other two were mis-grouped in the original Phase-0 set: neither is an identifier-as-value class/enum reference.

**Still open:** (1) no query-time consumer reads these `referenced_symbols` edges yet. The intended consumer (Phase 3 PPR/k-hop) is **deferred** — its design probe found the platform hard-miss defs are already in-pool, so there's nothing to recover (see the PageRank entry's "Next direction" below). The v0.17.9 symbol-definition promotion that fixed those cases reads `defined_symbols`, not the `referenced_symbols` graph edges, so it doesn't exercise this work. The edges still benefit `gmax dead`/`gmax trace --inbound`; (2) ~~other grammars still capture call-expressions only~~ — **resolved 2026-06-02**: the three identifier-as-value shapes now cover all 14 grammars (a `--reset` reindex of a non-TS repo is still required to make its edges live at query time); (3) type-position references (`: ClassName`, `<ClassName>`, `extends ClassName`, `as ClassName`, type aliases) — **captured across all statically-typed grammars 2026-06-22** into a separate `type_referenced_symbols` column (kept out of `referenced_symbols` so they never inflate the call-edge count that drives role/search ranking; navigation consumers union the two). Two capture paths: grammars that spell type names as `type_identifier` — TS/JS (Shapes 4/5, `class extends Base` heritage included), Go, Rust, Java, Kotlin, Scala, Swift — are covered by Shape 4's grammar-agnostic `type_identifier` capture; grammars with **no** `type_identifier` node — Python (`identifier`), C# (`identifier`/`generic_name`), PHP (`name` inside `named_type`) — get Shape 6, which reads each annotation's type field (parameter / return / variable / property positions + class bases / extends-implements) and harvests Capitalized leaves. Measured via `src/eval-graph-nav.ts`: TS/JS + Python type-position recall 100% on gmax-self, `dead` false-positives → 0, canonical Pydantic `: EmbedRequest` dead-FP closed (live `gmax dead EmbedRequest` → server.py:170); the 8 non-TS typed grammars are locked in by `tests/graph-edges.type-position.multigrammar.test.ts`; bench:oss byte-identical (express 0.889 / lodash 0.900). **Still uncaptured:** C++ return types (a pre-existing `getNodeName` bug names a C++ function after its return type, so the `name`-exclusion then drops it — orthogonal to type positions); Ruby (dynamically typed — no annotations to capture); Python string forward-refs (`-> "Foo"`) and module-level `TypeVar`s (declared outside chunk scope, so a handful of `T`/`K` self-edges may leak); C#/PHP namespace-qualified types over-capture PascalCase segments (`System.Collections.Foo` → all three — harmless dangling edges); and the bare-identifier-as-callback-value shape (`emitter.on('x', errorHandler)`), deferred because capturing bare lowercase-identifier values would flood the graph with every local. A `--reset` reindex (and a daemon on new code) is required to make a repo's edges live.

The chunker writes `referenced_symbols` per chunk to support `gmax trace`, `gmax dead`, and any graph-derived ranking signal. Today the extraction tracks **call-expression callees** — names that appear in a syntactic call position. It does **not** track identifier references that aren't calls: class names used as values (`new BeyondError(…)`, `instanceof BeyondError`, `throw new ValidationError(…)`), constants/enums referenced as values (`ErrorCodes.NOT_FOUND`, `ErrorCodes.VALIDATION`), or types referenced in expression position.

Evidence (platform monorepo, ~123k chunks, scoped via `pathPrefix`):

| Target symbol | def-chunks | ref-chunks (whole corpus) |
|---|---|---|
| `BeyondError` | 1 | 0 |
| `ErrorCodes` | 0 | 0 |
| `resolveActor` | 3 | 0 |
| `errorHandler` | 3 | 0 |

Despite 14.0% of platform chunks having non-empty `referenced_symbols` (avg 82 refs/chunk where non-empty), zero chunks in the entire indexed corpus have any of these four symbols in `referenced_symbols`. Spot-check on a known caller file (`packages/api/src/middleware/error.ts`, where `errorHandler` clearly handles `BeyondError`): the chunk's 40 refs are `[now, createRequestLogger, get, get, warn, annotateActiveSpan, logRequest, json, …]` — all method/function call sites, no class-as-value references.

**Impact:**
- `gmax dead <ClassName>` will under-count callers — any usage that's purely `new ClassName(…)`/`instanceof ClassName`/`ClassName.MEMBER` is invisible to the graph. The current `gmax dead` output already disclaims dynamic dispatch and string-built call sites (see entry below); the class-as-value blind spot is in the same family.
- `gmax trace --inbound <ClassName>` will look sparse for the same reason.
- Any graph-derived ranking signal (PageRank, k-hop recall recovery, PPR) inherits the same blind spot. Bundle B's G1' was aborted at Phase 0 for exactly this reason — see [the plan doc](plans/2026-05-25-semantic-search-landscape.md) Bundle B section.

**Scope of fix.** Revisit tree-sitter capture queries per-language (TS/JS, Python, Go, Rust, Java, C#, Ruby, Kotlin, Swift, Bash, Scala — 11+ grammars) to also capture identifier references in expression position, while keeping the existing call-expression coverage. This is the upstream lever for `gmax dead <ClassName>` accuracy, `gmax trace --inbound <ClassName>` density, and any future graph-derived ranking signal (PageRank, PPR, k-hop recovery — all blocked on this). Measurement target: does the new edge density help downstream consumers enough to justify the chunk-size growth? Track via the eval harness once edges land.

**Repro:**
```bash
npx tsx src/eval-graph-totals.ts     # whole-corpus ref counts on platform
npx tsx src/eval-graph-spotcheck.ts  # raw referenced_symbols for known callers
```

## `gmax dead` is a hypothesis, not a proof

Added 2026-05-25 (v0.17.2).

`gmax dead <symbol>` reports zero inbound callers in the **indexed call graph**, which only contains what tree-sitter chunked statically. The following call sites are invisible to it and will produce false `DEAD` reports:

- **Dynamic dispatch** — method calls resolved at runtime through interfaces/protocols/duck typing.
- **Reflection / `eval`** — `getattr`, `Function.prototype.apply`, `eval`, `import()` with a runtime string.
- **String-built call sites** — `obj[methodName]()` where `methodName` is computed.
- **Identifier-as-value references** — `new ClassName(…)`, `instanceof ClassName`, `Enum.MEMBER`. **Captured across all 14 grammars** (2026-06-02). **Type-position references** (`: T`, `<T>`, `extends T`, `as T`, plus Python/C#/PHP annotations + class bases) — **captured across all statically-typed grammars 2026-06-22** (separate `type_referenced_symbols` column, unioned by `dead`/`trace`); C++ return types, Ruby (no annotations), and the callback-value shape remain uncaptured. A non-TS repo (and any repo for type-position) needs a `--reset` reindex on new code for its edges to go live. See the "Chunker `referenced_symbols`…" entry above.
- **Cross-language calls** — a Python caller of a TypeScript exported function (and vice-versa) — graph is built per-language.
- **External consumers** — anything outside the indexed project tree.

Exported public-API symbols correctly downgrade to `PUBLIC EXPORT — no internal callers found; check external usage` when the defining chunk has `is_exported === true`. Treat `DEAD` as a starting point for removal, not a green light. Cross-check with `grep -r <symbol>` before deleting.

**What is in scope.** The identifier-as-value class — `new ClassName`, `instanceof ClassName`, `Enum.MEMBER` — is fixable via the chunker work above, and **now landed for all 14 grammars** (TS/JS first; the other 10 on 2026-06-02). The platform `--reset` reindex on 2026-06-02 made TS/JS edges live at query time (`BeyondError` 0→12, `ErrorCodes` 0→62 caller chunks), so `gmax dead <ClassName>` is meaningfully more accurate for class/enum targets; non-TS repos gain the same accuracy after their next `--reset` reindex. The callback-value shape (bare lowercase identifiers passed as values) stays open. Dynamic dispatch, reflection, and string-built call sites stay outside what a static graph can claim — that's a property of the static-analysis approach, not a deferral.

## ColBERT rerank is opt-in (shape-sensitive: helps monolithic files, hurts modular repos)

Added 2026-05-25 (v0.17.1). Refined 2026-05-25 with OSS-fixture evidence. Concentration auto-gate shipped v0.17.7 (2026-06-02) — see end of entry.

ColBERT late-interaction rerank defaults to **off**. Three fixture sets across two code shapes:

| Dataset | Code shape | rerank-off MRR | rerank-on MRR | Δ MRR | R@10 off→on | hits@1 off→on |
|---|---|---|---|---|---|---|
| gmax (97 cases) | modular TS | 0.5938 | 0.5657 | **−0.028** | 0.804 → 0.794 | 47 → 44 |
| express 4.21.1 (9 cases) | modular CommonJS | 0.6519 | 0.4778 | **−0.174** | 0.889 → 0.889 | 5 → 3 |
| platform (15 cases, private) | modular monorepo (pnpm) | 0.5467 | 0.3962 | **−0.151** | 0.733 → 0.733 | 6 → 4 |
| lodash 4.17.21 (10 cases) | monolithic IIFE | 0.3667 | 0.6500 | **+0.283** | 0.600 → 0.900 | 2 → 5 |

Fixtures are sverklo-bench P1 (definition lookup) ported verbatim from [sverklo/sverklo-bench](https://github.com/sverklo/sverklo-bench); platform fixtures hand-curated against a private monorepo using the same bare-symbol query methodology. Reproduce via `npx tsx src/eval-oss.ts <dataset>` (or `all`) with `GMAX_EVAL_RERANK=1` to toggle. Rerank doubles query latency in all cases (~75ms → ~155ms).

Note that for every modular dataset, **recall@10 is unchanged** between modes — rerank perturbs the top-10 ordering but never promotes a new file *into* the top-10. The hits@1 drop is the entire user-visible cost.

**The shape-sensitivity pattern.** On modular codebases each expected hit lives in its own file; fusion already picks the right file from filename/path signals, and ColBERT perturbs ranks within the correct candidate pool — usually for the worse. On monolithic single-file repos (lodash.js is 17K lines, hundreds of chunks) fusion can't discriminate within the file, and ColBERT's token-level scoring is the only mechanism that promotes the right chunk to the top.

**Opt in per-process:**

```bash
GMAX_RERANK=1 gmax search "query"
```

If you're indexing a single-file library, large generated/bundled code, or a datalake-style repo, the +30% recall is probably worth the latency. For modular projects, leave it off.

**Where the default lives:** `src/lib/search/searcher.ts` — `let doRerank = _search_options?.rerank ?? false`, then flipped on by the concentration gate below. CLI and MCP wrappers read `process.env.GMAX_RERANK === "1"`.

**Resolved — candidate-concentration auto-gate (shipped v0.17.7, 2026-06-02).** After RRF fusion, `searcher.ts` histograms the top-10 pool by file path; if the largest file's share ≥ `GMAX_CONCENTRATION_THRESHOLD` (default **0.7**, set > 1 to disable) it flips `doRerank` on. Only ever *adds* rerank-on — an explicit `GMAX_RERANK=1` is never overridden off. Threshold chosen by sweeping {0.6…0.9} against `pnpm bench:oss`: 0.7 is the highest value that retains lodash's +0.15 MRR lift (recall 0.600→0.800) while leaving express/platform flat. The cutoff is **global, not per-language** — express (JS, like lodash) never trips it at any threshold down to 0.6, so the signal is shape-based. This converts the shape-sensitivity from a manual opt-in into an automatic per-query decision for the concentrated regime.

## PageRank tiebreaker is opt-in (same shape-sensitivity as ColBERT)

Added 2026-05-26. Implementation `src/lib/search/pagerank.ts` + wiring in `src/lib/search/searcher.ts`. Default off.

Global PageRank computed per-project over the call graph (nodes = `defined_symbols`, edges = `referenced_symbols` within a chunk), normalized to [0, 1], and added as `PR_WEIGHT * normalizedPR(chunk.defined_symbols)` to the post-fusion/post-boost score. Same 4-fixture instrument as ColBERT, at `PR_WEIGHT=0.05` (default):

| Dataset | Code shape | PR-off MRR | PR-on MRR | Δ MRR | Δ R@10 |
|---|---|---|---|---|---|
| gmax (97 cases, scoped) | modular TS | 0.4960 | 0.4680 | **−0.028** | −0.010 |
| express 4.21.1 (9 cases) | modular CommonJS | 0.6519 | 0.6519 | 0.000 | 0.000 |
| platform (15 cases, private) | modular monorepo | 0.5467 | 0.5467 | 0.000 | 0.000 |
| lodash 4.17.21 (10 cases) | monolithic IIFE | 0.3667 | **0.4333** | **+0.067** | **+0.200** |

Same shape-sensitivity as ColBERT: modular regresses or stays flat, monolithic lifts. Weight sweep (`GMAX_PR_WEIGHT` ∈ {0.05 … 2.0}) only widens the gap — higher weights push lodash further up and crush express (0.65 → 0.32 at PR_WEIGHT=1.0). Root cause is structural, confirmed against IR literature: global PageRank is a query-independent popularity prior, so it preferentially weights "glue" code (utilities, framework base classes, barrels) which is precisely what users *don't* query by bare symbol name in modular repos. In lodash's monolithic IIFE, high-PR nodes (`map`, `filter`, core collection ops) *are* what users query, so the prior aligns with intent.

**Opt in per-process:**

```bash
GMAX_PAGERANK=1 gmax search "query"
# tune the additive weight (default 0.05):
GMAX_PAGERANK=1 GMAX_PR_WEIGHT=0.1 gmax search "query"
```

Reproduce the table: `GMAX_PAGERANK=1 pnpm bench:oss:json` (express/lodash/platform); for gmax-self scoping use `GMAX_PAGERANK=1 GMAX_EVAL_PATH_PREFIX=/abs/path/to/gmax/ pnpm bench:recall:json`. Cache lives under `~/.gmax/pagerank/<sha1-of-pathPrefix>.json`, 1h TTL (tunable via `GMAX_PAGERANK_TTL_MS`).

**Next direction — personalized PageRank / k-hop candidate-recovery (DEFERRED 2026-06-02, premise invalidated).** Tiebreaker is the wrong abstraction; the IR literature backs **PPR or k-hop expansion seeded on first-stage hits** (candidate-recovery, not within-pool reordering). Steps (1) extend chunker and (2) verify graph edges are **done** (TS/JS edges live post-reindex; `BeyondError`/`ErrorCodes` recoverable). But before implementing (3), a design probe (`src/eval-graph-recovery-probe.ts`) showed all 10 platform "hard-miss" definition chunks are **already inside the top-200 fusion pool** (pool#1–#106) — there is nothing *outside* the pool to recover, so PPR/k-hop has no validatable target on the current fixtures. The in-pool ranking gaps it was meant to fix turned out to be a stale-instrument artifact plus a ranking issue, both since resolved (see the symbol-definition promotion entry below). PPR/k-hop is deferred until a fixture set with genuine outside-pool misses exists. See [2026-05-25-semantic-search-landscape.md](plans/2026-05-25-semantic-search-landscape.md) — Phase 3 section.

## Bare-symbol queries promote the symbol's definition over its usages

Added 2026-06-02 (v0.17.9). Implementation `src/lib/search/searcher.ts` — `asSymbolQuery` + the symbol-definition promotion (inject + ×5 boost).

A query that is a single bare identifier (`BeyondError`, `requireAuth`, `map`) is treated as a symbol lookup: the chunk whose `defined_symbols` includes the query is injected into the rerank set (so the stage-2 / `RERANK_TOP` cuts can't drop it) and multiplicatively boosted (`GMAX_DEF_BOOST`, default 5) so it outranks its own method-child chunks and wins overlap dedup. This fixed three distinct drop mechanisms on the platform set and lifted bench:oss hits@1 sharply (platform 7→14/15, lodash 4→9/10, express 5→8/9).

**Tradeoff / limitation:** for a bare-symbol query the **definition is promoted to the top**, ahead of usage/caller sites. This is the right default for "find X" (the overwhelmingly common intent), and usages still rank below — but if you specifically want callers, use `gmax trace --inbound <symbol>` or `gmax impact <symbol>` rather than a bare search. The promotion is **gated to single-identifier queries** via `asSymbolQuery`, so natural-language queries (anything with a space, dot, or punctuation) are completely unaffected. Disable per-process with `GMAX_DEF_BOOST=1` (neutralizes the score boost; injection still runs).

**Measurement note.** The same investigation fixed the OSS bench instrument (`eval-oss.ts` `chunkMatches`, v0.17.8): it now credits a file + `defined_symbols`-includes-query match, not just a line-range hit. Stale hand-curated `expectedLine` values had been scoring surfaced definitions as misses (platform recall read 0.333 vs a true ~0.800). Keep this in mind when comparing pre-v0.17.8 bench numbers in older entries above — they understate recall on symbol-lookup cases.

## LanceDB manifest references a missing fragment file

Verified 2026-05-07.

After an interrupted compaction, the LanceDB manifest can reference a fragment file (`<hash>.lance`) that no longer exists on disk. Symptoms in `~/.gmax/logs/daemon.log`:

```
[watch:<project>] DATA CORRUPTION: LanceDB manifest references a missing fragment.
Backing off this project's batch processor for 30 min. To repair, run: gmax index --reset
```

The daemon's batch processor (since v0.16.0, commit `fd05089`) detects this via `isLanceCorruptionError()` and backs off for 30 minutes per affected project, logging once per hour. Read-path queries (search/peek/extract/etc.) continue to work — only the write path (incremental reindex) is paused.

**Impact:** New file changes in the affected project stop being indexed until repair. Search results gradually go stale.

**Recovery:**
```bash
cd <affected-project-root>
gmax index --reset
```

This rebuilds the project's vectors from scratch. For a 100k-chunk project on Apple Silicon, expect ~5–15 minutes.

**Detection (manual):**
```bash
grep "DATA CORRUPTION" ~/.gmax/logs/daemon.log | tail
```

**Fix:** None planned. Compaction interrupts (laptop sleep mid-write, kill -9, disk pressure) are rare enough that the detect-and-back-off behavior is sufficient.
