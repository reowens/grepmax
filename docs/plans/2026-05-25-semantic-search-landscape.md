---
type: plan
status: partial
created: 2026-05-25
updated: 2026-08-04
surfaces:
  - search
  - graph
  - index
audience: internal
related_docs:
  - docs/known-limitations.md
  - ../archived/agent-ux-proposals.md
  - docs/agent-pov-suggestions.md
related_plans:
  - docs/archived/2026-06-23-index-versioning-and-daemon-refactor.md
  - docs/plans/embedding-reembed-atomic-cutover.md
current_state: >
  Core reliability, graph extraction, generated-code exclusion, partial-index signaling,
  MCP graph tools, review risk, audit, seeding, concentration gating, definition promotion,
  and chunker-v4 staleness handling are shipped. PPR still has no genuine outside-pool miss
  to recover. The remaining tail is measurement-gated, so this plan is partial rather than active.
next_step: >
  No active build target. Reopen PPR only for a correct chunk outside the top-200 fusion pool;
  reopen HyDE/query expansion for held-out real recall gaps; reopen semantic cache for measured
  repeat-query latency; reopen seeded indexing for observed monorepo cold-start pain.
summary: Measure-first decision record for shipped semantic-search work and explicitly gated successor experiments.
---

# Semantic Search - Measure-First Decision Record

> Bundle A reliability hardening shipped (v0.17.0–v0.17.3); v0.17.4 shipped agent-context/output parity followups. Bundle B's three graph-as-ranking-signal mechanisms (ColBERT rerank, global PageRank tiebreaker, graph-walk recall recovery) all returned negative against the 4-fixture instrument. The forward path depends on richer graph extraction in the chunker — Phase 1 is the keystone, everything else either stacks on it, is independent, or is small.

## Historical Release Note

NOTE: on upgrade, existing users' indexes flag stale (chunker v3) → they get the query-time nudge and `gmax doctor --fix` reindexes. ---- CURRENT (2026-06-22, latest5) — CHUNKER-VERSION STALENESS NUDGE (a+b+c) SHIPPED + LIVE. Built all three: **(a)** query-time hint via one helper `maybeWarnStaleChunker()` in `src/lib/utils/stale-hint.ts`, called once per command after root resolution in search/trace/dead/peek/impact/similar/related/test — emits ONE line to STDERR only (stdout / `--json` / `--agent` stay byte-identical), `--agent` renders a parseable `stale_chunker\t…` TSV record on stderr, suppressible `GMAX_NO_STALE_HINT=1`, once-per-process latch. **(b)** `CHUNKER_VERSION_HISTORY:[{v,severity,note}]` + `describeChunkerGap()` in `src/config.ts` replace the bare-int single hardcoded message — gap helper unions the notes for every missed version and returns `breaking` if any missed version was breaking (severity sets tone: additive→`hint`/`INFO`, breaking→`WARN`); `gmax doctor` (human + `--agent`) and the hint both render from this one source. History: v2=breaking (sub-chunk symbol scoping; overcounted callers before), v3=additive (type-position edges; dead/trace miss type-only callers until reindex). **(c)** bumped `CONFIG.CHUNKER_VERSION` 2→3. RE-STAMP DONE: the 5 repos reindexed last session with the new chunker (gmax/capstone/platform/dirplayer-rs/stripes) were re-stamped v2→3 in `~/.gmax/projects.json` (already carry the edges, no reindex) so they stay silent; the 7 genuinely-stale repos (lean/proctor/cram/quorm/dotmd/furni/cokemusic-extractor) correctly nudge. VERIFIED LIVE: stale repo → stderr hint + clean stdout; fresh repo silent; `GMAX_NO_STALE_HINT=1` suppresses; `--agent` TSV; `gmax doctor` human shows `INFO Stale chunker: 7 project(s)…` with per-gap (v2→v3, additive) note + fix path; `--agent` emits `stale_chunker=7` + per-project `stale_chunker_project` lines. 494 tests (was 482; +12 `tests/stale-hint.test.ts`), typecheck clean, bench:oss byte-identical (express 0.889 / lodash 0.900). Deployed: pnpm build → rsync dist→global grepmax → daemon restart on new code. FOLLOW-UP (same session, closed the residual gap): `doctor --fix` now ACTUALLY reindexes stale-chunker projects — `--reset` per project via the daemon streaming `index` command + re-stamp to `CONFIG.CHUNKER_VERSION` on success (falls back to printing the manual cmd if the daemon is down); runs last in `--fix` since it's the only heavy remediation. VERIFIED LIVE: one `gmax doctor --fix` optimized (34→1 frags, freed 8GB) then reindexed all 7 stale repos (lean/proctor/cram/quorm/dotmd/furni/cokemusic-extractor), `gmax doctor` then reports `stale_chunker=0`, all 12 registry repos now v3. Commits NOT YET MADE for this work (working tree has the changes); prior type-position commits 7851359 + 7255880 also still NOT pushed (origin behind) — decide push timing with user. ---- CURRENT (2026-06-22, latest4) — TYPE-POSITION CLUSTER FULLY DONE + LIVE; NEXT IS THE CHUNKER-VERSION STALENESS-NUDGE (a+b+c, APPROVED, deferred to next session). Reindex complete: gmax-self + the 4 chosen non-TS beneficiaries (capstone Python, platform polyglot 9058 files, dirplayer-rs Rust, stripes Swift) `--reset`-reindexed on the live new daemon; type edges verified present per-grammar (Swift 63% / Rust 63% / Python 38% of chunks carry type edges) and navigation confirmed end-to-end — `gmax trace --inbound PrinterRegistry --root stripes` (Swift) and `ICastMemberRef --root dirplayer-rs` (TS) surface pure type-position callers (`let registry: PrinterRegistry`, `field: ICastMemberRef`) the old call-graph missed. Commits on main, NOT pushed: 7851359 (Python Shape 6 + eval-graph-nav FIXTURE_FILES), 7255880 (remaining grammars + `tests/graph-edges.type-position.multigrammar.test.ts`). 482 tests, bench:oss byte-identical (express 0.889 / lodash 0.900). **NEXT — build the chunker-version staleness nudge (a+b+c), approved this session, see `docs/prompts/resume-chunker-version-nudge.md`:** the "tell users to reindex when chunk semantics change" mechanism is thin — `chunkerVersion` is read ONLY by `gmax doctor` (the 5 query commands don't check it), `doctor --fix` only PRINTS the reindex instruction (no auto-fix), the WARN text is hardcoded "may overcount callers" (wrong for additive changes), and we skipped the bump on the last 3 chunk changes. Fix: (a) query-time staleness hint to stderr from search/trace/dead/peek/impact when a project's `chunkerVersion < CONFIG.CHUNKER_VERSION` (suppressible `GMAX_NO_STALE_HINT=1`, structured field in `--agent`, once per invocation); (b) replace bare `CHUNKER_VERSION` with `CHUNKER_VERSION` + `CHUNKER_VERSION_HISTORY:[{v,severity:'additive'|'breaking',note}]` so doctor + the hint render the right message and severity sets tone; (c) bump to 3 (additive: type-position edges). **GOTCHA:** the 5 repos reindexed this session were stamped `chunkerVersion=2` (current value), so bumping to 3 would falsely flag them — re-stamp gmax/capstone/platform/dirplayer-rs/stripes to 3 in `~/.gmax/projects.json` (they already have the edges; no reindex). ---- CURRENT (2026-06-22, latest3) — ITEM (3) OTHER GRAMMARS DONE (code+tests; NOT yet reindexed). Discovery probe confirmed the key insight: Shape 4 fires on `type_identifier` for ANY grammar, so Go/Rust/Java/Kotlin/Scala/Swift ALREADY captured type positions for free (now benched). Only C# (`identifier`/`generic_name`) and PHP (`name` in `named_type`) had no `type_identifier` → extended Shape 6 to them (generalized `harvestPyTypes`→`harvestTypeLeaves` over `{identifier,name}` leaves; C# positions: parameter/property/variable `type`, method `returns`, `base_list`; PHP: simple_parameter/property `type`, function/method `return_type`, `base_clause`/`class_interface_clause`). New regression net `tests/graph-edges.type-position.multigrammar.test.ts` (8 grammars × param/return + C#/PHP heritage). 482 tests, bench:oss byte-identical (express 0.889 / lodash 0.900 — changes are lang-gated to python/c_sharp/php). Discovered (NOT fixed, pre-existing + out of scope): C++ `getNodeName` names a function after its return type (so return-type edge dropped); Ruby is dynamically typed (no annotations); C#/PHP namespace-qualified types over-capture PascalCase segments (harmless dangling edges); C#/PHP method CALLS (`invocation_expression`/`function_call_expression`) aren't in the call-edge shape, and the JSX post-regex mistakes `List<Foo>` for `<Foo>` (both pre-existing, referenced_symbols only). REMAINING for this cluster: rebuild+sync global + restart daemon (currently on the Python-only build) + ONE `--reset` reindex per repo to make C#/PHP/incidental-grammar edges live — reindex SCOPE is a user decision (capstone Python 58k, platform polyglot 133k, dirplayer-rs Rust, stripes Swift, etc. are the beneficiaries; gmax-self has no non-TS-non-Python files so its reindex only re-confirms). ---- CURRENT (2026-06-22, latest2) — PYTHON TYPE-POSITION SHIPPED + MADE LIVE; plan items (1) make-it-live and (2) Python DONE. Shape 6 in `chunker.ts` (commit 7851359): Python has NO `type_identifier` node (it spells type names as plain `identifier`), so Shape 4 couldn't see them; Shape 6 harvests Capitalized names from each annotation's `type`-field subtree — parameter/return/variable annotations + `class C(Base)` bases — gated to the Python grammar, into `type_referenced_symbols` (never `referenced_symbols`). MADE LIVE: rebuilt + rsync'd repo `dist` into the global `grepmax` install (no new deps), graceful daemon restart onto new code, `--reset` reindexed gmax-self only (44s; large repos untouched). VERIFIED: eval-graph-nav type-position recall 100% (incl. Python `EmbedRequest` 1/1, `EmbedResponse` 1/1), dead false-positives 0, caller-count guard PASS (referenced_symbols NOT inflated), bench:oss byte-identical (express 0.889 / lodash 0.900), 472 tests; live CLI `gmax dead`/`trace --inbound EmbedRequest` → server.py:170 (canonical Pydantic dead-FP closed). Also generalized eval-graph-nav's SELF-exclusion to a FIXTURE_FILES set (the type-position test embeds the fixture symbols as strings → was manufacturing phantom grep-truth callers). Edge-cases probed OK: PEP-604 unions, nested generics, qualified `models.Account`, decorated fns, methods. Known caveats (acceptable/documented): string forward-refs (`-> "Foo"`) missed; module-level `TypeVar`s leak a few `T`/`K` self-edges; module-level annotated vars OUTSIDE any def get no edges (general block-chunk behavior, not type-position-specific). NEXT — (3) OTHER grammars type-position as a batch. **KEY INSIGHT for that work:** Shape 4 fires on the `type_identifier` node type and is NOT actually TS-gated — Go/Rust/Java/Kotlin/Scala (which spell named types as `type_identifier`) very likely ALREADY get type edges incidentally (just unbenched); only `identifier`-in-type grammars (Python — done; possibly C#) need bespoke Shape-6-style handling. Cheap sequence: write a multi-grammar type-position UNIT test (mirror `tests/graph-edges.identifier-as-value.multigrammar.test.ts`) to DISCOVER which grammars already pass vs need code, then fill only real gaps. eval-graph-nav can only measure grammars with files IN the gmax repo (TS + the one Python server.py) — use the unit test for Rust/Go/etc. Resume prompt: docs/prompts/resume-type-position-grammars.md. ---- CURRENT (2026-06-22, latest) — BENCH-CONFIRMED NEUTRAL + CLASS HERITAGE SHIPPED. bench:oss A/B with the new chunker (express+lodash reindexed working-tree) reproduces the documented old-code baselines EXACTLY — **express 0.8889, lodash 0.900** → search provably neutral, the separate-column design holds. Class `extends Base` heritage now captured (commit fef8789, chunker Shape 5: the superclass is an `identifier`/value, not `type_identifier`; `implements I` + `interface extends Y` already worked). **TS/JS type-position nav is complete.** 467 tests pass. NEXT (priority order): (1) MAKE IT LIVE — rebuild/reinstall + restart the daemon, then `--reset` reindex repos; the feature is committed but the running daemon is on old code, so type edges only persist where manually reindexed (gmax-self + express/lodash bench fixtures). (2) PYTHON type-position capture — unlocks the Pydantic `: EmbedRequest` dead false-positive (the docs' canonical example at landscape.md:252 is Python, untouched by TS-only work); platform is polyglot so highest real payoff. (3) OTHER grammars (Rust/Go/Java/C#/Swift) as a batch like Phase 1, Capitalized-gated, with non-TS fixtures added to eval-graph-nav.ts. Still deferred: lowercase callback-value shape (real flood risk), Phase 10 search-rerank (needs its own route/guard fixture). Resume prompt: docs/prompts/resume-type-position-grammars.md. ---- CURRENT (2026-06-22, later) — TYPE-POSITION EDGES BUILT (TS/JS), candidate (a) DONE. After the gate below showed the gap, shipped the chunker work (commit 09d827e): Capitalized type-position refs (`: T`/`<T>`/`as T`/`extends T`/type aliases) now captured into a NEW `type_referenced_symbols` column — kept SEPARATE from referenced_symbols because the preplan found searcher.ts:312 + role classification read referenced_symbols.length in the DEFAULT search path (the deferral's "zero search cost" premise was wrong; a separate column makes it actually true). Navigation consumers (getCallers/impact/audit/llm-tools) union the two; schema auto-evolves existing tables (non-breaking) + new column in buildSchema; sub-chunk occurs() filter applied. Verified on a working-tree --reset reindex of gmax-self: **eval-graph-nav type-position recall 23% → 100% (22/22), dead false-positives 1 → 0, masked-by-export 2 → 0**, call-position recall unchanged (79%), caller-count guard still PASS (referenced_symbols not inflated), 465 tests pass, platform bench unchanged. **CAVEAT: not live in the daemon** — the running daemon uses old code; populate via rebuild/reinstall + restart, then a `--reset` reindex per repo (express/lodash not indexed on this machine, so bench:oss couldn't A/B them here — search-neutrality rests on the separate-column design + the type-position unit test). Remaining minor gaps: class `extends`/`implements` heritage (TS grammar uses `identifier`, not `type_identifier` — uncaptured); other 10 grammars (TS/JS only so far); bare-lowercase callback-value shape stays deferred (real flood risk). ---- CURRENT (2026-06-22) — NAVIGATION-PRECISION GATE BUILT (`src/eval-graph-nav.ts`): the fixture this plan deferred candidate (a) type-position refs behind ("only revisit … with a fixture to prove it") now EXISTS and MOVES. It's a self-maintaining gauge — live `git grep` call-vs-type classification vs `getCallers`, excludes its own file, exits 0. Reading on gmax: **call-position recall 79% vs type-position recall 23% (56-pt gap)**, 1 dead false-positive (`DeadResult` reported DEAD though LIVE), 2 masked-by-export (`EdgeDirection`/`ResolvedCaller`). ⇒ candidate (a)'s gate is SATISFIED for `trace --inbound`/`dead` navigation precision. DECISION PENDING: build chunker type-position edges (`: T` / `<T>` / `extends T` / `as T`) to close the gap, or accept it. Scope note: this nav gauge does NOT cover the Phase-10 search-rerank decision (that needs its own route/guard fixture; its premise check already said don't-build for search). Also shipped this session: caller-count regression guard added to `eval-graph-sanity.ts` (default mode) for the chunker chunk-explosion fix. ---- CURRENT (v0.17.18, 2026-06-03) — Phases 1/2/4/5/6/7/8/9 + pooled-ColBERT prefilter repair shipped this session (v0.17.10–v0.17.18); no reindex debt. BACKLOG OF BENCH-MOVING CANDIDATES EXHAUSTED — (a) premise-invalidated, (b) shipped, Phase 3/5 descoped; forward options are navigation-precision work (trace/dead) or new bets from the landscape reference doc. Phase 4 (Aider chat/file seeding) shipped v0.17.17 — agent-supplied `seed_files`/`seed_symbols` (MCP) + `--seed-file`/`--seed-symbol` (CLI), RRF candidate-gen bump relevance-gated by best retriever rank (maxRank 8), definition-preferring symbols; honest `eval-seed.ts` fixture 9/9 (route/recover on gmax, guards on immutable express), bench:oss byte-identical, 418 tests. Knobs: GMAX_SEED_FILE_W/_SYMBOL_DEF_W/_SYMBOL_REF_W/_MAX_RANK. BACKLOG OF BENCH-MOVING CANDIDATES EXHAUSTED this session: (a) type-position refs — **PREMISE-INVALIDATED 2026-06-03 (not built).** Premise check showed the default search path doesn't read `referenced_symbols` at all; the only two consumers are inert-by-default (seed boost) or off-and-proven-harmful (PageRank, regresses modular repos). The graph-recovery path that would have used these edges was descoped (targets already in-pool, landscape.md:147–155), and prior HIGHER-signal edge additions (new/instanceof/member-access) moved bench:oss by zero. Type-position edges are lower-signal + higher-volume → strictly worse on dilution, with flood risk concentrated on the already-misfiring PageRank signal + a full-corpus reindex cost. Only revisit if `gmax trace --inbound`/`dead` NAVIGATION precision is the explicit goal (not search), with a fixture to prove it. (b) pooled-ColBERT-cosine repair — **SHIPPED v0.17.18 (2026-06-03), fix fa5633b / bump 8caa5bb, pushed + npm-published + global-reinstalled + daemon-restarted.** Premise confirmed (pooled_colbert_48d all-zero 0/200k rows — Float32Array dropped over worker JSON-IPC at orchestrator.ts:346; pool.ts revives only the colbert blob). Fix: convert pooled to plain number[] before IPC (write-side) + read-side guard at searcher.ts:732 rejecting missing/short/all-zero vectors as -1. De-risk reindex of express+lodash bench corpora (0/1000→1000/1000 non-zero) showed ZERO bench:oss movement (recall@10/hits@1 identical; express-rerank mrr 0.7222→0.7196 noise) — correctness/latency fix only, NO global reindex forced; projects activate the live prefilter on natural reindex cadence. 418 tests pass. REMAINING open candidate: (a) type-position refs. Phase 3 PPR + Phase 5 seed-walker remain descoped. Resume prompt see docs/prompts/resume-semantic-search-backlog.md. ---- [prior next_step preserved] Phase 1 now covers ALL 14 grammars (2026-06-02) — identifier-as-value captures (instantiation / type-test / member-or-scope access) extended from TS/JS to Python, Go, Rust, Java, C#, Ruby, Kotlin, Swift, Scala, PHP via grammar-keyed node-type dispatch in `chunker.ts::extractRefs`; 10-language regression test (`tests/graph-edges.identifier-as-value.multigrammar.test.ts`), real-Rust spot-check (12/16 def-chunks gain clean ColorRef/Sprite edges), 360 tests pass, bench:oss unchanged. **Shipped v0.17.10 (2026-06-02)** — committed (067ec49), pushed, npm-published, global reinstalled, daemon restarted. **Corpus reindex COMPLETE (2026-06-02)** — every indexed non-TS repo `--reset`-reindexed so the multi-grammar edges are live: cram, lean, dirplayer-rs (Rust: `Datum`/`ScriptError`), stripes (Swift: `Printer`/`PrinterCalibration`), capstone (Python, 58k chunks: `BaseCalculator`/`AncillaryServiceType` enum member-access verified), and platform (159k chunks, polyglot Swift+Python+TS: `StayService`/`BeyondGraphQL` god nodes, status settled to watching). Verified each via `gmax audit --root <repo> --agent` + `gmax trace <Class> --inbound`. No code/release — operational only. Type-position refs + lowercase-callback shapes stay deferred (flood risk). Remaining open work below was: Phase 1 TS/JS landed AND verified corpus-wide (2026-06-02) — `new`/`instanceof`/`ClassName.MEMBER` edges in `src/lib/index/chunker.ts`; after a 155k-chunk `gmax index --reset` of platform, `BeyondError` 0→12 / `ErrorCodes` 0→62 ref-chunks, eval-graph-sanity withRef 0→12 for both (ranks 2 & 4), bench:oss no regression. Phase 2 (ColBERT concentration) shipped 2026-06-02 — gate in `searcher.ts`, threshold 0.7 global, lodash +0.15 MRR retained. **Phase 3 (PPR/k-hop) premise invalidated; pivoted to two shipped wins (2026-06-02).** A design probe (`eval-graph-recovery-probe.ts`) showed all 10 platform "hard-miss" defs are already in-pool (pool#1–#106) — nothing outside to recover, so graph-recovery stays deferred. The investigation instead shipped: (1) **instrument fix v0.17.8** — `eval-oss.ts` only credited line-range hits, masking real recall behind stale `expectedLine` values; now also credits a file + defined_symbols match. (2) **symbol-definition promotion v0.17.9** — bare-identifier queries now inject + ×5-boost the chunk that defines the symbol (gated via `asSymbolQuery`; NL queries untouched). **bench:oss recall@10/mrr/h@1: express →0.889/0.889/8, lodash →0.900/0.900/9, platform →1.000/0.947/14**; verified live via the daemon CLI; 349 tests pass; global reinstalled. Open work: extend Phase 1 captures to the other 10 grammars + lowercase/callback shapes (unblocks Phases 8/9); Phase 4 (Aider seeding), Phase 5 (seeded indexing), Phase 6 (partial results) all independent and pickable.

The note below records the chunker-v3 rollout. Current `CONFIG.CHUNKER_VERSION` is v4,
all registered projects report current chunker and embedding identities, and no v3 work remains.

## Roadmap Refresh - 2026-08-04

No active semantic-search build target remains. The remaining work here is measurement-gated
or opportunistic. Do not restart PPR, HyDE, query expansion, or semantic cache work without
new fixtures proving a recall miss or repeat-latency problem.

## Reopen Gate Matrix

| Mechanism | Required trigger and minimum fixture | Go threshold |
|---|---|---|
| PPR / k-hop | 20 real misses across >=4 repos and >=2 languages; correct chunk below fusion top-200; >=10 reachable from a top-20 seed within 2 hops; freeze 10 dev / 10 held-out. | Recover >=50% of reachable held-out misses; Recall@10 +0.10 absolute; no corpus loses >0.02 MRR; p95 overhead <=30% or 50 ms. |
| Static query expansion | 30 natural-language misses across >=4 repos and >=3 intent classes, excluding bare-symbol, scope, and stale-index failures; freeze 10 dev / 20 held-out. | Held-out Recall@10 +0.10 and MRR +0.05; no corpus loses >0.02 MRR; p95 <=1.25x baseline. |
| HyDE | Static expansion leaves >=15 held-out misses plausibly addressable by generated hypotheses; explicit in-session approval is required before loading any local LLM. | Beat static expansion by >=0.10 Recall@10; no corpus loses >0.02 MRR; ship opt-in unless an approved interactive SLO is met. |
| Semantic cache | >=500 real searches from >=10 sessions show >=20% normalized repeats within 5 minutes and repeated-query p95 >=150 ms. | Eligible-hit rate >=80%; warm p95 improves >=50%; zero stale results across >=25 mutation cases; <=64 MB/project. |
| Seeded indexing / cold tier | Three clean-index runs on each of two large monorepos show useful-search latency >15 minutes or completion >30 minutes. | Useful search <=5 minutes and >=3x faster; hot Recall@10 within 0.02 of full index; eventual parity and no cold-file starvation. |
| Merkle / chunk invalidation | Catchup p95 >60 seconds on a >=1M-file tree, or >=30 edits where <10% of chunks change but >90% are re-embedded. | >=3x scan improvement or >=80% fewer rewritten vectors, with byte-identical unaffected chunks and no missed updates. |

## Harness Prerequisites

Before opening any successor plan:

1. Fix MRR@10 accounting so ranks 11-20 do not receive reciprocal-rank credit.
2. Add shared pipeline diagnostics rather than copying a partial retrieval path into another probe.
3. Record commit, chunker/index generation, embedding identity, FTS health, scope, ranking env,
   and actual concentration/rerank gate firing in stable JSON.
4. Use a true rerank-off baseline (`GMAX_CONCENTRATION_THRESHOLD>1`); `{rerank:false}` alone
   can still enable ColBERT through concentration gating.
5. Freeze fixtures before implementation, reserve held-out cases, and fail the command nonzero
   when a declared threshold is missed.
6. Keep free-call, member-call, and type-edge policies separate in graph ablations.

Each triggered mechanism gets one focused successor plan with its fixture artifact, frozen
baseline, held-out set, thresholds, latency budget, ablations, and explicit abort outcome. Never
reactivate this omnibus. A PPR result is not evidence for global PageRank.

## Problem

After v0.17.x stabilization and the May 2026 competitive-landscape research (sverklo, Claude Context, CodeGraph, Aider, Cursor), there are concrete feature gaps and research follow-ups that haven't been expressed as a tracked plan. Asking "what's next" returns nothing actionable because the items have been living inside a reference doc. This plan re-surfaces them with shape-of-work, dependencies, and sequencing.

## Goals

- Each open item from the May 2026 landscape research (G1–G13) and the Bundle B post-mortem has a phase entry with shape-of-work and dependency.
- The chunker `referenced_symbols` keystone (Phase 1) is unambiguously named as the prerequisite for the graph-shaped work (Phases 3, 8, 9).
- The historical Bundle A/B findings are preserved as background so future sessions don't re-litigate the negatives.

## Non-Goals

These were evaluated against the May 2026 landscape and intentionally stay out of gmax:

- **G9 — Bi-temporal git-pinned memory** (sverklo's wedge). Different product class — memory layer, not code intel. Build separately if needed.
- **G10 — Pluggable embedding backends with multi-vector columns** (Claude Context). v1.x problem; one strong backend (MLX) + working fallback (ONNX) is enough now.
- **G12 — Cross-repo workspace impact** (sverklo `workspace init`). No demand signal observed. Re-evaluate if a real user asks.
- **G13 — VS Code semantic index sharing (LSP-ish API).** No current consumer.

## What Exists Today

### Shipped (v0.17.0 → v0.17.9)

| Release | What |
|---|---|
| v0.17.0 (2026-05-25) | IPC heartbeat; worker error-event handling; eval harness JSON output (`pnpm bench:recall`); ColBERT IPC serialization fix |
| v0.17.1 (2026-05-25) | ColBERT default → off; MLX health-recovery loop; worker reap SIGKILL escalation |
| v0.17.2 (2026-05-25) | `gmax dead <symbol>`; 4-fixture OSS bench (`pnpm bench:oss`) confirms ColBERT shape-sensitivity |
| v0.17.3 (2026-05-27) | mlx-embed auto-enable HF offline mode when model is cached |
| v0.17.4 (2026-05-30) | `gmax context <path>` deterministic file/dir context; shared CLI/MCP pointer-mode agent search formatter |
| v0.17.5–v0.17.6 (2026-06-02) | Worker memory bound + stuck-worker leak fix; Phase 1 chunker identifier-as-value edges (TS/JS) |
| v0.17.7 (2026-06-02) | Phase 2 ColBERT candidate-concentration auto-gate (`searcher.ts`, threshold 0.7 global) |
| v0.17.8 (2026-06-02) | Eval instrument fix — `eval-oss.ts` credits file + `defined_symbols` match, not just line range (platform recall artifact 0.333→0.800) |
| v0.17.9 (2026-06-02) | Symbol-definition promotion — bare-identifier queries inject + ×5-boost the defining chunk (bench:oss h@1: platform 7→14, lodash 4→9, express 5→8) |
| v0.17.10 (2026-06-02) | Phase 1 multi-grammar — identifier-as-value edges (instantiation / type-test / member-or-scope access) extended from TS/JS to all 14 grammars (Python, Go, Rust, Java, C#, Ruby, Kotlin, Swift, Scala, PHP); 10-language regression test, real-Rust spot-check, bench:oss unchanged |
| v0.17.11 (2026-06-02) | Phase 9 — `gmax audit` graph-summary (god nodes / hub files / dead-code candidates) as a CLI command + MCP tool over a pure `computeAudit` aggregator; 7 unit tests |
| v0.17.12 (2026-06-02) | Phase 7 — MCP graph primitives (`get_neighbors` / `find_paths` / `subgraph_for_files`) over a pure `graph-traversal` core; 14 unit tests. Also: release-script poll-loop fix (`scripts/postrelease.sh`) — first clean one-shot release |
| v0.17.13 (2026-06-02) | Phase 5 — generated-code exclusion: filename/dir globs + `@generated`/DO-NOT-EDIT content header sniff (`isGeneratedContent`, first 2 KB) skip codegen at index time; 5 unit tests. Platform: 159k→134k chunks, `BeyondGraphQL` `*.graphql.swift` god node cleared |
| v0.17.14 (2026-06-02) | Phase 5 follow-up — graphql-codegen client-preset globs (`**/gql/graphql.ts`/`gql.ts`/`fragment-masking.ts`; no `@generated` banner so the sniff missed them). Platform: 134k→**115k chunks (−28% vs v0.17.12), 10,506→7,537 files**, GraphQL-codegen types cleared from god nodes, Swift/Python edges intact. Also: release-script npm-propagation poll + install retry (`postrelease.sh`) after a v0.17.14 ETARGET race |
| v0.17.15 (2026-06-02) | Phase 6 — partial-index signal for agent-mode search: `IndexState {indexing, pendingFiles}` daemon→IPC→CLI→`formatIndexStateFooter`; agent footer (machine-readable, even on `(none)`), non-agent warning, daemon answers searches during a rebuild instead of bailing `not watched`. 5 unit tests |
| v0.17.16 (2026-06-02) | Phase 8 — diff-aware risk preamble: pure `computeRiskTable` (blast radius × tests × churn) over `callersOf`/`findTests`/new `fileChurn`; `gmax review --risk` (LLM-free CLI), `review_risk` MCP tool, and folded into the LLM review prompt. "Blocked on Phase 3 PPR" label was stale — inbound caller count is the centrality proxy. 7 unit tests |
| v0.17.17 (2026-06-02) | Phase 4 — Aider-style chat/file seeding: agent-supplied `seed_files`/`seed_symbols` (MCP) + `--seed-file`/`--seed-symbol` (CLI/daemon) bump RRF `candidateScores` for matching candidates, **relevance-gated by best retriever rank** (`maxRank` 8) so off-topic seeds are never injected. One fusion-stage bump propagates through stage-1/stage-2/rerank/final AND can recover a candidate fusion buried below the cut (rerank-only can't). Definition-preferring symbol weighting. Pure `seed-weight.ts` (20 unit tests) + honest seed-eval fixture (`eval-seed.ts`, route/recover on gmax, no-harm guards on immutable express): **9/9** (route 4/4, recover 1/1, guard 4/4). bench:oss byte-identical (no-seed path inert), 418 tests, live daemon verified (`--seed-file llm/server.ts` lifts #5→#1) |

### Eval baseline

| Metric | Value (MLX off, rerank off, 97-case fixture) |
|---|---|
| Found (rank ≤ 25) | 81 (83.5%) |
| Hits at rank 1 | 49 (50.5%) |
| MRR@10 | 0.6085 |
| Recall@10 | 0.8041 |
| Avg query time | 74 ms |

Reproduce: `pnpm bench:recall` (gmax-self) and `pnpm bench:oss` (express + platform + lodash).

### Bundle B — three negative mechanisms

| Mechanism | Result | Why it failed |
|---|---|---|
| ColBERT rerank | shape-sensitive: monolithic lifts (lodash +0.283 MRR), modular regresses | text-derived signal can't promote correct candidates outside the rerank slice |
| G1 global PageRank tiebreaker | shape-sensitive same direction; default-off behind `GMAX_PAGERANK=1` | query-independent popularity prior; misweights glue code in modular repos |
| G1' graph-recall-recovery | historical Phase 0 aborted at 0/4; later probes found current misses already inside top-200 | original chunker lacked identifier-as-value edges; those edges later shipped, but no current outside-pool fixture justifies recovery |

The IR-theoretic three-way (within-pool text reranker, query-independent global graph signal,
query-dependent graph candidate-recovery) was exhausted on these fixtures. Phase 1's richer
reference extraction subsequently shipped; the remaining blocker is now a genuine held-out
outside-pool miss, not missing graph infrastructure. Full writeups remain in [Background](#background).

---

## Phases

### Phase 1 — Chunker `referenced_symbols` extension (keystone) ✅ all 14 grammars

**Status (2026-06-02, multi-grammar).** Identifier-as-value captures now cover **all 14 tree-sitter grammars**, not just TS/JS. The three shapes — instantiation (`new ClassName(…)` / `ClassName{…}`), type-test (`x instanceof T` / `x is T`), and member/scope access (`Enum.MEMBER` / `Enum::MEMBER`) — are dispatched uniformly in `src/lib/index/chunker.ts::extractRefs` keyed on each grammar's node types: Python `attribute`/`call`, Go `composite_literal`/`selector_expression`, Rust `struct_expression`/`scoped_identifier`, Java `object_creation_expression`/`instanceof_expression`/`field_access`, C# `object_creation_expression`/`is_pattern_expression`/`member_access_expression`, Ruby `call`/`scope_resolution`, Kotlin/Swift `call_expression`/`check_expression`/`navigation_expression`, Scala `instance_expression`/`field_expression`, PHP `object_creation_expression`/`binary_expression`(instanceof)/`class_constant_access_expression`. Member/scope access stays gated to a **Capitalized leaf head** so `ErrorCodes.VALIDATION` yields an edge while `this.x` / `req.body` / lowercase locals do not. Node-type AST shapes were confirmed per grammar with a throwaway probe against the real wasm grammars before coding. Validated through the real chunker for every language in `tests/graph-edges.identifier-as-value.multigrammar.test.ts` (10 languages × class+enum edge, plus a lowercase-flood-negative). Spot-checked on **real Rust** (`dirplayer-rs/.../sprite.rs`): 12/16 def-chunks now carry clean type/enum edges (`ColorRef`, `Sprite`, `CastMemberRef`, `ScriptInstanceRef`) that were entirely absent before (Rust hit none of the old TS-only node types). 360 tests pass, typecheck clean, `bench:oss` unchanged (platform 1.000/0.9467, lodash 0.9/0.9 — TS/JS member-access behavior preserved).

**Corpus reindex landed (2026-06-02).** Edges populate only on a `--reset`, so every indexed non-TS repo was reindexed after the ship: cram, lean, dirplayer-rs (Rust — `Datum`/`ScriptError` now have inbound edges), stripes (Swift — `Printer`/`PrinterCalibration`), capstone (Python, 58k chunks — `BaseCalculator`/`BillResult`/`BESSSpecification` resolve inbound; `AncillaryServiceType.MEMBER` confirms the Python `attribute` member-access shape), and platform (159k chunks, polyglot — Swift `StayService`/`InsurancePolicyFormSheet` inbound, `BeyondGraphQL`/`Button` god nodes via `navigation_expression`). TS-only repos were already live from the v0.17.6 reset. Verification recipe for any repo: `gmax audit --root <repo> --top 5 --agent` (in-project classes/enums should surface as god/hub nodes) + `gmax trace <Class> --inbound --root <repo> --agent` (>0 inbound lines). **All indexed repos are now reindexed against the multi-grammar edges — no reindex debt remains for Phase 1.**

**Status (2026-06-02, TS/JS half — shipped v0.17.6).** TS/JS identifier-as-value captures landed in `src/lib/index/chunker.ts`: `new ClassName(…)`, `instanceof ClassName`, `ClassName.MEMBER` / `Enum.MEMBER` (member access gated to Capitalized objects). Additive — existing call-expression/JSX edges intact. Verified on real platform source (`BeyondError`, `ErrorCodes` now produce caller-chunk edges) and end-to-end through `GraphBuilder.buildGraph` via `tests/graph-edges.identifier-as-value.test.ts` (zero-embedding). Read-only A/B on the platform corpus: +1.1% `referenced_symbols` bytes, 0% embedded-content growth — well under the 20% bound. 346 tests pass.

**Corpus verification (2026-06-02).** Full `gmax index --reset` of the platform corpus (155k chunks) with the rebuilt chunker, then the graph evals:
- `eval-graph-totals`: `BeyondError` ref-chunks **0 → 12**, `ErrorCodes` **0 → 62**. `resolveActor`/`errorHandler` stay 0 (lowercase — out of the Capitalized-only scope by design).
- `eval-graph-spotcheck`: extraction healthy — `mapServiceError` → `[BeyondError, ErrorCodes, …]`, `serviceNotFound`/`serviceConflict` → `[BeyondError, ErrorCodes]`; block/non-TS-JS chunks correctly 0-ref.
- `eval-graph-sanity` (the Phase 3 unblock signal): post-fusion top-200 pool **withRef 0 → 12** for both `BeyondError` (first ref @rank 2) and `ErrorCodes` (@rank 4). Bundle B Phase 0 had 0/200 across all four — the class/enum half is now recoverable by a 1-hop walk.
- `bench:oss` no regression: platform recall@10 0.333 and hits@1 3/15 unchanged, mrr 0.250→0.243 (−0.007, noise); express/lodash untouched.
- *Caveat:* corpus-wide `referenced_symbols` density measured 3.0% post-reset vs a pre-reset 30.7% — the old number was a heterogeneous-legacy artifact (155k chunks accreted across chunker versions); spotcheck confirms per-function extraction is healthy, so this is normalization, not loss.

**Remaining:** identifier-as-value and type-position coverage are complete across supported typed
grammars. The bare-identifier-as-callback-value shape (`emitter.on('x', errorHandler)`, lowercase
locals) remains intentionally uncaptured because it would flood the graph with local references.

**Historical why.** Three downstream phases plus `dead`/`trace` accuracy originally bottomed out
on missing identifier-as-value references. That extraction gap is now closed; this section preserves
the evidence that justified the shipped work.

The Phase 0 sanity check on the 4 platform hard-miss targets found zero edges across the entire 20k-chunk corpus despite 14% of chunks having non-empty `referenced_symbols`. The chunker *is* extracting references — just not these.

**Shape of work.**
- Per-language capture-query revision in `src/lib/index/chunker.ts` for TS/JS, Python, Go, Rust, Java, C#, Ruby, Kotlin, Swift, Bash, Scala (11+ grammars). Start with TS/JS (highest payoff; our own measurement fixtures live there).
- Additive edges: `new ClassName(…)`, `instanceof ClassName`, `ClassName.MEMBER` / `Enum.MEMBER`, type-position references (`: ClassName`, `<ClassName>`, `extends ClassName`).
- Keep existing call-expression coverage intact.

**Acceptance.**
- Re-run `src/eval-graph-totals.ts` against the platform corpus — `referenced_symbols` edges exist for `BeyondError`, `ErrorCodes`, `resolveActor`, `errorHandler` in their direct caller chunks. *(2026-06-02: ✅ done after a 155k-chunk `--reset` reindex. `BeyondError` 0→12 ref-chunks, `ErrorCodes` 0→62. `resolveActor`/`errorHandler` stay 0 as expected — `resolveActor` is an ordinary call covered by existing extraction, `errorHandler` a bare callback value, neither an identifier-as-value class/enum ref. The class/enum targets are covered.)*
- Chunk-size growth bounded (target < 20% byte growth on the platform corpus — measure before deciding cutover). *(2026-06-02: +1.1% ref bytes / 0% embedded-content via read-only A/B — passes.)*
- 305 existing tests still pass; new test fixtures for identifier-as-value extraction land per language. *(2026-06-02: 360 pass; TS/JS fixtures in `tests/chunking.test.ts` + `tests/graph-edges.identifier-as-value.test.ts`; the other 10 languages in `tests/graph-edges.identifier-as-value.multigrammar.test.ts`.)*

**Unblocks.** Phase 3, Phase 8, Phase 9; the `gmax dead <ClassName>` known limitation in [known-limitations.md](../known-limitations.md).

### Phase 2 — ColBERT candidate-concentration heuristic ✅ (2026-06-02)

**Why.** The v0.17.2 OSS-fixture investigation showed ColBERT helps when the top-K fusion pool concentrates in one file (lodash: +0.283 MRR / +0.300 recall / +0.300 hits@1) and hurts when results spread across files (modular shapes). Auto-enable rerank only in the concentration regime.

**Shipped.** Concentration gate in `src/lib/search/searcher.ts` (after RRF fusion): histogram the post-fusion top-10 pool by file path; if the largest bucket's share ≥ threshold, flip `doRerank` false→true. Only ever *adds* rerank-on — an explicit `GMAX_RERANK=1` is never overridden off. Threshold env-overridable via `GMAX_CONCENTRATION_THRESHOLD` (value > 1 disables the gate, used as the rerank-off sweep baseline).

**Result — threshold sweep (`pnpm bench:oss`, query-only, no reindex).** Go criterion pre-declared: lodash MRR lift ≥ +0.15 retained AND no modular dataset regresses MRR > 0.02. Baseline (rerank off): express 0.652 / lodash 0.367 / platform 0.250.

| threshold | express | lodash | platform |
|-----------|---------|--------|----------|
| 0.9 / 0.8 | 0.652 | 0.417 (+0.05) | 0.250 |
| **0.7 (default)** | **0.652** | **0.517 (+0.15)** | **0.250** |
| 0.6 | 0.652 | 0.517 (+0.15) | 0.247 |

Picked **0.7**: highest threshold that retains the full +0.15 lodash lift (recall 0.600→0.800, hits@1 2→3) while leaving express and platform flat. **Open question resolved → global, not per-language**: express is JS like lodash yet never trips the gate at any threshold down to 0.6 — no express query has a top-10 pool ≥60% in one file. The signal is shape-based, not language-based.

**Independent of Phase 1.** Search-time only; no reindex.

### Phase 3 — PPR / k-hop candidate-recovery ⬜ (premise invalidated on current fixtures, 2026-06-02)

**Why.** The G1' shape — "seed PPR or k-hop expansion on the top-k dense+BM25 hits, add reached symbols to the rerank pool" — is the IR-literature-backed path to recovering hard-miss candidates **outside** the top-200 fusion pool.

**Premise check failed (2026-06-02).** Before implementing, a design probe (`src/eval-graph-recovery-probe.ts`) measured where the platform "hard-miss" definition chunks actually sit in the pipeline. **All 10 are already inside the fusion pool** (pool#1–#106), most at the very top (createDbAsync #1, requireAuth #1, getActor #2, errorHandler #2, BeyondError #3). There is nothing *outside the pool* to recover — the recovery premise doesn't hold on these fixtures. The reason the bench scored them as misses was an **instrument artifact** (see below), not a retrieval failure. `eval-graph-sanity`'s earlier "withRef=12" confirmed edges *exist* to walk, but not that any target needs walking *to* — a distinction the sanity check couldn't see.

**Consequence.** Phase 3 has no validatable target on the current 3-fixture instrument: every "miss" is either in-pool-and-surfaced (instrument artifact) or a Phase-1-uncovered shape (`resolveActor`, lowercase, 0 seed refs). Implementing PPR/k-hop now would be unmeasurable. **Deferred** until either (a) a fixture set with genuine outside-pool misses exists, or (b) the in-pool ranking gaps below are shown to need graph signal rather than reranking.

**Instrument fix shipped (v0.17.8, 2026-06-02).** The probe also exposed that `eval-oss.ts`'s `chunkMatches` only credited a line-range hit, so stale hand-curated `expectedLine` values + one-line boundary off-by-ones scored 7/15 platform cases as misses despite the defining chunk being returned at ranks 1-3. Fixed: `chunkMatches` now also credits a file + `defined_symbols`-includes-query match (drift-robust), line-range kept as fallback. **Re-baselined recall@10: platform 0.333 → 0.800, mrr 0.247 → 0.600, h@1 3 → 7; lodash h@1 3 → 4; express unchanged.**

**Symbol-definition promotion shipped (v0.17.9, 2026-06-02).** Investigating the 3 then-remaining in-pool gaps (`BeyondError`/`ErrorCodes`/`resolveActor`) found three *different* drop mechanisms, all for the same root cause — the pipeline didn't privilege the chunk that *defines* a bare-symbol query: overlap dedup dropped `BeyondError`'s parent class chunk for its higher-scoring constructor child; the `RERANK_TOP=20` cut evicted `ErrorCodes` (pooled-cosine rank 24); the stage-2 cosine filter evicted `resolveActor` (fusion rank 91). Fix in `searcher.ts`, gated to bare-identifier queries via `asSymbolQuery` (natural-language queries untouched): (1) inject up to 5 defining chunks from the top-200 pool into the rerank set before the cuts; (2) multiplicatively boost (×5, `GMAX_DEF_BOOST`) candidates whose `defined_symbols` includes the query so the definition outranks its method children and wins dedup. **bench:oss recall@10 / mrr / hits@1: express 0.889/0.652/5 → 0.889/**0.889**/8; lodash 0.800/0.567/4 → **0.900/0.900/9**; platform 0.800/0.600/7 → **1.000/0.947/14**.** Verified end-to-end through the live daemon CLI (BeyondError→errors.ts, resolveActor→auth.ts, etc., all rank 1). 349 tests pass. Known tradeoff: a bare-symbol query that actually wants *usages* gets the definition promoted first — the right default for "find X", and other results still rank below.

**Phase 3 verdict.** The graph-recovery mechanism (PPR/k-hop over outside-pool candidates) remains **deferred** — its premise still doesn't hold on the current fixtures, and the in-pool gaps it was meant to address were ranking issues solved by the symbol-definition promotion above, no graph walk needed. Revisit only if a fixture set with genuine outside-pool misses materializes.

### Phase 4 — G3 Aider-style chat / file seeding ✅ (v0.17.17, 2026-06-02)

**Why.** Aider's repo-map weights files in the current chat 50×, mentioned identifiers 10×, named symbols ≥8 chars 10×. The "blocked on anchor wiring" label was stale: the unblock is **agent-supplied params**, not a passive harness anchor — the agent already knows its open files / discussed symbols.

**Shipped.**
- **Params.** `seed_files`/`seed_symbols` on the `semantic_search` MCP tool (in-process searcher); `--seed-file`/`--seed-symbol` on the CLI (through the daemon/IPC path + in-process fallback). Comma-separated or repeatable; absent → inert.
- **Mechanism (candidate generation, not rerank).** A seed match bumps the candidate's RRF `candidateScores` at the fusion stage. Because the final ordering also reads `candidateScores`, that one bump propagates through the stage-1 cosine cut, the stage-2 window, the rerank set, AND the final score — and can **recover** a candidate that fusion buried below the display cut (a rerank-only seed never could; this is the load-bearing reason the weight lives in candidate-gen, per Bundle B's tiebreaker-over-saturated-pool warning).
- **Safety invariant (relevance gate).** A match is only boosted when its *best retriever rank* (vector OR FTS) is within `maxRank` (8). Off-topic seed files sit mid-pool/deeper and are left exactly where the query put them. (Pooled-ColBERT cosine — the natural relevance signal — is **null on this index**, so the existing stage-1 cosine prefilter is a latent no-op; the rank gate sidesteps that and is the honest available signal. Cosine-prefilter repair is a separate follow-up.)
- **Definition-preferring symbols.** A chunk that *defines* a seed symbol outscores one that merely *references* it (`symbolDefWeight` 0.02 > `symbolRefWeight` 0.006) — seeding `LlmServer` routes to its definition, not its busiest caller (`daemon.ts`).
- **Pure + tested.** `src/lib/search/seed-weight.ts` (matching / rank-gating / weighting), 20 unit tests. Env knobs: `GMAX_SEED_FILE_W`, `_SYMBOL_DEF_W`, `_SYMBOL_REF_W`, `_MAX_RANK`.

**Validation — honest seed dataset built first (premise check: `bench:oss` can only *guard* seeding, not *prove* it — its bare-symbol cases carry no seed context, and seeding the answer file is circular).** `src/eval-seed.ts` runs baseline-vs-seeded and reports rank deltas across three kinds: **route** (same ambiguous query, different seed → different independently-valid answer — gmax "idle timeout" / "health check" each span 3 subsystems), **recover** (answer out of the no-seed top-25, seeding must pull it back — `daemon.ts` —→#1), **guard** (irrelevant seed must not displace the winner; on the **immutable express fixture** because querying gmax for "fusion" is contaminated by this harness's own live-indexed source). Result: **9/9** (route 4/4, recover 1/1, guard 4/4). bench:oss **byte-identical** to v0.17.16 (no-seed path inert): express 0.889, lodash 0.900, platform 0.947/1.0. 418 tests pass; live daemon verified (`--seed-file src/lib/llm/server.ts` lifts `llm/server.ts` #5→#1 via IPC).

**Not index-affecting** (query-time only — no reindex). **Independent of Phase 1** (seeding, not graph walk).

### Phase 5 — G7 Don't-index-indiscriminately 🚧 (generated-code exclusion shipped; seed-walker descoped)

**Premise check (2026-06-02) reframed this phase.** The original scope — Aider's "seed-set + import-follow walker + cold-tier store" — was justified by cold-start indexing being too slow on big monorepos. But gmax already indexes platform (159k chunks) in minutes via MetaCache + GPU embed, so cold-start *speed* is not the pain. The empirical cost is **flood**: the shared LanceDB index sits at **7.5 GB**, and the #2 platform god node was `BeyondGraphQL` — a generated `*.graphql.swift` file — i.e. codegen polluting the Phase 7/9 graph. The high-leverage slice is therefore generated-code *exclusion*, not the seed-walker rearchitecture (which also needs a two-tier cold store that doesn't exist).

**Shipped (v0.17.13, 2026-06-02) — generated-code exclusion.** Two complementary gates:
- **Filename/dir globs** in `src/lib/index/ignore-patterns.ts` (walker-level): `**/__generated__/**`, `**/Generated/**`, `*.graphql.swift`, `*.pb.go`/`*.pb.cc`/`*.pb.h`, `*_pb2.py`/`*_pb2.pyi`/`*_pb2_grpc.py`, `*.g.dart`/`*.freezed.dart`/`*.gr.dart`, `*.designer.cs`, `*.generated.ts`/`*.generated.tsx`, and the graphql-codegen client-preset filenames `**/gql/graphql.ts`/`gql.ts`/`fragment-masking.ts` (added v0.17.14 — these emit *no* `@generated` banner, so the content sniff misses them; the 43k-line `gql/graphql.ts` was the largest single generated file still slipping through after v0.17.13).
- **Content header sniff** `isGeneratedContent()` in `src/lib/utils/file-utils.ts` (orchestrator-level, after the binary check): matches `@generated` / `DO NOT EDIT` / `Code generated by` / `…automatically generated` / `machine generated` in the first 2 KB only (banner is always at the very top, so a deep "do not edit this section" note in real code is not misclassified). Generated files return `shouldDelete: true` so a reindex also *purges* any previously-indexed copies.

Tests: `tests/ignore-generated.test.ts` (5 cases — banner positives, hand-written negatives, deep-marker negative, glob matches/non-matches). 386 tests pass, typecheck clean.

**Measured impact (platform `--reset` reindex, v0.17.12 → v0.17.14):** **159k → 115k chunks (−28%)**, **10,506 → 7,537 files (−2,969)**, shared LanceDB 7.5 G → 6.6 G (further compaction pending via the maintenance loop). The generated GraphQL types (`BeyondGraphQL` + Scalar/Maybe codegen) dropped out of the `gmax audit` god-node list entirely; real symbol edges intact (`StayService` 11 inbound, Python `BaseCalculator`/`AncillaryServiceType` unchanged). Remaining top god nodes are now SQL query-builder identifiers (`from`/`where`/`select` in `.test.ts`) — inherent name-graph noise, a separate Phase-7 concern, not codegen. **Reindex note:** generated-code exclusion only takes effect on `--reset`; only platform was reindexed (it held the codegen flood). Other repos pick up the exclusion on their next reset — no urgency since they had little/no generated code in the god-node list.

**Remaining (descoped, pick up only if a real monorepo cold-start cost appears).** The seed-set + import-follow walker + cold-tier two-tier store. Premise check says it's over-engineered for the current pain; left as a future option in `src/commands/index.ts` / `add.ts`.

**Independent of Phase 1.**

### Phase 6 — Partial-index signal for agent-mode search ✅ (2026-06-02)

**Shipped.** `IndexState { indexing, pendingFiles }` flows daemon → IPC → CLI → a pure `formatIndexStateFooter` (`src/lib/output/index-state-footer.ts`, 5 unit tests):
- **Daemon** (`daemon.ts`): `indexState(root)` unions three live signals — the batch processor's `pending.size` (new `ProjectBatchProcessor.progress` getter; covers daemon-restart catchup + live file edits, with a real queue-depth count), an `indexProgress` map fed by `initialSync.onProgress` (covers `--reset` / initial index), and the registry `status==='pending'`. Attached to the search response only when `indexing` (formatter suppresses the settled case anyway).
- **Search-during-rebuild fix**: `indexProject` removes the processor while rebuilding, so `daemon.search` used to bail `"project not watched"`. Now it proceeds against the partial index (and flags it) when a full/initial index is in flight — the rebuild's partial vectors are still queryable.
- **CLI** (`search.ts`): agent mode appends the footer as the *last* line (even on `(none)`, where empty results may just mean the files aren't indexed yet); non-agent folds it into the existing warnings; in-process fallback degrades to the boolean (no daemon = no count).

Verified live: daemon IPC returns `{indexing:true, pendingFiles:25}` during a batch window then `undefined` when settled; agent footer renders with results and on `(none)`; non-agent prints `⚠️  Index still syncing — results may be incomplete.` 391 tests pass, typecheck clean.

**Honest limitation:** `initialSync` streams the walk without pre-counting, so `total` is unknown until completion — a full `--reset` shows the **no-count** footer (`[index: syncing · results may be incomplete — retry for full coverage]`). The precise `~N files pending` count appears in the batch-processor path (catchup / live edits), where `pending.size` is a real queue depth. Decision: don't pre-walk to fabricate a `--reset` count (expensive); the boolean is truthful there.

#### Original scope (kept for reference)

**Premise check reframed the phase.** The original "heartbeat-aware partial results" framing assumed search *blocks on indexing or returns nothing*. The code disproves it:
- Search does **not** block during catchup: `needsSync = options.sync || !hasRows` (`search.ts:802`) — if any rows exist it searches them immediately; the daemon path always hits a warm DB (<1s). Blocking happens only on a *cold-empty* index with no daemon (60s auto-index timeout).
- Search **already** returns partial results *and already warns*: `project.status==='pending'` (`search.ts:695`), `isLocked()` (`:795`), index-timeout (`:833`).
- **But every warning is gated `!options.agent`** — the AI-facing path gets zero signal that results may be incomplete. *That* is the gap.
- "Heartbeat-aware" is a misnomer: search is request/response; Bundle A's heartbeat infra is for long `index`/`add` IPC *streams*. The real mechanism is surfacing index-progress *state* in the search response.

**Decisions (2026-06-02).** (1) **Precise count**, not a coarse boolean — expose real "files pending" so agents decide retry-vs-caveat on numbers. (2) **No confidence cap** — a score cap during indexing is arbitrary and corrupts ranking; emit a machine-readable annotation instead and leave scores untouched.

**Shape of work (~half day).**
1. **Daemon — live progress per project.** A helper returning `{ indexing: boolean, pendingFiles: number }`, derived from the `ProjectBatchProcessor`'s `pending.size` (add a getter) + watcher `syncing` status + registry `status==='pending'` (initial index). The daemon owns `this.processors`, so it can report without new bookkeeping.
2. **IPC — attach to the search response.** Extend `handleSearch` (`ipc-handler.ts`) to include `indexState: { indexing, pendingFiles }` in one round-trip (no extra call); optionally surface in `status` too.
3. **CLI render (`search.ts`).** Agent mode: append one machine-readable footer when `indexing` — e.g. `[index: syncing · ~142 files pending · results may be incomplete — retry for full coverage]`. Non-agent: fold the count into the existing warnings. In-process fallback (no processor): degrade gracefully to the boolean.
4. **Pure fn + tests.** `formatIndexStateFooter({indexing, pendingFiles, agent})` → `string | null` (null when `pendingFiles===0` / fully indexed, so steady-state search stays silent); unit-test agent vs human phrasing, the zero-pending no-op, and that agent mode emits the footer when `indexState.indexing`.

**Edges.** `pendingFiles` is a moving, debounced estimate → label it `~`. Suppress the footer at zero-pending so every steady-state search isn't noisy. The daemon path carries the real count; the in-process fallback only has the lock boolean.

**Out of scope.** Opportunistic auto-refine / re-run-as-index-completes (agents just retry); any streaming. Score cap (rejected above).

**Independent of Phase 1.**

### Phase 7 — G5 MCP graph primitives ✅ (2026-06-02)

**Why.** Expose `get_neighbors(node, edge, max_hops)`, `find_paths(a, b)`, `subgraph_for_files([...])` as MCP tools so agents build their own query plans. CodeGraph's abstraction.

**Shipped.** Three MCP tools in `src/commands/mcp.ts` over new `GraphBuilder` methods, with the traversal core extracted to a pure, injectable-`neighborFn` module (`src/lib/graph/graph-traversal.ts`) so BFS/path/subgraph logic unit-tests without a store (`tests/graph-traversal.test.ts`, 14 cases incl. a GraphBuilder integration test against the `array_contains` mock):
- **`get_neighbors(symbol, direction, max_hops)`** — bounded BFS over caller/callee edges; each hit annotated with hop distance + resolved file:line. `direction: callees` = outbound (what it calls), `callers` = inbound. `max_hops` default 2 / cap 5; node budget 500.
- **`find_paths(from, to, direction, max_hops)`** — BFS shortest path as a symbol sequence (first found = shortest); default 6 / cap 10 hops. Returns "no path" if unreachable.
- **`subgraph_for_files([...])`** — pure `buildFileSubgraph` aggregation: symbols defined in the set, intra-set call edges, and outbound external deps. Paths absolute or root-relative.

Verified live against the gmax index: callers of `computeAudit` → exactly `audit`/`handleAudit`/`mcp`; `find_paths handleAudit→computeAudit` → direct edge; `subgraph_for_files audit.ts` → 24 symbols / 8 internal edges / 45 external deps with correct intra-file structure. 381 tests pass, typecheck clean. **Known noise:** `get_neighbors` callees surfaces JS builtins (`Map`/`Set`/`Boolean`) — inherent to the name-based graph; they're marked `(external)` (unresolved def) so agents can filter. CLI surface intentionally skipped — MCP is the agent-facing point of this phase.

### Phase 8 — G2 Diff-aware risk preamble on `gmax review` ✅ (2026-06-02)

**Why.** Sverklo's `review_diff` ranks touched symbols by `importance × test coverage × churn`. Our `gmax review` was LLM-only. A deterministic "changed symbols ranked by blast radius + tests + churn" preamble is visible to agents day one — and needs no LLM.

**Unblocked, not blocked — the "blocked on Phases 1 + 3" label was stale.** Phase 1 shipped (accurate cross-grammar caller edges), and Phase 3's PPR was never actually required: **inbound caller count** (the Phase 9 / Phase 7 `callersOf` machinery) *is* the centrality proxy, exactly Sverklo's "importance." No PageRank needed.

**Shipped.** Pure `computeRiskTable` + `formatRiskTable` (`src/lib/review/risk.ts`, 7 unit tests) score each changed symbol `(callers + 1) × testFactor × churnFactor` — blast radius dominates, untested doubles it (`UNTESTED_MULTIPLIER`), churn contributes on a log scale so a churny leaf can't outrank a central symbol. Inputs gathered by composing existing pieces: `extractDiff`/`extractSymbols` (diff), `GraphBuilder.callersOf` (blast radius), `findTests` (test presence), and a new `fileChurn` git helper (`diff.ts`, `git rev-list --count`). Surfaced two ways:
- **`gmax review --risk` (+ `--agent`)** — LLM-free CLI; human table or machine-readable TSV.
- **`review_risk` MCP tool** — same, agent-facing.
- **Folded into the LLM review** — the ranked table is injected into `buildUserPrompt` so the model anchors its judgement on explicit blast-radius ordering rather than inferring importance from prose.

Verified live on a real feature commit: `ProjectBatchProcessor` (2 callers, churn 15) ranks top, `Daemon` (churn 38) next, leaves last. 398 tests pass, typecheck clean. **Known noise:** `extractSymbols` over-extracts a few non-symbols from diff comments/help-text (shared with the existing LLM path); they resolve to `(unindexed)` with 0 callers and sink to the bottom — harmless for triage. Read-only — no reindex.

### Phase 9 — `gmax audit` graph-summary ✅ (2026-06-02)

**Why.** Sverklo's `audit` surfaces god nodes, hub files, dead-code candidates in one call. Same dependency on richer graph edges as Phase 1 — a god-node analysis over a graph missing class-reference edges undercounts.

**Shipped.** New `gmax audit` command (`src/commands/audit.ts`) + MCP `audit` tool (`src/commands/mcp.ts`). One scan over the scoped corpus feeds a pure `computeAudit(rows, prefix, top)` aggregator (exported + unit-tested in `tests/audit.test.ts`, 7 cases):
- **God nodes** — in-project symbols ranked by distinct *external* inbound files (self-only refs excluded; sub-3-char names filtered). On gmax-self the top is genuinely the architectural core (`log`, `gracefulExit`, `ensureProjectPaths`, `findProjectRoot`); method-name collisions (`get`/`close`) add some noise — inherent to a name-based graph without type resolution.
- **Hub files** — files ranked by distinct external dependents (a file G depends on F if G references a symbol F defines); also reports `defines` and in-project `fanOut`. On gmax-self this nails the real hubs (colbert, granite, orchestrator, logger, vector-db).
- **Dead-code candidates** — non-exported symbols with zero inbound refs anywhere. Honest caveat:
  dynamic/decorator dispatch, reflection, string-built calls, and bare callback-value references
  can still produce false positives; type-position references are now covered.

Scope flags `--root` / `--in` / `--exclude` / `--top` / `--agent` (TSV). ~1.1s on the 159k-chunk platform corpus. 367 tests pass, typecheck clean.

**Blocker.** ~~Phase 1~~ — resolved (Phase 1 complete across all grammars 2026-06-02).

## Deferred

- **G11 — Merkle-tree chunk-level invalidation.** Overkill at current scale; file-level LMDB is ~95% hit rate per Claude Context's own docs. Pick up if a 1M-file monorepo user lands.

## Decisions

- **2026-05-25** — Ship Bundle A as v0.17.0; defer Bundle B pending eval-harness evidence.
- **2026-05-25** — `gmax dead <symbol>` carved out of Bundle B as a deterministic command (not a ranking signal), shipped in v0.17.2.
- **2026-05-25** — G1 PageRank tiebreaker default-off (`GMAX_PAGERANK=1` escape hatch). Negative empirical result on the pre-declared criterion (modular MRR lifts on ≥2 datasets by +0.03 each → got 0/3).
- **2026-05-25** — ColBERT default → off (rerank-on regresses modular shapes; helps only the monolithic lodash case). `GMAX_RERANK=1` escape hatch in place.
- **2026-05-26** — G1' PPR/k-hop aborted at Phase 0 sanity check (0/4 hard-miss targets had edges). Chunker `referenced_symbols` identified as the upstream lever — Phase 1 here.

## Resolved Questions

- **Phase 1 measurement:** type-position edge coverage and dead-code false positives established
  the gate; all typed grammars shipped.
- **Phase 2 threshold:** the global concentration gate shipped; no language-specific regression
  has justified splitting it.
- **Phase 4 anchor protocol:** explicit seed files and symbols shipped across CLI/MCP.
- **Review dependency:** deterministic `review_risk` shipped independently of the optional LLM.

---

## Background

The rest of this doc preserves the May 2026 research and the Bundle A/B writeups so future sessions don't re-litigate the negatives.

### Part 1 — osgrep upstream since 0.5.16

Source: `gh api repos/Ryandonofrio3/osgrep/commits` and tree-walks of `src/`, `tests/`, `experiments/`. Bulk of the changes landed Nov 28 2025 → Jan 17 2026. Note: npm `osgrep` is still pinned at 0.5.16 — all of this is GitHub-only, through commit `9f2faf7` on 2026-01-17.

#### Worth lifting

| Upstream change | Date | What it gives us | Status |
|---|---|---|---|
| Three-mode `skeleton` dispatch (path \| symbol \| query) + language-aware headers + expanded method-ref extraction for Java/C#/Ruby | 2025-12-09 | Closes the `gmax skeleton .` footgun from agent-ux-proposals P0 #2. | **SHIPPED** in earlier work; gmax skeletonizer is a strict superset of upstream. |
| Heartbeat lines on long index ops | 2025-12-08 | Periodic JSON-parseable heartbeats so agents/clients don't timeout during multi-minute indexes. | **SHIPPED** in v0.17.0 (`startHeartbeat(conn)` in ipc-handler.ts). |
| Worker poisoning detection | 2025-11-29 | Detect stuck workers and replace surgically. | **SHIPPED** in v0.17.0 (error-event handler) + v0.17.1 (SIGKILL escalation). |
| `--min-score` flag on search | 2025-12-02 | Filter low-confidence results out at source. | **SHIPPED** earlier (search.ts:410, 475, 498, 531, 868). |
| Reject unknown options instead of misparsing as args | 2025-12-17 | Agents that hallucinate flags get a clear error. | **SHIPPED** (Commander default). |
| Check `.git/info/exclude` before writing `.gitignore` | 2026-01-16 | Polite repo hygiene. | Open — lift if `add.ts` is touched. |
| Test fixtures for structural boosting | 2025-12-04 | Regression coverage on the role-scoring path. | Open — lift if role-scoring code is touched. |
| `experiments/` directory: `mrr-sweep.ts`, `ranking-test.ts`, `verify-fix.ts` | 2025-12-04 | Real recall@K / MRR sweep harness. | **SHIPPED** in Bundle A (`src/eval.ts` + `pnpm bench:recall`). |

#### Worth knowing, not lifting

- **Workers moved from processes → piscina threads** (2025-12-04, "FINALLY, Threads!"). We deliberately use processes for ONNX-runtime segfault isolation (per `CLAUDE.md`). Keep ours.
- **Per-project HTTP server at `.osgrep/server.json`** vs our singleton-daemon-over-socket. Their design fails worse on multi-project; ours is the right choice for our user.
- **pylate-rs (Rust ColBERT)** experiment Dec 4-5 — they fell back ("stable before pylate-rs"). Don't chase yet.
- **Dart, YAML, Kotlin, Swift grammars** (2025-12-03) — trivially mirrorable in `grammar-loader.ts` if a user asks. Not proactive.

### Part 2 — Competitive landscape (May 2026)

The field has consolidated since the P4 list in [agent-ux-proposals.md](../archived/agent-ux-proposals.md). Three tools matter now:

- **sverklo** — local-first code-intel MCP, 37 tools, 1.1k+ stars, published F1 benchmark vs naive-grep / smart-grep, bi-temporal git-pinned memory. Closest competitor in spirit.
- **Claude Context (Zilliz)** — open-source MCP, 6.2k+ stars, multi-client (Claude Code / Cursor / Codex / Cline / Windsurf / 8 more), pluggable embeddings. Most-installed.
- **CodeGraph** — local symbol graph exposed as MCP graph primitives. Different shape from search.
- **Aider repo-map** — still the gold standard for "PageRank-personalized context for the current turn." Not MCP, but architecturally instructive.
- **Cursor codebase index** — proprietary, but the Merkle-tree + multi-resolution index pattern is widely copied.

#### Gaps (G1–G13)

Numbered for cross-reference with the phases above.

**G1. PageRank over the code graph as a default ranking signal.** sverklo, Aider, RepoMapper all do this. We build the call graph (`src/lib/graph/graph-builder.ts`) but only use it for `trace`. Adding PageRank as a tiebreaker in `search` lifts "the file that actually matters" queries without changing the contract. → **Negative result; see [G1 writeup](#g1-pagerank-as-tiebreaker--negative-result-2026-05-25).**

**G2. Diff-aware risk scoring on `gmax review`.** Sverklo's `review_diff` ranks touched symbols by `importance × test coverage × churn`. → **Phase 8 above.**

**G3. Aider-style chat/task personalization on PageRank.** Files in the current chat get 50× weight, mentioned identifiers 10×, named symbols ≥8 chars 10×. → **Phase 4 above.**

**G4. `gmax dead <symbol>` / `gmax audit`.** Prove a symbol is unreferenced from the symbol graph, not from text that grep happened to find. → `gmax dead` **SHIPPED** v0.17.2; `gmax audit` is **Phase 9 above.**

**G5. MCP-exposed graph primitives** (CodeGraph pattern). → **Phase 7 above.**

**G6. Eval harness with recall/MRR metrics.** Sverklo's public version (`npm run bench:primitives` with F1 vs naive-grep / smart-grep, hand-verified ground truth on express/lodash). → **SHIPPED** in Bundle A. Public-facing version (express/lodash ground truth + grep comparison + methodology doc) becomes worth shipping once a Bundle B win lands.

**G7. Import-flood / chat-flood seeded indexing** (Aider). → **Phase 5 above.**

**G8. Heartbeat-aware partial-results agent mode** (Cursor pattern). → **Phase 6 above.**

**G9. Bi-temporal git-pinned memory** (sverklo's wedge). → Non-goal (different product class).

**G10. Pluggable embedding backends with multi-vector columns** (Claude Context). → Non-goal at current scope.

**G11. Merkle-tree chunk-level invalidation** (Claude Context, Cursor). → Deferred.

**G12. Cross-repo workspace impact** (sverklo `workspace init`). → Non-goal (no demand).

**G13. VS Code semantic index sharing** (LSP-ish API). → Non-goal (no consumer).

### Validation phase findings (2026-05-25)

Trying to re-baseline with MLX up and rerank on revealed three bugs and one strategic question:

**1. MLX zombie pattern.** PID 74366 had held port 8100 since Saturday 22:02 (~42h) but was unresponsive (`curl` timed out at 14s; RSS dropped to 7MB because the model is mmap'd). Every fresh daemon attempted to spawn its own MLX, loaded the model successfully, then crashed on `EADDRINUSE`. `ensureMlxServer()` only ran at daemon startup — no runtime health-recovery loop. **Fixed in v0.17.1** (5-min heartbeat health check in `daemon.ts`).

**2. Stuck-task worker poisoning.** PID 75131 burned 98% CPU for 41h 55m stuck inside `onnxruntime::InferenceSession::Run` → `MatMulNBits`. SIGTERM ignored by ONNX in a tight matmul loop. **Fixed in v0.17.1** (SIGKILL escalation in `reapIdleWorkers`).

**3. ColBERT rerank silently no-op via IPC serialization.** `Int8Array` sent through `child_process.send` gets serialized as a plain `Object` with numeric keys; orchestrator.rerank() had branches for `Int8Array`, `Buffer`, `{type:"Buffer", data:[]}`, and `Array` — but not for the numeric-keyed-object case. Fell through to `new Int8Array(0)` → empty docMatrix → maxSim returns 0. The entire ColBERT rerank pipeline had been silently broken in production. **Fixed in v0.17.0** (`coerceColbertBytes` in orchestrator.ts with 8 unit tests).

**4. Strategic question after the fix.** Eval with rerank on (firing real ~30-magnitude scores) gave MRR@10 = 0.5721 vs 0.5838 with rerank off — a slight *regression*. Hits-at-1 unchanged (45/97). Not worth the 72ms/query cost on the 97-case fixture. Led to the v0.17.2 OSS-fixture investigation.

### v0.17.2 followup — ColBERT shape-sensitivity confirmed (2026-05-25)

Cloned express 4.21.1 + lodash 4.17.21 pinned, indexed via `gmax add`, ported sverklo-bench P1 (definition lookup) fixtures from [sverklo/sverklo-bench](https://github.com/sverklo/sverklo-bench). Built `src/eval-oss.ts` — multi-project runner that scopes via `pathPrefix` and supports line-window matching (lodash is one 17K-line file, so substring-only path matching is meaningless there). 9 express cases + 10 lodash cases. Reproduce via `npx tsx src/eval-oss.ts all` (toggle rerank with `GMAX_EVAL_RERANK=1`).

| Dataset | Code shape | rerank-off MRR | rerank-on MRR | Δ | R@10 off→on | hits@1 off→on |
|---|---|---|---|---|---|---|
| gmax (97) | modular TS | 0.5938 | 0.5657 | **−0.028** | 0.804 → 0.794 | 47 → 44 |
| express (9) | modular CommonJS | 0.6519 | 0.4778 | **−0.174** | 0.889 → 0.889 | 5 → 3 |
| platform (15) | modular monorepo (pnpm) | 0.5467 | 0.3962 | **−0.151** | 0.733 → 0.733 | 6 → 4 |
| lodash (10) | monolithic IIFE | 0.3667 | 0.6500 | **+0.283** | 0.600 → 0.900 | 2 → 5 |

**Finding.** ColBERT isn't bad — it's **shape-sensitive**. All three modular shapes regress; only the monolithic single-file shape benefits. On modular codebases each expected hit lives in its own file; fusion picks the right file from path/filename signals, and ColBERT then perturbs ranks within the correct candidate pool (often for the worse). On monolithic single-file repos, fusion can't discriminate within the file, and ColBERT's token-level scoring is the only mechanism that promotes the right chunk — +30% MRR, +30% recall, +30% hits@1 on lodash.

Across every modular dataset, **recall@10 is unchanged** between modes. Rerank perturbs the top-10 ordering but never promotes a new file into the top-10. The regression is entirely about reordering correct candidates *worse*, not about losing them. → Phase 2 above is the principled fix.

### G1 PageRank-as-tiebreaker — negative result (2026-05-25)

Implemented `src/lib/search/pagerank.ts` (power-method PageRank, per-project graph from `defined_symbols`/`referenced_symbols`, disk cache under `~/.gmax/pagerank/`) and wired it behind `GMAX_PAGERANK=1` in `src/lib/search/searcher.ts` as a `PR_WEIGHT * normalizedPR(chunk.defined_symbols)` additive boost on the post-fusion/post-boost score (`PR_WEIGHT` default 0.05, tunable via `GMAX_PR_WEIGHT`). 12 unit tests in `tests/pagerank.test.ts`.

| Dataset | Shape | Cases | Baseline MRR | PR-on MRR | Δ MRR | Δ R@10 |
|---|---|---|---|---|---|---|
| gmax (scoped) | modular TS | 97 | 0.4960 | 0.4680 | **−0.028** | −0.010 |
| express | modular CJS | 9 | 0.6519 | 0.6519 | 0.000 | 0.000 |
| platform | modular monorepo | 15 | 0.5467 | 0.5467 | 0.000 | 0.000 |
| lodash | monolithic IIFE | 10 | 0.3667 | 0.4333 | **+0.067** | **+0.200** |

The criterion required MRR lifts on ≥2 modular datasets by +0.03 each. Got **0 of 3** — gmax regressed, express and platform unchanged. The 4 platform hard-miss cases (`BeyondError`, `ErrorCodes`, `resolveActor`, `errorHandler`) stayed at rank 0 in both modes — PageRank does nothing for items outside the top-200 candidate pool.

Weight sweep (PR_WEIGHT ∈ {0.05, 0.1, 0.2, 0.5, 1.0, 2.0}) only made it worse: higher weights pull lodash up further while crushing express (0.65 → 0.32 at PR_WEIGHT=1.0). Same shape-sensitivity pattern as ColBERT — tuning won't fix it; PR_WEIGHT controls how *much* you regress modular, not whether you do.

**External-lit sanity check (2026-05-26, via perplexity sonar-reasoning-pro)** confirmed the null is consistent with IR theory rather than a measurement bug: global PageRank is a query-independent popularity prior, so it preferentially drags "glue" code (utilities, framework base classes, barrels) up the ranking. In modular repos those are precisely the nodes users *don't* query by bare symbol name — they query for domain entities (`errorHandler`, `resolveActor`), which live in the long tail of the centrality distribution. Published "PageRank helps code search" claims (sverklo, Aider, RepoMap) almost certainly correspond to either:

- **Personalized PageRank (PPR) / random-walk-with-restarts seeded on the query or first-stage hits** (Aider's design). Rewards local connectivity to already-relevant code, not global popularity. → Phase 3.
- **PR integrated into candidate selection** (`BM25 + λ·log PR` style), so it changes *which* candidates appear at all, not just their order. Can lift recall.

Implementation lives on `main` behind `GMAX_PAGERANK=1` for future re-probing. `src/eval.ts` gained `GMAX_EVAL_PATH_PREFIX` for scoped gmax-self measurement.

### G1' graph-as-recall-recovery — aborted at Phase 0 (2026-05-26)

The 4 platform hard-miss cases were the obvious target for a candidate-recovery layer: seed a k-hop walk (or PPR with restart) on the top-k dense+BM25 hits, add reached symbols to the rerank pool. Before building it, the pre-declared Phase 0 sanity check asked: for each hard-miss case, does any chunk in the top-200 fusion pool reference the missing symbol via `referenced_symbols`? ≥1/4 = mechanism is worth building. 0/4 = abort.

Phase 0 results (`src/eval-graph-sanity.ts`, scoped to `~/Development/beyond/platform/`, post-RRF fusion pool size 200):

| Target | Pool size | ref-chunks in top-200 | def-chunks in top-200 | First def-chunk rank | Verdict |
|---|---|---|---|---|---|
| BeyondError | 200 | **0** | 1 | 2 | unreachable via graph |
| ErrorCodes | 200 | **0** | 0 | — | unreachable via graph |
| resolveActor | 200 | **0** | 3 | 82 | unreachable via graph |
| errorHandler | 200 | **0** | 3 | 2 | unreachable via graph |

0/4. Hard abort on the pre-declared criterion. But the result is **richer than "graph empty in the fusion pool":** a follow-up scan of the whole platform corpus (`src/eval-graph-totals.ts`, 20k-chunk cap) found that not just the fusion pool but the **entire indexed corpus** contains zero chunks whose `referenced_symbols` includes any of the 4 target names — despite 14.0% of platform chunks having non-empty `referenced_symbols` (avg 82 refs/chunk where non-empty).

Root-cause spot-check on a known caller file (`packages/api/src/middleware/error.ts`, which clearly uses `BeyondError` — see `src/eval-graph-spotcheck.ts`) revealed the mechanism: the chunker tracks **call-expression names** (`.get()`, `.header()`, `.json()`, `.next()`, method invocations) and **bare-function calls** (`createRequestLogger`, `annotateActiveSpan`), but **not identifier references** (`new BeyondError(…)`, `instanceof BeyondError`, `BeyondError.SOMETHING`, `ErrorCodes.VALIDATION`). The `errorHandler` function's chunk shows 40 referenced_symbols — all method/function calls — and zero identifier-as-value references.

→ **Phase 1 is the upstream lever.**

**Repro:**
```bash
npx tsx src/eval-graph-sanity.ts     # top-200 fusion-pool ref counts per target
npx tsx src/eval-graph-totals.ts     # whole-corpus ref counts + density baseline
npx tsx src/eval-graph-spotcheck.ts  # raw referenced_symbols on known caller files
```

## Version History

- **2026-05-25** Created as research-findings doc after osgrep-upstream + competitive-landscape research. Bundle A scoped and shipped (v0.17.0).
- **2026-05-25** v0.17.1 followups shipped (ColBERT default-off, MLX health-recovery, SIGKILL escalation).
- **2026-05-25** v0.17.2 shipped (`gmax dead`, 4-fixture OSS bench instrument).
- **2026-05-25** G1 PageRank-as-tiebreaker negative; implementation kept behind `GMAX_PAGERANK=1`.
- **2026-05-26** G1' PPR/k-hop aborted at Phase 0; chunker `referenced_symbols` identified as upstream lever.
- **2026-05-27** v0.17.3 shipped (mlx-embed HF offline mode).
- **2026-05-28** Restructured from `type: doc, status: reference` → `type: plan, status: active` with phased open backlog. Body content preserved under Background.
- **2026-05-30** v0.17.4 shipped (`gmax context <path>` and shared CLI/MCP pointer-mode agent search formatting).
- **2026-06-02** v0.17.5–v0.17.12 shipped in one session: worker memory fix, Phase 1 TS/JS chunker edges (v0.17.6), Phase 2 ColBERT concentration gate (v0.17.7), eval instrument fix (v0.17.8), symbol-definition promotion (v0.17.9), Phase 1 multi-grammar edges across all 14 grammars (v0.17.10), Phase 9 `gmax audit` graph-summary (v0.17.11), Phase 7 MCP graph primitives + release-script poll-loop fix (v0.17.12). Phases 1, 2, 7, 9 done; the three graph-dependent phases (1/7/9) all landed. Remaining open: Phase 5 (seeded indexing), Phase 6 (partial results); Phase 4 (blocked on MCP anchor wiring), Phase 8 (blocked on deferred Phase 3); plus the type-position-reference Phase-1 follow-up.
- **2026-06-02** Corpus reindex of the v0.17.10 multi-grammar edges completed across every indexed non-TS repo (cram, lean, dirplayer-rs, stripes, capstone, platform); verified via `gmax audit` + `gmax trace --inbound`. No reindex debt remains for Phase 1. Operational only — no version bump.
- **2026-06-02** v0.17.13–v0.17.14 shipped — Phase 5 generated-code exclusion (premise check descoped the seed-walker; flood, not cold-start speed, was the cost). Globs + `@generated` header sniff + graphql-codegen client-preset globs. Platform reindex: 159k→115k chunks (−28%), codegen god nodes cleared. Plus a `postrelease.sh` npm-propagation poll/retry fix after a v0.17.14 ETARGET install race.
- **2026-06-02** v0.17.15 shipped — Phase 6 partial-index signal for agent-mode search (premise check: search never blocked during catchup; the real gap was agent mode silently getting partial results). `IndexState` daemon→IPC→CLI→pure footer formatter; daemon now answers searches during a rebuild instead of bailing. Search-time only, no reindex.
- **2026-06-02** v0.17.16 shipped — Phase 8 diff-aware risk preamble (reassessment: the "blocked on Phase 3 PPR" label was stale — inbound caller count, now accurate via Phase 1, is the centrality proxy). `gmax review --risk` LLM-free CLI + `review_risk` MCP tool + folded into the LLM prompt. Read-only, no reindex. **Remaining open:** Phase 4 (chat/file seeding — unblockable via agent-supplied seed params, not a passive harness anchor); type-position-reference Phase-1 follow-up (flood risk + reindex); Phase 5 seed-walker + Phase 3 PPR both descoped pending a real triggering case.
- **2026-08-04** Refreshed as `partial`: all shipped work is current through chunker v4;
  the remaining tail has explicit empirical reopen triggers and no active build target.
- **2026-08-04** Added frozen-fixture, metric, latency, and abort gates for every deferred
  mechanism plus harness prerequisites and one-successor-per-mechanism rules.

## Closeout

The core roadmap shipped. PPR, HyDE, query expansion, semantic cache, seeded indexing, and
Merkle invalidation remain deferred until the explicit triggers in `next_step` occur. New work
should use focused successor plans rather than reopening this historical omnibus wholesale.
