# gmax ranking of archived and dated docs: findings

Read-only investigation, 2026-11-09. The source is gmax at `7b7cf9d` (tools/gmax). The installed daemon runs 0.26.113 (`gmax --version`, tag `b3cb28c`). `git diff --stat b3cb28c HEAD -- src/lib/search src/lib/index/chunker.ts src/lib/index/ignore-patterns.ts` is empty, so the source lines below match the running build. The installed `dist/lib/search/searcher.js:358,374,629` carries the same 0.5 test penalty, 0.6 doc penalty and RRF_K = 60.

The output path in the brief sits in the parent scratchpad, and the SubagentStart hook forbids writing there. This file is in the agent's own scratch folder instead. Raw search outputs are in `runs/` next to it, and `flat.txt` and `flat2.txt` list them as ranks.

## Short answer

- **Newer docs get no precedence.** No ranking stage reads file mtime, git time, a date in the path, frontmatter or index time. Ties are broken only by retrieval rank.
- **Archived docs get no demotion and are not excluded.** They rank exactly like current docs. The only signal that reaches them is the path text, which is embedded in every chunk, so a query that contains "archived" pulls archived docs up.
- **All docs get one flat penalty:** every `.md` file and every path containing `/docs/` is multiplied by 0.6. Code chunks get boosts of up to about 3.18x by the code (`searcher.ts:366-403`); 2.27x was the largest seen in these runs. In the unscoped default runs, all top 5 were code for P3 and P5, and rank 1 was code for P1.
- **In 4 of 5 pairs (P1, P3, P4, P5) the older or superseded doc ranked above the current or newest one** (section 5). The P1 and P3 queries lean toward the old doc's wording. With queries worded from the successor, the successor led in P1, and an archived plan still led in P3.

## 1. Ranking pipeline, end to end

CLI `gmax "<q>"` sends the query to the daemon (`src/commands/search-run.ts:139-160`). Rerank is requested only when `GMAX_RERANK=1` is set (`search-run.ts:155`). The daemon calls `Searcher.search` (`src/lib/daemon/search-handler.ts:130-145`). The stages, all in `src/lib/search/searcher.ts`:

1. **Query analysis.** `detectIntent` sorts the query into DEFINITION, FLOW, USAGE, ARCHITECTURE or GENERAL by regex (`src/lib/search/intent.ts:33-57`). `artifactPreference` checks whether the query asks for tests or docs (`artifact-preference.ts:7-22`). `asSymbolQuery` detects a bare identifier (`searcher.ts:84-87`). All three are called at `searcher.ts:565-568`.
2. **Encoding.** One call returns the dense vector, the ColBERT token matrix and a pooled 48-dim vector (`searcher.ts:587-594`).
3. **Filters.** `buildWhereClause` turns `--in`, `--exclude`, `--file`, `--lang`, `--role` and project roots into a SQL WHERE (`searcher.ts:89-206`). There is no date or status filter.
4. **Retrieval.** Dense vector search (`searcher.ts:693-704`) and LanceDB full-text search over the `content` column (`searcher.ts:708-722`; the index is created on `content` at `src/lib/store/vector-db.ts:1499,1732`). Each returns up to `max(5 x limit, 500)` rows (`searcher.ts:611-615`).
5. **Fusion.** Reciprocal rank fusion with k = 60: each list adds `1/(60 + rank + 1)` (`searcher.ts:762-797`).
6. **Seeds (opt-in).** `--seed-file` / `--seed-symbol` add a bonus to fused scores (`searcher.ts:814-860`).
7. **Concentration gate.** If 70% or more of the top 10 fused candidates come from one file, ColBERT rerank turns on automatically (`searcher.ts:862-903`).
8. **Cuts.** The top 200 fused candidates are kept (`searcher.ts:909-912`), then the top 40 by pooled cosine (`searcher.ts:936-964`). Of those, 20 go to rerank (`searcher.ts:926-931,1026`). Bare-symbol queries inject up to 5 defining chunks (`searcher.ts:1036-1062`).
9. **Rerank (only if requested or gated).** ColBERT MaxSim over those 20 (`searcher.ts:1069-1134`).
10. **Scoring.** `base` is the rerank score if one exists, otherwise the fused score; `blended = base + 0.5 x fused` (`searcher.ts:1158-1162`). `applyStructureBoost` then multiplies (`searcher.ts:341-449`):
    - anchor chunks 0.99 (`:350-354`)
    - function, class, method, interface or type chunks 1.1, times role boosts (ORCHESTRATION 1.5, DEFINITION 1.2, IMPLEMENTATION 1.1), reference-count boosts 1.1 and 1.25, and intent boosts 1.2 to 1.4 (`:355-406`)
    - test paths 0.5 unless the query asks for tests (`:412-420`)
    - docs and data 0.6 unless the query asks for docs (`:427-439`)
    - bodies under 50 characters that are not exported 0.9 (`:441-446`)
    
    A chunk that defines the queried symbol is multiplied by 5 (`:1154-1176`). PageRank adds a small amount only when `GMAX_PAGERANK=1` (`:1195-1234`), and it is not set on the daemon (see below).
11. **Order, dedup, per-file cap.** Sort by score (`:1237`). `deduplicateResults` drops repeated IDs and chunks that overlap by more than 50% in the same file (`:451-492`). At most 3 hits per file, cut to `-m`, which defaults to 5 (`:1010-1018,1252-1266`; `src/commands/search.ts:31-35`).
12. **Display score.** Each score is divided by the top score, so the top hit is always 1.0. Above 0.8 is labelled High and above 0.5 Medium (`:1310-1329`).
13. **`--agent` output.** Hits are grouped by file in order of each file's best hit (`src/lib/output/agent-search-formatter.ts:208-259`). A lower-scoring chunk from the top file therefore prints above a higher-scoring chunk from the next file.

**Daemon environment.** The daemon process (pid 107201) has only `GMAX_DAEMON_IDLE_TIMEOUT_MS` among `GMAX_*` names (checked with `tr '\0' '\n' < /proc/107201/environ | cut -d= -f1 | rg '^GMAX_'`). Every ranking knob therefore runs at its default: doc penalty 0.6, test penalty 0.5, no PageRank, gate threshold 0.7.

**A second search path.** Runlist's document search (`gmax mcp --existing-index-only`, `src/lib/daemon/document-search-handler.ts`, `DOCUMENT-SEARCH.md`) is dense-only, with no FTS, rerank or penalties, and its score is `1/(1+cosineDistance)`. It reports `indexedMtimeMs` in status (`document-search-handler.ts:99-100`) but does not rank by it.

## 2. Recency

**No ranking stage uses time.**
- **Stored rows have no time column.** The LanceDB schema is id, path, hash, content, display_text, line range, vector, chunk_index, is_anchor, context_prev and context_next, chunk_type, complexity, is_exported, colbert data, symbol lists, imports and exports, role, parent_symbol, file_skeleton and summary (`vector-db.ts:1076-1170`, `src/lib/store/types.ts:7-47`).
- **mtime lives only in the change-detection cache** (`MetaEntry.mtimeMs`, `src/lib/store/meta-cache.ts:11-17`). That cache decides what to reindex and never feeds ranking.
- **No search, output or ranking file refers to time.** `rg -i "mtime|recen|archiv|deprecat|superseded|frontmatter|commit_time|indexed_at|updated_at|modified"` over `src/lib/search`, `search-handler.ts`, `search*.ts` and `src/lib/output` finds only comments. `gmax recent` is deprecated in favour of `gmax log` (`src/commands/recent.ts:4`) and is not part of search.
- **The only way a date can matter is as text.** `formatChunkText` writes `// <path>` and `File: <path>` into every chunk's `content` (`src/lib/index/chunker.ts:137-181`), and `content` is both embedded and indexed for full text (`src/lib/workers/orchestrator.ts:265-279`). A date in a filename is therefore a searchable token. Frontmatter is not stripped: `buildAnchorChunk` puts each file's first 30 non-blank lines (or 1,200 characters) into an anchor chunk (`chunker.ts:182-200`), so `status:` and `updated:` lines are ordinary text. Typing a date into the query matches it lexically. Nothing compares dates.

**On this repo, mtime and git dates are noise.**
- `find docs/plans/archived -name '*.md' -mtime -30` returns all 1,082 of 1,082 archived plans. All 844 active plans are also within 30 days.
- Only 37 archived plans have an `updated:` value on or after 2026-10-10.
- `docs/plans/archived/ios-wallet-enhancements.md` has `updated: 2026-05-07`, but its mtime is 2026-10-25 and its last git commit 2026-10-23. Why archived files were touched recently was not checked; archive and rename do repair links across the doc roots (`runlist.config.mjs:67-74`), which is one possible cause.
- The only usable date is the `updated:` frontmatter that runlist writes, which 2,793 docs carry.

## 3. Archived docs

- **Nothing excludes archives by default.** gmax's default ignore list has no archive pattern (`src/lib/index/ignore-patterns.ts:36-119`). `FilePolicy` reads `.gitignore` and `.gmaxignore` (`src/lib/index/file-policy.ts:55-61`).
- **The platform `.gmaxignore` excludes only plan-asset JSON and iOS screenshots** (`<repo>/.gmaxignore:2-3`).
- **The ranking code has no path check for archive, deprecated, old or superseded** (same grep as section 2).
- **Frontmatter is read only to spot codegen banners** (`src/lib/utils/file-utils.ts:177-200`), never for status.
- **What is in the index:**
  - `docs/plans/archived` (1,083 tracked files) is indexed; `gmax "baton handoff prompt" --in docs/plans/archived -m 2` returns hits.
  - So are `docs/archived` (5), `docs/business/archived` (4), `docs/dev/archived` (1), `docs/modules/archived` (1) and `docs/modules/comms/archive` (3).
  - `docs/prompts/archived` (4,279 files) is excluded, because `.gitignore:192` ignores `docs/prompts/`; `gmax ... --in docs/prompts` returns `(none)`.
- **How platform docs are retired:**
  - `runlist archive` moves a doc into an `archived/` folder and sets `status: archived` (`runlist.config.mjs:35,129,139,151,159`). All 1,093 `status:` lines under `**/archived/**` read `archived`, and no doc outside those folders carries `status: archived`.
  - Docs can also retire in place: 65 docs outside archived folders carry `status: outdated` or `status: deprecated`, which the doc vocabulary allows (`runlist.config.mjs:133-140`).
  - `docs/modules/comms/archive/*.md` sits in a folder named `archive`, not `archived`, and carries `status: deprecated` with `superseded_by: ../comms.md`.
  - Only 11 docs carry a superseded-by marker.
- **Runlist's own app search already hides archives.** `src/app-semantic-search.mjs:90-91` (runlist `9010abd`) treats a doc as archived when a path segment equals `archiveDir` or its status is `archived`, and drops it unless the request sets `archived: true`. That rule misses the comms `archive/` docs, whose folder is `archive` and status `deprecated`.

## 4. Docs compared with code

- **One factor of 0.6 applies to chunks with role DOCS**, or whose path ends in `.md`, `.mdx`, `.txt`, `.json` or `.lock`, or contains `/docs/` (`searcher.ts:427-439`). Every Markdown chunk has role DOCS (`chunker.ts:338-340`).
- **The query can waive it.** The waiver triggers on "documentation", "doc", "docs" or "readme", or on "guide" or "manual" in a noun position (`artifact-preference.ts:18-21`).
- **Code gets boosts.** By the code these reach about 3.18x (1.1 x 1.5 x 1.1 x 1.25 x 1.4, `searcher.ts:366-403`), plus a further 5x for a chunk defining a bare-symbol query (`:1154-1176`). The largest seen in these runs was 2.27x.
- **No penalty or boost depends on folder**, apart from the test-path and `/docs/` checks. Within docs, every file is treated alike.
- **Earlier decisions.** gmax's archived `docs/archived/agent-ux-proposals.md:90-103` judged a full code/docs index split unjustified, kept `GMAX_DOC_PENALTY` as the adjustable setting, and unified it into one penalty (S2). In this repo the setting is in env only and is not set on the daemon.

## 5. Live behaviour

Each query was run unscoped at the default `-m 5`, then with `--in docs -m 20`, all with `--agent --scores --explain`. Neither `-s` nor `GMAX_RERANK` was set. The index reported `syncing · ~1 files pending` throughout. Ranks below are hit positions as printed (grouped by file). Scores are normalized per query and cannot be compared across queries. In the explain output, `rerank` equal to `fused` means rerank did not run.

| # | Query | Older or archived doc | Current or newer doc | Notes |
|---|---|---|---|---|
| P1 | `how companies are priced and billed per place on the bill` | `plans/archived/pricing-billing-recenter.md` (status archived, "Superseded by v2 ... pricing-2.md" at :121): **default rank 4** (s=0.534); **docs rank 7** (s=0.693) | `plans/pricing-2.md` (active): **not in default 5 or docs top 20**. Indexed: `--file pricing-2.md` returns 3 hits | Default rank 1 is code (`inquiries.ts:800`, fused 0.016 x boost 1.32) ahead of docs with fused 0.026 x 0.60 |
| P2 | `Apple Wallet pass for door access credentials` | `plans/archived/ios-wallet-enhancements.md`: not in top 20 (indexed; `--file` returns hits). Another archived plan, `plans/archived/wallet-pass.md`: **default rank 4, docs rank 9** (s=0.907) | `plans/wallet-access-strategy.md` (paused, the named successor): **default rank 3, docs rank 6** (s=0.907 to 0.912) | Ranks 1 and 2 are dated audit lint reports (`lint-report-*-2026-10-06.md`). Archived and current tie on score here |
| P3 | `comms data model for conversations, messages and channels` | `modules/comms/archive/comms-data-model.md` (deprecated, "v3 Archived"): **docs ranks 1 to 3** (s=1.000). `comms/archive/channel-architecture.md` docs rank 6 | `modules/comms/comms.md` (current, the named successor): **docs rank 17** (s=0.613) | The default top 5 are all code (boosts 1.0x to 2.27x). 6 more archived comms plans sit in docs ranks 12 to 20 |
| P4 | `security audit findings` (dated family) | `audit/security-audit-2026-09-24.md`: rank 2 (s=0.940) | `security-audit-2026-09-26.md`: **rank 1** (s=1.000). `security-audit-2026-09-29.md` (newest): rank 3 (s=0.926) | Same order in default and docs scope. Newest is not first; the order follows text match only. `plans/archived/security-remediation.md` is default rank 5 |
| P5 | `android app recenter` (dated pair) | `research/android-recenter-2026-09-29.md`: **docs rank 1** (s=1.000) | `research/android-recenter-2026-10-28.md`: docs rank 4, its best chunk s=0.968 (printed after the 09-29 file's 3 hits because of grouping) | The default top 5 are all code |
| Control | P1 plus the word `archived` | `pricing-billing-recenter.md`: **ranks 1 to 3 in both scopes** | `pricing-2.md`: absent | The concentration gate fired (`rerank=30.35`, so ColBERT ran with `GMAX_RERANK` unset). The word "archived" in the path, the frontmatter and the body moved the archived plan to the top |
| P1b | `one price per door per month with an account minimum across every vertical` (worded from `pricing-2.md` § Direction under study), docs -m 20 | `pricing-billing-recenter.md`: ranks 14 and 15 (s=0.757) | `pricing-2.md`: **ranks 9 to 11** (s=0.796) | Successor ahead when the query uses its wording. Ranks 1 to 3 are `plans/assets/pricing-2/proposal.md` |
| P3b | `AI-first messaging transport, message delivery and handoffs` (worded from `comms.md`'s summary and headings), docs -m 20 | `plans/archived/comms-message-delivery.md`: **ranks 1 to 3** (s=1.000) | `comms/comms.md`: ranks 5 to 7 (s=0.931) | An archived plan still leads with the successor's own wording |

Query bias: the P1 query paraphrases the archived plan's line 121, and the P3 query contains the archived file's name (`comms-data-model`), which is in every chunk of that file. P1b and P3b correct for that.

**Whole shortlist and option simulations** (`runs/p1-docs40-pf40.txt`, `runs/p3-docs40-pf40.txt`, `runs/p1-excl-docs20.txt`, `runs/p3-excl-docs20.txt`):
- **The successor is in the shortlist.** With `--in docs -m 40 --per-file 40` the full 40-row shortlist prints. `pricing-2.md:127` sits at rank 24 of 40, so the default per-file cap and `-m 20` cut it, but it was not lost at retrieval. `comms/comms.md:17` sits at rank 15 of 38.
- **A simulated (scores on paths with an `archived` or `archive` segment x 0.5, re-sorted, offline on the saved output; dedup and per-file cap ignored).** `pricing-2.md:127` moves from 24 to 20, and every archived chunk drops below rank 32. `comms/comms.md:17` moves from 15 to 8, and the deprecated `comms-data-model.md:10` moves from 1 to 15.
- **B simulated** (`--exclude docs/plans/archived --exclude docs/modules/comms/archive`, run live, no archived path in either output). `pricing-2.md:127` enters at rank 17 (was absent). `comms/comms.md` moves from 17 to 12; `situ-data-models.md` and `crew-messaging.md` take the top.

What an agent sees today:
- Archived plans are recognisable only from the path (`/archived/`).
- A deprecated doc in `comms/archive/` outranks its current replacement, and its status is not shown.
- In P1 the successor never reaches the top 20.
- Dated families come back in text-match order, not date order.

Commands, as run from `<repo>`:
`gmax "<query>" --root <repo> --agent --scores --explain`, then the same with `--in docs -m 20` added. Plus the `--file pricing-2.md -m 3` and `--file ios-wallet-enhancements.md -m 3` checks and a `--in docs -m 50` P3 run, which found `comms/comms.md` at hit line 27.

## 6. What the platform repo expects

- **CLAUDE.md § Plan rules:** a plan is archived only with `runlist archive` on his word, and an item leaves a plan only when he defers it by name. Archived plans are therefore deliberate records, not trash.
- **CLAUDE.md § 6:** every fact lives in 1 place and everything else links to it. Archived plans hold rulings: 189 of them contain "ruled" or "ruling", and `pricing-schedule.json` cites 8 archived plans as rate sources. Whether each ruling also lives in a current doc was not checked.
  - `packages/shared/src/pricing-schedule.json` cites 8 distinct archived plans as rate sources (29 distinct plan paths in total).
  - 189 archived plans contain "ruled" or "ruling".
  - `runlist.config.mjs:71-74` treats those citations as records that must not be rewritten.
- **Runlist's retirement vocabulary:**
  - plans: `archived` (moved to `archived/`)
  - docs: `current`, `partial`, `draft`, `outdated`, `deprecated`, `archived`
  - research: `current`, `draft`, `outdated`, `archived`
  - Sources: `runlist.config.mjs:109-161`. `outdated` and `deprecated` docs stay where they are.

## 7. Existing plans and items

No open item in gmax's plans owns ranking by recency, archive status or folder.
- **Checked:** `rg -i` for recency, archived docs, doc penalty, demote and newer/stale docs over `tools/gmax/docs/plans/*.md`, `known-limitations.md`, `future-sessions.md` and `search-degradation.md`; ranking, relevance, penalty, boost and archive headings; open `- [ ]` boxes.
- **Platform plans.** `docs/plans/gmax-recenter.md` (status research) covers gmax CPU and memory load and a 24 h read-only sampler, not ranking (`runlist show gmax-recenter`: headings Problem, Evidence, Options, Phases 1 to 4, Open questions). Its Phase 1 is probably the live-store measurement the brief protects (not confirmed). `rg -i gmax` over `tooling-friction-review.md`, `agent-tooling-repairs.md` and `tooling-problems.md` finds no ranking, archive or stale-doc item.
- **Related records** (none of them owns this question):
  - `known-limitations.md:93-99` says to "record real misses across repos before changing weights". That bears on how any option here should be tested.
  - `gmax-delivery.md:6663,6768-6816` is the artifact-preference ranking fix (0.26.89) and its holdout, which noted that the pipeline sometimes demoted a dense rank-1 answer.
  - `colbert-backend-evaluation.md:550-575` is rerank model evaluation, including document targets.
  - `docs/archived/agent-ux-proposals.md:90-103` is the code/docs split, judged unjustified.
  - Platform `docs/plans/session-history.md:105-124`, item 4, says date constraints need real typed metadata and must filter before candidate truncation (written for conversation history; the same mechanism applies here).

## Policy options

Shared constraints:
- **A late adjustment can only reorder the shortlist.** Factors in `applyStructureBoost` act on the 40 or so candidates left after the pooled-cosine cut (`searcher.ts:1025,1158-1168`). They reorder those but cannot pull in a doc that missed the cut. In P1 and P3 the successor was inside the 40, so a late factor was enough there; that will not hold for every query.
- **Only a pre-filter frees retrieval slots.** A WHERE-clause exclusion, like `--exclude`, takes effect before retrieval.
- **Seeds show the precedent** for weighting at candidate generation (`searcher.ts:531-537,807-813`).

### A. Demote by archive path at query time, with a history waiver and a visible tag

- **Rule.** Multiply chunks whose path has a segment `archived` or `archive` by a factor, for example 0.5, next to the doc penalty in `applyStructureBoost`. Skip it when the query asks for history ("archived", "superseded", "previous", "history", "old plan"), as `artifactPreference` already does for tests and docs. Tag those hits `[ARCHIVED]` in agent output.
- **What an agent sees.**
  - Archived plans move down within the shortlist but stay present and labelled.
  - P3's deprecated comms doc drops below others because its folder is `archive`: simulated, `comms.md` moves from 15 to 8 and `comms-data-model.md` from 1 to 15.
  - P1's successor moves from 24 to 20 in the simulation, so with `-m 5` it still does not show; the archived plan drops out of the top 30.
  - The 65 in-place `outdated` or `deprecated` docs are unaffected.
- **Build.** 2 files (`searcher.ts`, `artifact-preference.ts`), the formatter tag and tests. One env knob (`GMAX_ARCHIVE_PENALTY`). No schema change, no reindex.
- **Risk.** Low. Nothing is hidden. The segment names are a convention that gmax would hardcode or read from config.

### B. Exclude archives from default search, with an `--include-archived` flag and a hidden-count line

- **Rule.** Add the archive prefixes as default `excludePrefixes` in the WHERE clause (`searcher.ts:115-123`). Print a footer such as "3 archived matches hidden; --include-archived". Runlist's app search already behaves this way (`app-semantic-search.mjs:90-91`).
- **What an agent sees.** Archived plans vanish from results, and current docs take their retrieval slots. Run live, P1's successor entered at rank 17 and P3's moved from 17 to 12.
- **Build.**
  - A CLI flag, an MCP parameter and a per-project prefix list (repo config).
  - The hidden-count footer needs a second, cheap query or a count.
  - No reindex.
- **Risk.** High for this repo.
  - Rulings recorded in archived plans (8 rate citations, 189 plans mentioning rulings) disappear unless the agent knows to add the flag.
  - It also misses in-place deprecated docs.

### C. Read frontmatter status and `updated:` at index time into columns, then demote by status and break ties by date

- **Rule.**
  - The chunker parses frontmatter once per file and stores `doc_status` and `doc_updated` on each chunk.
  - Search demotes `archived`, `deprecated` and `outdated` by a factor, with the same waiver as A, and shows the status in output.
  - A small additive term from `doc_updated` breaks ties only among docs.
- **What an agent sees.**
  - Everything A gives, plus the 65 in-place deprecated or outdated docs and the comms `archive/` docs, each demoted and labelled by status.
  - Dated families such as P4 and P5 come back newest first when the text match is close.
- **Build.**
  - A schema change in `vector-db.ts` and `types.ts`.
  - Frontmatter parsing in `chunker.ts`.
  - A mapping from status words to treatment, in config so gmax stays repo-neutral.
  - Adding the columns does not need a reindex: `evolveSchema` already adds nullable columns in place, and existing rows read empty until their file is reindexed (`vector-db.ts:1144-1181`). Filling them means re-chunking every Markdown file (about 6,500 tracked `.md`/`.mdx` files), not the whole 661k-chunk store. Until then old rows carry no status.
  - Not before the live-store measurement ends at 2026-11-11 16:00 UTC.
- **Risk.**
  - Medium build risk, because the schema change touches the shared store.
  - Ties gmax to frontmatter conventions, though they are configurable.
  - Newer is not always right: a newer audit report does not replace a plan, so the date term must stay a tie-break.

### D. Zero code: add `docs/plans/archived/` to the platform `.gmaxignore`

- **What an agent sees.** Archived plans never appear, and nothing indicates they exist.
- **Build.** 1 line.
- **Risk.**
  - Deletes about 1,082 files' chunks from the live store. A policy-file change triggers a catch-up (`batch-processor.ts:191-195`, `watcher-manager.ts:188-197`) that force-deletes every known path the walk no longer sees (`watcher-manager.ts:866-873`). Barred during the measurement.
  - Hides rulings entirely; only `rg` would find them.
  - Not recommended. Listed because it is the cheapest route.

## Recommendation

**A now, C later if A's evidence calls for it.**

- **A matches the repo's rules.** Archived plans are deliberate records that hold rulings (189 mention one; 8 are rate sources), so they must stay findable (rules out B and D). The current doc should still come first for a neutral query.
- **A changes no data, needs no reindex and is fully reversible** with an env knob, and can ship without touching the live store.
- **The tag fixes a gap that exists today.** Results do not say a hit is retired unless the agent reads `/archived/` in the path.
- **Measure before tuning,** as `known-limitations.md:93-99` asks. Freeze the 5 pairs above, plus any he names, as fixed regression cases with their current ranks, and set the factor against them. He runs any eval that loads models.
- **Move to C when A's cases show the gap,** meaning in-place deprecated docs such as the comms docs, or dated families. C is the only option that covers `outdated`, `deprecated` and real dates, at the cost of 2 new columns and re-chunking the Markdown files.

Open product question for him: should a retired doc be demoted and labelled (A or C), or hidden by default behind a flag (B, Runlist's current behaviour)? Agents would see either fewer stale answers or fewer missed rulings.

## Checked and not checked

**Checked:**
- All of `searcher.ts`.
- `intent.ts`, `artifact-preference.ts` and `per-file.ts`.
- The relevant lines of `search-handler.ts`, `search-run.ts`, `search.ts`, `agent-search-formatter.ts`, `chunker.ts`, `orchestrator.ts`, `vector-db.ts` (schema and FTS), `types.ts`, `meta-cache.ts`, `file-policy.ts`, `ignore-patterns.ts`, `file-utils.ts`, `document-search-handler.ts` and `recent.ts`.
- The installed dist constants and the daemon's `GMAX_*` variable names.
- Platform `.gmaxignore`, `.gitignore` archive lines, `runlist.config.mjs` (statuses, archiveDir, excludeDirs) and runlist `app-semantic-search.mjs:80-100`.
- 17 live searches (6 pairs and controls, each in 2 scopes; P1b, P3b; 2 full-shortlist runs; 2 exclusion runs) plus 5 checks.

**Not checked:**
- `pagerank.ts` and `seed-weight.ts` internals (both off by default).
- The ColBERT scoring math.
- MCP search tools, apart from the document-search contract.
- Whether markdown goes through tree-sitter or the fallback chunker (it does not change ranking).
- Ranks were not re-measured once the index finished syncing; 1 file was pending throughout.
- No evaluation run or model start. The A simulation is offline arithmetic on 2 saved shortlists and the B runs are 2 queries; neither is a measurement.
