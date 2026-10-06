---
type: doc
status: reference
created: 2026-04-09
updated: 2026-10-05T02:53:16Z
summary: Live catalog of open gmax limitations with detection + recovery steps.
audience: internal
related_plans:
  - archived/2026-07-09-repository-audit-fixes.md
  - docs/plans/2026-05-25-semantic-search-landscape.md
  - docs/archived/2026-06-23-index-versioning-and-daemon-refactor.md
  - docs/archived/2026-06-28-repo-audit-hardening.md
  - docs/archived/daemon-read-path.md
  - docs/archived/lancedb-0.38-upgrade.md
related_docs:
  - archived/agent-ux-proposals.md
  - docs/agent-pov-suggestions.md
  - docs/2026-08-04-performance-review.md
  - docs/2026-07-09-repository-audit.md
  - docs/2026-08-04-macos-kernel-zone-panic-incident.md
  - docs/2026-08-25-release-triage-retrospective.md
---

# Known Limitations

Last updated 2026-10-06.

## Small result lists preserve ranks; relevance still needs validation

v0.26.48 fixes a result-window bug: requesting one or three matches used to discard candidates before structural scoring, so a ten-result request could reveal better matches missing from the short list. Search now ranks the already bounded candidate pool before applying the requested result count, while preserving the expensive rerank and final display-fetch bounds. Regression tests and six installed real-query comparisons verify consistent short-result prefixes within the same retrieval pool.

This does not make every top match relevant. For example, a natural-language query about cancelled MCP requests still ranked daemon restart code first, and some search-pipeline queries ranked experiment/test scripts ahead of production code. Validate discovery results with extract/peek and record real misses across repos before changing weights, embeddings or retrieval mechanisms. Approximate vector search remains disabled by default after its earlier recall acceptance failure; an absent ANN index in doctor is expected.

## Historical retrieval MRR figures used a wider cutoff

Resolved in v0.26.49, released October 5. Both `src/eval.ts` and `src/eval-oss.ts` still request 20 results for diagnostics, but per-case `rr` and the aggregate `mrrAt10` now credit only ranks 1–10. Late matches keep their actual ranks and found/hit counts; Recall@10 and matching rules are unchanged. Twenty-one synthetic tests cover ranks 1, 10, 11, 20, missing/empty responses, duplicate matches, internal avoid paths and OSS definition/line matching. Six cutoff/aggregate regressions failed before the fix.

Historical tables below preserve their originally reported figures, which may include reciprocal-rank credit beyond ten. They are not corrected MRR@10 acceptance evidence; rerun or rescore original per-query results before comparing with the corrected harness.

For a true rerank-off baseline, set `GMAX_CONCENTRATION_THRESHOLD=2`: disabling explicit rerank does not prevent concentration-triggered ColBERT. Record fixtures, source, embedding/index identity, scope and ranking configuration with new measurements.

The October 4 multi-repository fixture measured 40 source-curated cases with frozen declaration targets: 57.5% target Recall@10 and 0.3275 corrected MRR@10. Four apparent misses returned useful bodies without declarations; other queries have plausible alternate answers. These figures are not general semantic answer quality or observed-session miss rates. Preserve v1 and review answer spans/alternatives in a successor fixture before tuning.

The v0.26.48 baseline daemon did not expose fusion-pool membership or actual concentration-gate activation. v0.26.49 ships opt-in, capability-gated diagnostics for up to 200 post-seed fusion candidates and their stage ranks, effective settings, FTS health and actual gate/rerank invocation. It preserves default responses/results and adds no database reads. A target missing from a truncated trace is not proof of full-pool absence. Three registry-installed live queries verified bounded diagnostic output and result/score equivalence. Old baseline artifacts retain their unknowns; this smoke is not a new relevance measurement.

`scoreBreakdown.rerank` stores the fallback base score when reranking is off, so a nonzero value does not prove reranking occurred. Changing a benchmark client's environment does not change a running daemon's ranking settings. Use explicit invocation diagnostics with the [frozen baseline runner](../README.md#frozen-multi-repository-baseline), rather than asserting a fully disabled rerank comparison from score components or selected-batch membership.

## Per-file diversity can hide scored matches

Installed .49 diagnostic triage confirmed three targets were retrieved and scored but removed by the default three-matches-per-file cap. Three other targets were cut by pooled selection; two more were outside the truncated trace and remain unknown. The reviewed successor is exposed development evidence, with changed answer criteria and two scoped queries; its 72.5% target Recall@10 is not a before/after improvement or independent quality acceptance.

An offline replay reproduced every original final result and tested caps four/six without changing live settings. Larger caps recover some targets but also push another target beyond ten and reduce file diversity. Keep the default until independently reviewed evidence supports a policy change. In v0.26.49, CLI `--per-file` only limits rendered output, so it cannot recover already-suppressed chunks. Fixed in released and installed v0.26.50: an explicit positive safe integer travels through CLI, IPC, local fallback and optional loopback HTTP to the searcher. Omitted requests retain the configured cap or three, and concurrent requests do not mutate global settings. Installed concurrent caps six/one, subsequent default restoration and CLI expansion passed. Explicit overrides require `perFileSearch: 1`; incompatible live daemons refuse before search rather than opening another reader. Update the runtime and running daemon before using the override. This user control does not resolve pooled cuts or establish a better default ranking policy.

Source `bench:relevance` now supports explicit target `match: "range"` to prevent same-symbol declarations from bypassing answer spans. The legacy matching default remains unchanged. Range overlap measures useful discovery context, not complete answer coverage; the full frozen v1 remains intact.

## MCP cancellation has native-operation boundaries

v0.26.47 forwards each client's cancellation signal to daemon graph, row and search reads. Aborting closes only that request's Unix IPC connection, allowing daemon admission/worker cancellation to stop queued work. New tool operations and fallback admission check the signal; other requests and session watch renewal continue.

An already-running local native operation is awaited under existing query deadlines before its store closes. Cancellation does not roll back indexing writes or interrupt optional LLM workflows. Progress is opt-in through the client's progress token and counts started operation stages, without an estimated percentage or heartbeat timer. Cancellation errors are recorded by the existing query log only when queryLog is enabled (disabled by default).

## Whole-corpus embedding rebuild is disruptive

Added 2026-07-10 during repository-audit remediation.

`gmax repair --rebuild` is available as an explicit guarded operation. It rebuilds every registered
project and replaces the shared physical table, so it is intentionally daemon-only, capability
negotiated, and never used as an automatic fallback. It is not a zero-downtime migration.

Projects now persist the exact ONNX, MLX, ColBERT, vector-width, and generation-fingerprint identity
used by successful full syncs. `gmax config`, `gmax list`, `gmax status`, `gmax doctor`, serve stats,
and MCP status distinguish configured identity from built identity and report `current`, `legacy`,
`stale`, or `unbuilt`. A stale model generation, including a same-width model change, is rejected
before search or sync mutation; existing rows are preserved.

**Operational guidance:**

- Expect searches and indexing to return busy while the rebuild owns exclusive admission.
- If configuration was changed, inspect configured versus built identity with `gmax config`,
  `gmax status`, or `gmax doctor`, then run `gmax repair --rebuild` when whole-corpus replacement is
  intended. Restoring the prior configuration remains the non-destructive alternative.
- Preserve a corrupt store and logs for diagnosis before invoking destructive repair.
- A disconnected client cancels before drop; after drop the daemon continues from its durable rebuild
  journal. Re-running the command resumes an unfinished rebuild.

## `gmax surprises` is experimental orientation, not proof

Added 2026-06-30.

`gmax surprises --experimental` and MCP `surprising_connections` report file pairs that are
embedding-similar, cross-directory, and not directly connected by gmax's indexed static symbol
graph. That is an orientation signal for duplicate/parallel logic, not a correctness claim.

**Limitations:**
- "No graph edge" only means no direct edge was found in `referenced_symbols` /
  `type_referenced_symbols` for the current index. Dynamic dispatch, reflection, string-built
  calls, callback-value references, ambiguous definitions, and stale indexes can all hide real
  relationships.
- High embedding similarity can be boilerplate, wrappers, constants, formatter helpers, or shared
  framework shape rather than a refactor opportunity.
- Scores are heuristic even after calibration. Keep `--experimental`: measured quality varies by
  corpus, and generated/offline-help content still needs explicit `--exclude` scopes in some repos.
- On narrow monorepo scopes, the default `--dir-depth 3` may treat the whole scope as one bucket;
  increase `--dir-depth` when using `--in packages/app/src`-style scopes.

**Recovery / validation:**
Use the output as a triage queue. Before acting, inspect both sides with `gmax skeleton`,
`gmax extract`, `gmax related`, and `gmax trace`.

## Static graph misses callback-value and dynamic references

Added 2026-05-26. Confirmed during Bundle B G1' Phase 0 sanity check.

**Current status (2026-08-04).** Identifier-as-value and type-position coverage now spans
supported grammars. The remaining blind spots are bare callback values, dynamic dispatch,
reflection, decorator/framework routing, and string-built calls. The older evidence below is
retained to explain the shipped extraction work, not as a description of current class/type coverage.

**Mostly fixed 2026-06-02 (all 14 grammars).** The chunker now emits identifier-as-value edges for `new ClassName(…)` / `ClassName{…}`, `instanceof ClassName` / `x is T`, and `Enum.MEMBER` / `Enum::MEMBER` (member/scope access gated to a Capitalized leaf head) across **every grammar** — TS/JS plus Python, Go, Rust, Java, C#, Ruby, Kotlin, Swift, Scala, PHP — via grammar-keyed node-type dispatch in `chunker.ts::extractRefs`. Verified on real platform source: `BeyondError`/`ErrorCodes` produce `referenced_symbols` edges in their caller chunks and `GraphBuilder.buildGraph` surfaces those callers (`tests/graph-edges.identifier-as-value.test.ts`); the other 10 languages each get a class+enum edge in `tests/graph-edges.identifier-as-value.multigrammar.test.ts`. Real-Rust spot-check (`dirplayer-rs/.../sprite.rs`): 12/16 def-chunks gained clean `ColorRef`/`Sprite`/`CastMemberRef` edges, all previously absent. TS/JS read-only A/B over the platform corpus: +1.1% `referenced_symbols` bytes, 0% embedded-content growth.

Corpus-wide chunk-level density (eval-graph-totals reproduced fan-free over 121k platform TS/JS chunks; `ref-chunks` is a pure chunking property, so no reindex needed to measure it):

| Target | Shape | Before | After |
|---|---|---|---|
| `BeyondError` | class (`new`/`instanceof`) | 0 | **12** |
| `ErrorCodes` | enum (`.MEMBER`) | 0 | **62** |
| `resolveActor` | ordinary call (already-covered shape; current code references `resolveActorV2`) | 0 | 0 |
| `errorHandler` | callback-as-value (out of scope) | 0 | 0 |

The two in-scope class/enum targets go from an empty graph to real caller edges. The other two were mis-grouped in the original Phase-0 set: neither is an identifier-as-value class/enum reference.

**Remaining work:** PPR/k-hop candidate recovery is deferred until a frozen fixture demonstrates genuine outside-pool misses. Existing reference edges already support navigation, seed boosts and opt-in graph ranking; the earlier claim that no query-time consumer reads them is obsolete. Bare callback values and dynamic references remain limitations of the static graph.

Identifier-as-value and type-position extraction shipped in June and are included in the current chunker generation. Old instructions to manually stamp v3 registry entries or repeat the June corpus reindex do not apply. Inspect `gmax doctor` for the current project's chunker state before taking corrective action. June evidence about narrower language edge cases is historical, not a fresh cross-language acceptance run.

**Historical baseline (May 2026, before the shipped extraction fixes above).** The chunker wrote `referenced_symbols` per chunk to support `gmax trace`, `gmax dead`, and graph-derived ranking signals. At that time the extraction tracked **call-expression callees** — names that appear in a syntactic call position. It did **not** track identifier references that weren't calls: class names used as values (`new BeyondError(…)`, `instanceof BeyondError`, `throw new ValidationError(…)`), constants/enums referenced as values (`ErrorCodes.NOT_FOUND`, `ErrorCodes.VALIDATION`), or types referenced in expression position.

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

## Stale-index reindex nudge (a+b+c shipped 2026-06-22; `doctor --fix` reindexes)

Added 2026-06-22; **fix built same day** (a+b+c, plus `doctor --fix` reindex — see end).

When the chunker's metadata semantics change (new edge kinds, new columns), existing indexes keep
their old data until a `gmax index --reset`. The signal is `CONFIG.CHUNKER_VERSION` (now **4**),
stamped per project at its last full index. Current registered projects report no stale chunker.

**What shipped:**

- **(a) Query-time hint.** `search`, `trace`, `dead`, `peek`, `impact`, `similar`, `related`, `test` now emit a one-line staleness nudge to **STDERR** when the resolved project's index predates `CONFIG.CHUNKER_VERSION`. Wired through one helper — `maybeWarnStaleChunker()` in `src/lib/utils/stale-hint.ts` — called once per command after the project root resolves. Never touches stdout, so `--json` / `--agent` machine output stays byte-identical; `--agent` renders a parseable `stale_chunker\t…` TSV record on stderr instead of prose. Suppress with `GMAX_NO_STALE_HINT=1`; fires at most once per process.
- **(b) Version with intent.** `CHUNKER_VERSION_HISTORY` + `describeChunkerGap()` (`src/config.ts`) replace the bare int's single hardcoded message. Each entry is `{v, severity: 'additive'|'breaking', note}`; the gap helper unions the notes for every version an index is missing and reports `breaking` if any missed version was breaking. `severity` sets tone — additive → `hint`/`INFO`, breaking → `WARN`. `gmax doctor` (human + `--agent`) and the hint both render from this one source. History: v2 = breaking (sub-chunk symbol scoping; graph overcounted callers before this), v3 = additive (type-position edges; `dead`/`trace` miss type-only callers until reindex).
- **(c) Bumped to 3** for the type-position edges (additive).
- **(d) Bumped to 4** for separately recorded member-call edges (additive).

Verified live: stale repos (lean/proctor/cram/quorm/dotmd/furni/cokemusic-extractor) nudge; the 5 repos reindexed on 2026-06-22 with the new chunker were re-stamped v2→3 in `~/.gmax/projects.json` (no reindex needed — they already carry the edges) and stay silent. `bench:oss` byte-identical (express 0.889 / lodash 0.900). Regression net: `tests/stale-hint.test.ts`.

**Detection / recovery:**
```bash
gmax doctor            # "INFO/WARN  Stale chunker: N project(s)…" with per-gap note + fix
gmax doctor --fix      # reindexes every stale project (--reset) and re-stamps it
```

**`doctor --fix` reindexes stale-chunker projects** (added 2026-06-22, closing the original residual gap). When the daemon is running, `--fix` runs a `--reset` reindex per stale project (routed through the daemon's streaming `index` command) and re-stamps each to `CONFIG.CHUNKER_VERSION` on success; if the daemon is down it falls back to printing the manual command. This is heavier than the other `--fix` remediations (stale-lock removal, compaction/prune, orphan cleanup), so it runs last. Verified 2026-06-22: a single `gmax doctor --fix` reindexed all 7 stale repos and `gmax doctor` then reported `stale_chunker=0`.

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

## Historical FTS merge panic is fixed; recurrence is a regression

The pre-upgrade LanceDB 0.30/0.31 runtime could panic in incremental FTS merge (`inverted/builder.rs`, index out of bounds). The investigation is preserved in [the closed upstream plan](archived/lance-fts-merge-upstream.md).

The upstream fix first shipped in gmax v0.26.23 using a beta overlay. The current runtime packages the pinned official LanceDB 0.39.0 GA JavaScript and matching native binaries at build time, including the fix. `scripts/postinstall.js` now only prints a plugin-update reminder; it no longer overlays LanceDB. The September 7–16 GA canary recorded zero optimize failures, FTS rebuilds or panics; see [the upgrade closeout](archived/lancedb-0.38-upgrade.md).

The drop-and-rebuild guard remains a recovery tripwire, with bounded optimize attempts and disk-headroom checks. `disabling auto-rebuild until an optimize succeeds` means repeated rebuilds are suppressed until a successful optimize. Failed FTS recovery can degrade retrieval to vector-only results; do not treat a fresh panic as harmless expected output.

If this recurs on a current release, preserve the installed version and daemon log, check `gmax status --json` and `gmax doctor`, and report a regression. Do not repeatedly force compaction or disable the recovery guard. Historical successful recovery is not a guarantee of availability or data integrity for a new failure.

## Compaction reservation versions can retain a full data copy

Reproduced October 6 in a temporary native store: one rewrite changed data bytes from 120,892 to 200,063 despite deleting old files. The surviving intermediate reserve-ID version referenced all three original fragments, while the final version referenced one new fragment. LanceDB 0.39 correctly preserves both because they were committed after the supplied start-time cutoff. A subsequent no-rewrite optimize removed the intermediate version and left 86,200 data bytes.

The fix adds one bounded cleanup pass after a zero-retention rewrite, under the existing write gate. It verifies a single deletion-free fragment and an unchanged reopened version before using a real later cutoff. It preserves positive retention, checks fresh reserve headroom and never retries a cleanup failure or unexpected rewrite. Native regressions verify physical data bytes match the current manifest after three rewrites, with row/FTS integrity; guards cover queued writes, changed versions, deletion metadata, retention, clocks, space and failures.

Cleanup is deferred when the table still has multiple fragments or the evidence is unavailable. The Node SDK does not expose a prune-only operation; do not bypass this guard with a future cutoff, manual file deletion or an unbounded sequence of rewrites. The existing maintenance bloat retry remains bounded. Net physical reclamation is now recorded separately from gross native bytes deleted, so a successful operation with net growth is visible.

## Fresh unreferenced fragments can survive an idle-store cleanup

Verified October 6 against both LanceDB 0.38.0 and 0.39.0 in synthetic temporary stores. A copied, unreferenced data fragment created after the latest manifest survived optimize when the single-fragment table needed no rewrite. After a normal row update committed a newer manifest, optimize removed the copy and preserved the row. Lance limits its data-file listing using the earliest retained manifest timestamp; `deleteUnverified: true` does not remove that listing boundary.

This is an existing upstream cleanup limitation, not a 0.39 migration regression. Do not assume a successful optimize removed every orphan, repeatedly force maintenance, or mutate real rows solely to advance the manifest. Check physical size and read-only doctor diagnostics afterward; unresolved space remains an investigation item. The 0.39 native regression also verifies cleanup of five copies when compaction rewrites two fragments into one, along with FTS and reopen integrity.

LanceDB 0.39 fixes the separate [absolute cleanup cutoff bug](https://github.com/lancedb/lancedb/pull/4160): compaction no longer advances the supplied cutoff. Versions committed after that timestamp, including versions created during optimize, remain eligible for retention. gmax retains its write gate, fresh snapshot per retry, two-attempt limit and fresh disk-reserve checks.

## LanceDB manifest references a missing fragment file

Verified 2026-05-07.

After an interrupted compaction, the LanceDB manifest can reference a fragment file (`<hash>.lance`) that no longer exists on disk. Symptoms in `~/.gmax/logs/daemon.log`:

```
[watch:<project>] DATA CORRUPTION: LanceDB manifest references a missing fragment.
Backing off this project's batch processor for 30 min. Preserve the store for diagnosis before
running guarded whole-corpus repair.
```

The daemon's batch processor (since v0.16.0, commit `fd05089`) detects this via `isLanceCorruptionError()` and backs off for 30 minutes per affected project, logging once per hour. Read-path queries (search/peek/extract/etc.) continue to work — only the write path (incremental reindex) is paused.

**Impact:** New file changes in the affected project stop being indexed until repair. Search results gradually go stale.

**Recovery:** Preserve the store and logs for diagnosis. Do not use a per-project reset as a
whole-store repair: the physical table and manifest are shared. Restore from a known-good backup or
run `gmax repair --rebuild` when destructive whole-corpus replacement is acceptable.

**Detection (manual):**
```bash
grep "DATA CORRUPTION" ~/.gmax/logs/daemon.log | tail
```

**Fix:** None planned. Compaction interrupts (laptop sleep mid-write, kill -9, disk pressure) are rare enough that the detect-and-back-off behavior is sufficient.

## Consumer dependency audits differ from repository audits

The previous release, v0.26.43, had four high consumer package findings propagated from sharp 0.33.5 through LanceDB's unused optional transformers 3.0.2 provider. The workspace production audit was clean because workspace overrides do not apply to consumers. The advisories were [libvips](https://github.com/advisories/GHSA-f88m-g3jw-g9cj) and [libheif](https://github.com/advisories/GHSA-rgj7-g3m4-5g8c). SDK 0.39.0 still kept the old optional pin, so an SDK version bump alone could not fix it.

Resolved in v0.26.44: the release packages the unchanged pinned SDK JavaScript runtime without its provider dependency manifest. Exact optional platform packages supply native Lance binaries; gmax's direct patched transformers supplies its text embedding path. Build-time pin checks, licenses and provenance keep this packaging reproducible. A fresh packed npm consumer audit reports zero vulnerabilities, and a native temporary-store smoke verifies the packaged runtime and bounded Session. Both checks passed locally and in v0.26.44 release CI, and gate future local releases and CI; the native fixture uses synthetic vectors and loads no model.

Keep the packed-consumer gate when changing dependencies. Do not omit all optional dependencies: native LanceDB platform packages are optional too. Direct transformers/onnxruntime-node now resolve patched sharp/adm-zip versions; repository-only overrides must never be treated as consumer protection.

Production npm audits also omit JavaScript development dependencies and the Python embedding
environment. Local preversion, CI and release gates now run full `pnpm audit` plus
`pnpm run audit:python`. The Python gate queries OSV for exact registry versions in `uv.lock`,
without installing packages or loading models, and fails if the query cannot complete. It
does not audit the local Python project or the pinned `mlx-embeddings` Git source, nor prove
that every advisory path is reachable. Installed Python environments still need synchronization
with the validated lock and a compatibility check after an upgrade.

## A recycled PID makes a reader lease immortal and hangs every exclusive operation

Found 2026-08-25 while removing four git worktrees that had been indexed as separate projects.
`gmax remove` hung indefinitely — four attempts, up to 4 minutes each, both with the daemon up
(IPC path) and with it down (direct path). Exit 124 every time, no output.

**What:** `~/.gmax/lancedb.lease/readers/` holds one JSON marker per process holding a shared read
lease. Any operation needing the exclusive lease — `gmax remove`, `gmax repair --rebuild` — waits
for those markers to drain. The sweep in `StoreLease.liveReaders` (`src/lib/store/store-lease.ts`)
probes each marker's owner and deletes it when the owner is gone, so a crashed reader is supposed
to be reclaimed on the next exclusive attempt.

**Cause:** `defaultProbeOwner` (`store-lease.ts:84-104`) returns early on any
`process.kill(pid, 0)` failure that is not `ESRCH`:

```ts
try {
  process.kill(owner.pid, 0);
} catch (error) {
  return (error as NodeJS.ErrnoException).code === "ESRCH" ? "dead" : "unknown";
}
```

A PID owned by **another user** throws `EPERM`, not `ESRCH`, so the probe returns `unknown` without
ever reaching the `processStart` comparison below it — the very check that exists to catch PID
reuse. `liveReaders` treats `unknown` as a live blocker and keeps the marker
(`store-lease.ts:524-529`). The marker is then permanent: nothing else ever removes it.

PIDs are recycled constantly, and macOS hands low PIDs to system daemons running as their own
service users. Once a stale marker's PID lands on one, the exclusive lease can never be acquired
again for the life of the store.

**Confirmed, not inferred.** The blocking marker on this machine claimed pid 924 started
`Fri Aug 21 15:12:12 2026`. PID 924 was by then `/usr/libexec/rosetta/oahd`, user `_oahd`, started
`Sun Aug 23 19:57:43 2026` — a provable recycle. Replaying `defaultProbeOwner` against it: `EPERM`
→ `unknown` → retained as a blocker. Had the `processStart` comparison been reached it would have
returned `reused`, which `liveReaders` already deletes correctly.

**Why it went unnoticed:** the readers directory had accumulated 15 markers, 14 of them from PIDs
that were genuinely dead — roles `gmax` and `gmax-daemon`, dating back to 11 July. Those 14 probe
as `ESRCH` → `dead` and would each have been swept on the next exclusive attempt. Only the single
`EPERM` marker was load-bearing. The pile-up is cosmetic; the one recycled PID is the outage.

**Detection:**

```bash
ls ~/.gmax/lancedb.lease/readers/ | wc -l    # any non-zero count with no gmax process running
for f in ~/.gmax/lancedb.lease/readers/*.json; do
  pid=$(python3 -c "import json,sys;print(json.load(open(sys.argv[1]))['pid'])" "$f")
  echo "$pid $(ps -o user=,lstart= -p $pid 2>/dev/null || echo DEAD)"
done
```

A marker whose PID resolves to a process owned by a user other than your own, or whose `lstart`
disagrees with the marker's `processStart`, is the blocker.

**Recovery:** stop the daemon, confirm no gmax process is running, then delete the stale markers.
They are reader markers only — no index data lives in them, and a live reader recreates its own.

```bash
pkill -f 'gmax-daemon|gmax-worker|gmax-embed'
rm -f ~/.gmax/lancedb.lease/readers/*.json
```

**Fix (implemented 2026-08-25, `defaultProbeOwner` in `store-lease.ts`; regression tests in
`tests/store-lease.test.ts`):** `EPERM` means the PID exists but is not signalable — it
does not mean the owner is alive. The `processStart` comparison already below the early return is
valid in that case and `ps -p <pid> -o lstart=` works across user boundaries. Move the reuse check
ahead of the signalability check, or fall through to it on `EPERM` instead of returning `unknown`.
Reserve `unknown` for the case where `ps` itself fails. A regression test wants a `probeOwner`
injection (the seam already exists — `StoreLeaseOptions.probeOwner`, `store-lease.ts:27`) asserting
that an `EPERM` owner with a mismatched `processStart` resolves to `reused`.

**Related, same session — the daemon ignored SIGTERM (and Activity Monitor's Quit).** Twice on
2026-08-25 (02:34:41 and 05:35:30) the daemon logged `Shutting down...`, `Unwatched` for every
project, and then nothing, sitting idle in `uv_run` until it was SIGKILLed. Both followed an
interrupted `gmax add`. The log places the stall at shutdown's drain of admitted operations
(`operations.close()` / `projectMutex.close()` — the worker pool was still reaping and respawning
minutes later, so teardown never got that far). Which operation failed to settle after its abort
is not recorded — every stage of the add path is abort-gated on paper, and the store lease wait
that blocks `remove`/`repair` is only cancelled by `vectorDb.close()`, which ran *after* the drain.

Fixed in v0.26.22 on three levels, so the exact wedge no longer matters for exit: shutdown now
fires `VectorDB.abortLeaseWaits()` before draining; the drain is bounded
(`GMAX_SHUTDOWN_DRAIN_TIMEOUT_MS`, default 30 s) and logs the names of the abandoned operations and
the roots whose project locks were still held; and the SIGTERM/SIGINT handlers arm a 90 s hard-exit
backstop. If the drain timeout fires, its log line is the root-cause capture this incident lacked.

## Sandboxed shells cannot reach the store without two settings keys

Added 2026-09-07 from a live report: `Test find failed: EPERM: operation not permitted, mkdir
'~/.gmax/lancedb.lease.lock'` from a Claude Code Bash tool call.

**What:** Claude Code's Bash sandbox (the default on macOS) allows writes only under the working
directory, the added directories, and the session temp dir, and blocks every Unix socket unless
`sandbox.network.allowUnixSockets` lists it. Child processes inherit the profile, so every gmax
command an agent runs is inside it.

That collides with both of gmax's read paths at once. A read command prefers the daemon over
`~/.gmax/daemon.sock` — a blocked socket. With no daemon it opens the shared store itself, and
opening the store takes a `StoreLease`, which mkdirs `~/.gmax/lancedb.lease.lock` and a reader
marker under `~/.gmax/lancedb.lease/readers/` — a blocked write. A read is a writer as far as the
filesystem is concerned, which is why "it only reads" is not a reason to expect it to work.

**Under the default profile** (writes to `~/.gmax` denied, sockets denied), reproduced with
`sandbox-exec` before the fix: search reported `Daemon search failed: EPERM`, `test` and `peek`
failed on the lease mkdir, and `status` crashed inside `lmdb` `env.open` — LMDB needs its lock file
even to read, so the watcher-registry open failed before `status` reached any guard.

**Fix (0.26.28):** both denials are classified in `src/lib/utils/store-access.ts` and answered with
one line and exit code 2 instead of an errno. `gmax doctor` reads `~/.claude/settings.json`,
`~/.claude/settings.local.json`, and the project's `.claude/settings*.json`, and warns before the
command is ever run.

**Configuration:**

```json
"sandbox": {
  "network": { "allowUnixSockets": ["~/.gmax/daemon.sock"] },
  "filesystem": { "allowWrite": ["~/.gmax"] }
}
```

The socket key is the one that matters: with it, every read command works through the daemon. The
write key only covers the in-process fallback, which runs when no daemon exists (autostart
disabled, CI) — grant it if you want gmax to work with the daemon down, skip it otherwise.

**Linux has no per-socket allowance.** Only `"network": { "allowAllUnixSockets": true }` exists
there, so the choice is all Unix sockets or none. The client message names the macOS key on every
platform; on Linux read it as "allow Unix sockets", and `gmax doctor` prints the
`allowAllUnixSockets` form in its snippet.

**gmax never writes these files.** `gmax doctor --fix` deliberately does not edit Claude Code
settings — a tool that rewrites another tool's permission configuration to widen its own access is
not a tool anyone should have to audit. The check prints the snippet; a human pastes it.

**Detection:** `gmax doctor` (`WARN  Claude Code sandbox`), or `gmax doctor --agent`, which emits
`claude_sandbox\tenabled=…\tsocket=…\twrite=…`. To reproduce the denials outside Claude Code, run
`scripts/sandbox-smoke.sh` (macOS only, manual — CI is `ubuntu-latest`).
