---
type: doc
status: reference
created: 2026-04-09
updated: 2026-05-26T14:00:00Z
summary: Live catalog of open gmax limitations with detection + recovery steps.
audience: internal
---

# Known Limitations

Last updated 2026-05-26.

## Chunker `referenced_symbols` extracts call-expression names, not identifier-as-value references

Added 2026-05-26. Confirmed during Bundle B G1' Phase 0 sanity check.

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

**Not a fix-target right now.** Fixing it means revisiting tree-sitter capture queries per-language (TS/JS, Python, Go, Rust, Java, C#, Ruby, Kotlin, Swift, Bash, Scala — 11+ grammars) to also capture identifier references in expression position, while keeping the existing call-expression coverage. That's substantial scope and a measurement open question (does denser ref extraction improve downstream consumers enough to justify the chunk size growth?). Reopen if a concrete consumer (e.g., an agent that hits the dead-call-by-class-name pattern often enough to matter) provides demand evidence.

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
- **Identifier-as-value references** — `new ClassName(…)`, `instanceof ClassName`, `Enum.MEMBER`, types in expression position. The chunker tracks call-expression callees only; see the "Chunker `referenced_symbols`…" entry above.
- **Cross-language calls** — a Python caller of a TypeScript exported function (and vice-versa) — graph is built per-language.
- **External consumers** — anything outside the indexed project tree.

Exported public-API symbols correctly downgrade to `PUBLIC EXPORT — no internal callers found; check external usage` when the defining chunk has `is_exported === true`. Treat `DEAD` as a starting point for removal, not a green light. Cross-check with `grep -r <symbol>` before deleting.

**Not a fix-target:** the prompt-doc anti-scope explicitly rules out detecting dynamic-dispatch or string-call sites — both are hard to define correctly. The output is "the call graph as indexed shows N callers"; the user judges what that means.

## ColBERT rerank is opt-in (shape-sensitive: helps monolithic files, hurts modular repos)

Added 2026-05-25 (v0.17.1). Refined 2026-05-25 with OSS-fixture evidence.

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

**Where the default lives:** `src/lib/search/searcher.ts` — `doRerank = _search_options?.rerank ?? false`. CLI and MCP wrappers read `process.env.GMAX_RERANK === "1"`.

**Not a fix-target right now.** A "candidate-concentration heuristic" — auto-enable rerank when the top-K candidates concentrate ≥80% in one file — would be the principled fix but requires more measurement work. Revisit if user reports of monolithic-file repos come in.

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

**Not a fix-target right now.** Tiebreaker is the wrong abstraction; per the plan-doc G1' note, the path with literature backing is **personalized PageRank or k-hop expansion seeded on first-stage hits** (candidate-recovery, not tiebreaker). That's a different feature, unscoped until an agent-side request makes the hard-miss pattern urgent. See [2026-05-25-semantic-search-landscape.md](plans/2026-05-25-semantic-search-landscape.md) — Bundle B section.

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
