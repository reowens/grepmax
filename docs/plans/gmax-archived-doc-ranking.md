---
type: plan
status: planned
created: 2026-11-10T06:36:57Z
updated: 2026-11-10T06:36:57Z
surfaces:
  - search
  - mcp
  - store
modules:
  - src/lib/search/searcher.ts
  - src/lib/search/artifact-preference.ts
  - src/lib/output/agent-search-formatter.ts
  - src/lib/output/formatter.ts
  - src/lib/output/compact-results.ts
  - src/lib/utils/formatter.ts
  - src/lib/output/mcp-results.ts
  - src/commands/mcp.ts
  - src/commands/search.ts
  - src/commands/search-run.ts
  - src/lib/daemon/search-handler.ts
  - src/lib/daemon/ipc-handler.ts
  - src/lib/store/types.ts
  - src/lib/store/vector-db.ts
  - src/lib/index/chunker.ts
domain: Search demotes archived and retired docs and labels them in results, never hiding them by default
audience: internal
parent_plan: docs/plans/gmax-delivery.md
related_plans:
  - docs/plans/gmax-delivery.md
  - docs/plans/gmax-watcher-correctness.md
  - docs/plans/gmax-catchup-throughput.md
related_docs:
  - docs/known-limitations.md
current_state: "The ruling in gmax-delivery.md § Archived and superseded docs is not built. Every Markdown or /docs/ chunk takes the same 0.6 factor (src/lib/search/searcher.ts:427-439), so in <repo> 1,097 indexed docs under an archive or archived folder compete as equals with current docs. On 0.26.113, re-run 2026-11-09, the current comms.md sits at score rank 15 of 38 behind its deprecated predecessor at rank 1. Proposed; no build started."
next_step: "Phase 3: ship phase 1 in the gmax-watcher-correctness release and re-run the archived-versus-successor pairs on the installed build; phase 2 waits for the regrowth record to end and its own go."
---

# Gmax archived doc ranking

## Problem

The ruling (`gmax-delivery.md:86-105`): search demotes archived docs and labels them in results; they are never hidden by default. Step 1 is a search-time path demotion, a result label and a history waiver with no reindex. Step 2 reads frontmatter `status` at index time.

What search does today:

- **No stage reads archive state, time or frontmatter.** `applyStructureBoost` (`src/lib/search/searcher.ts:341-449`) applies 1 docs factor, 0.6, to any chunk with role DOCS or a path ending in `.md`, `.mdx`, `.txt`, `.json` or `.lock` or containing `/docs/` (`:427-439`). The query waives it with "docs", "documentation", "readme" or a noun-position "guide" or "manual" (`src/lib/search/artifact-preference.ts:18-21`).
- **An archived doc outranks its successor.** Re-run on 2026-11-09 against the running daemon (0.26.113), the query `comms data model for conversations, messages and channels`:
  - with `--in docs -m 40 --per-file 40`: `docs/modules/comms/archive/comms-data-model.md:10` is score rank 1 and the current `docs/modules/comms/comms.md:17` is rank 15 of 38;
  - with `--in docs -m 20`: `comms.md:17` prints at position 17.
- **Results never say a hit is retired.** The only signal is `/archived/` in the path. `docs/modules/comms/archive/*.md` carries `status: deprecated`, which no output shows.
- **Evidence:** [findings](assets/archived-doc-ranking-20261109/findings.md), checked against the source at `33d2abe`. `git diff --stat b3cb28c HEAD -- src/lib/search src/lib/output src/commands/mcp.ts src/commands/search.ts` is empty, so the running 0.26.113 matches the lines cited here.

## What counts as archived in step 1

**Rule:** a chunk is archived when its path, taken relative to its project root (see the path base under Where the demotion sits), has a folder segment equal to `archive` or `archived`, case-insensitive. The demotion and the label apply only when the chunk also meets the docs predicate at `searcher.ts:427-434` (`isDocOrData`), whether or not the docs factor was waived for that query.

**Counts in <repo>, 2026-11-09.** Source: `git ls-files --cached --others --exclude-standard`, filtered by gmax's indexable extensions (`src/config.ts:462-513`), the default ignores (`src/lib/index/ignore-patterns.ts:36-119`), `<repo>/.gmaxignore:2-3` and the 2 MB cap (`src/config.ts:402`). Result: 40,019 indexable files, 6,404 of them Markdown.

| Folder | Kind | Files |
| --- | --- | --- |
| `docs/plans/archived` | docs | 1,083 (1,082 `.md` plus 1 `.sql`) |
| `docs/archived` | docs | 5 |
| `docs/business/archived` | docs | 4 |
| `docs/modules/comms/archive` | docs | 3 |
| `docs/dev/archived` | docs | 1 |
| `docs/modules/archived` | docs | 1 |
| `packages/db/src/archive` | code | 5 (old seed scripts) |
| `packages/api/scripts/archived` | code | 3 |
| `packages/api/src/migrations/archived` | code | 1 |

- **Totals:** 1,106 files with an archive segment, 1,097 of them docs and 9 code. The code folders are indexed: `gmax "seed data for a pilot property" --in packages/db/src/archive` returned `seed-la-pilot.ts` hits. Because code folders match, the demotion is docs-only, as the ruling's width requires.
- **Runlist archive:** `archiveDir = 'archived'` (`<repo>/runlist.config.mjs:35`). `runlist archive` sets `status: archived` (`:129`, `:139`, `:151`, `:159`). All 1,093 files with `status: archived` sit under an archive segment, and none sit outside one. The path rule therefore covers every runlist-archived plan and doc.
- **What step 1 misses:** 62 Markdown files outside any archive segment carry `status: deprecated` (31) or `status: outdated` (31), which the doc vocabulary allows (`runlist.config.mjs:137-138`, `:150`). The findings' figure of 65 counted docs outside `archived/` folders: the same 62 plus the 3 deprecated docs in `docs/modules/comms/archive`, which step 1 does catch because their folder is `archive`.
- **No other retirement folder names:** no indexable path has a segment `archives`, `_archive`, `old`, `legacy`, `deprecated`, `superseded` or `retired`, except the canvas route folder `packages/canvas/src/app/files/archives`, which the rule does not match.

## Where the demotion sits and how it composes

- **Stage:** inside `applyStructureBoost`, right after the docs factor (`searcher.ts:427-439`). This is after fusion, after the cut to 200 (`:907-912`), after the pooled-cosine cut to 40 (`:920-964`) and after any rerank, and before sort, dedup and the per-file cap (`:1237-1266`).
  - **Why not before the cut:** the cut to 40 sorts by pooled cosine (`:956-963`), not by fused score. A factor on fused scores would move only the cut to 200. Moving the cut to 40 too would mean changing the pooled-cosine sort and the concentration gate (`:862-903`), which counts the top 10 fused candidates. In both measured pairs the successor was already inside the 40 (P1 rank 24 of 40, P3 rank 15 of 38; findings § 5), so a late factor reorders enough.
  - **Limit:** a successor that misses the 40 stays missing.
- **Factor:** 0.5, read from `GMAX_ARCHIVE_PENALTY`. Accepted values are greater than 0 and at most 1; anything else falls back to 0.5, and 1 turns the demotion off. Unlike `GMAX_DOC_PENALTY` (`:437`), which uses `|| 0.6`, it is validated with `Number.isFinite`, the way `GMAX_DEF_BOOST` is (`:1154-1156`). The daemon sets no `GMAX_*` ranking variable (findings § 1), so 0.5 is what runs.
  - **Sweep on the saved 40-row shortlists, offline:** factor 0.7 moves `comms.md:17` from 15 to 11; 0.5, 0.4 and 0.3 each move it to 8. `pricing-2.md:127` moves from 24 to 20 at every factor from 0.7 down to 0.3. 0.5 is the mildest factor that reaches the best rank in both pairs.
- **Stacks with the docs factor:** an archived doc scores 0.6 x 0.5 = 0.30 of its blended score, times 0.99 for an anchor chunk.
  - **Not a repeat of the S2 bug:** the bug recorded at `searcher.ts:422-426` applied 1 condition twice: a DOCS role and a docs path each took 0.6 for the same chunk. The archive factor tests a separate condition, applied once.
  - **Why not replace the docs factor:** swapping 0.6 for 0.5 on archived docs changes their score by only 0.83x relative to current docs, which is weaker than the 0.7 stacked run that left `comms.md` at 11.
  - **Under the documentation waiver,** the docs factor is skipped and the archive factor still applies, so an archived doc scores 0.5 against 1.0 for a current doc.
- **Path base:** stored paths are absolute. A repo checked out under a folder named `archive` would demote every doc if the match ran on the absolute path. The match always runs on the path relative to its project root:
  1. the project root passed in a new search option; `search-handler.ts` sets it from `payload.projectRoot` (`src/lib/daemon/search-handler.ts:88`);
  2. for cross-project search, where `pathPrefix` is undefined (`src/commands/search.ts:345-351`), the entry of `filters.projectRoots` that contains the path;
  3. when neither is known, nothing is demoted or labelled. The eval scripts (`src/eval.ts:642`, `src/eval-oss.ts:402`, `src/eval-seed.ts:229-236`, `src/eval-tokens.ts:143`) pass no root and keep today's scores.

  Every in-process caller of `Searcher.search` passes the root: `search-handler.ts:132`, `src/commands/search-run.ts:342`, `src/commands/mcp.ts:785`, `src/commands/context.ts:235` and `src/commands/skeleton.ts:199`. `gmax serve` goes through the daemon (`src/commands/serve.ts:274`).
- **Explain:** `scoreBreakdown` gains `archive` (the factor applied, or 1). `boost` keeps its meaning, the total ratio (`:1180-1187`).

## The history waiver

The archive factor is skipped when any of these holds. The label stays in every case.

1. **Query terms.** A new `history` field in `artifactPreference` (`artifact-preference.ts:7-22`) matches:
   - `\b(?:archived|superseded|deprecated|retired)\b`
   - `\b(?:old|older|previous|earlier|original|former|prior)\s+(?:plans?|designs?|versions?|docs?|documents?|approach(?:es)?|decisions?|rulings?|specs?)\b`
   - `\bhistory\s+of\b`

   Not bare `history`, `archive` or `old`: "conversation history" appears in 12 code files and "archive" is a verb in product code.
2. **A flag.**
   - CLI: `--history` on `gmax search` (`src/commands/search.ts:28-135`), sent as `history: true` in the daemon payload (`src/commands/search-run.ts:139-160`, `DaemonSearchPayload` at `search-handler.ts:20-34`, parsed in `src/lib/daemon/ipc-handler.ts:368` next to `seeds`).
   - MCP: a `history` boolean on `semantic_search` (`src/commands/mcp.ts:3744-3800`).
3. **A scope inside an archive folder.** When `pathPrefix`, or every entry of `inPrefixes`, has an archive segment relative to the project root (a single `--in` collapses into `pathPrefix`, `src/lib/utils/scope-filter.ts:72-77`), the caller asked for archived material, so nothing is demoted. For example `--in docs/plans/archived`.

**False positives:** the query waives the demotion when it is not about history.

- `archived` appears in 2,568 code files under `packages` and `services`, `superseded` in 1,890 and `deprecated` in 131: these are statuses of product records. "How are archived conversations restored" or "deprecated API fields" match.
- "Previous version of the menu" in a versioning feature matches.
- "History of a reservation" in an audit-trail sense matches.
- **Cost:** in each case the query ranks archived docs as it does today, with the 0.6 docs factor and the label. No result is lost.

**False negatives:** "what was decided about door pricing" has no trigger. The archived plan that holds the ruling is demoted but present and labelled. The agent adds `--history`.

The waiver is recorded in search diagnostics as `historyRequested`, next to `documentationRequested` (`searcher.ts:981`).

## The label

- **Data:** `ChunkType` (`src/lib/store/types.ts:62-83`) gains `docStatus: "archived" | "deprecated" | "outdated" | null`. Step 1 sets only `"archived"`, from the path rule. Step 2 adds the other 2 values from frontmatter, so no output schema changes again. `mapRecordToChunk` (`searcher.ts:226-330`) fills it.
- **`--agent`:** ` [ARCHIVED]` after the role tag on every hit line (`src/lib/output/agent-search-formatter.ts:248-260`), and also on the `(n hits):` header line of a grouped file (`:243-245`).
- **`--agent --explain`:** `explainSuffix` (`:194-197`) adds `archive=0.50x` when the factor applied.
- **`--scores` and `--explain` in TTY output:** `formatResults` (`src/lib/output/formatter.ts:34-110`) adds `[ARCHIVED]` to the header, and its `Scoring:` line (`:103-106`) adds `archive=`.
- **Plain output (`--plain` or no TTY):** `toTextResults` (`src/lib/output/compact-results.ts:5-30`) drops every field it does not copy, so it maps `docStatus`, and `formatTextResults` (`src/lib/utils/formatter.ts:66` onward) prints the tag.
- **`--compact`:** `toCompactHits` (`compact-results.ts:85-87`) maps it. The table and TSV views (`:150-162`, `:196-221`) append `ARCH` to the role cell, so the column count stays the same.
- **JSON:** `gmax search` has no `--json` option (`src/commands/search.ts:28-135`), and `formatJson` (`src/lib/output/json-formatter.ts:20`) has no caller. JSON reaches clients in 3 places:
  - the daemon search reply `data` (ChunkType, `search-handler.ts:157-165`);
  - the `gmax serve` reply (`src/commands/serve.ts:100`, `:274`), which carries ChunkType;
  - MCP `structuredContent`: `structuredSearch` (`src/commands/mcp.ts:1232-1250`) adds `docStatus` to each match, and the output schema (`src/lib/output/mcp-results.ts:125-143`) gains `docStatus: z.enum([...]).nullable()`. `schemaVersion` stays 1 because the field is additive.
- **MCP text:** the pointer format (`formatMcpPointerSearchResults`, `mcp.ts:408`) and the detail format's first line (`mcp.ts:1336`) add `[ARCHIVED]`.
- **Not covered:** the document search used by runlist (`src/lib/daemon/document-search-handler.ts`) is dense-only with no factors, and step 1 leaves it unchanged. Runlist's own app search already drops archived docs unless asked (findings § 3).

**Tests that pin these formats:**

- `tests/search-artifact-preference.test.ts:9-41`: the `toEqual({ tests, documentation })` table. Every row gains `history`.
- `:131` and `:162` pin the diagnostics settings.
- `tests/agent-search-formatter.test.ts:28`, `:83`: hint selection and pointer locations.
- `tests/mcp-helpers.test.ts:216-240`: the MCP pointer format.
- `tests/mcp-sdk-v2.test.ts:104-112`: the `semantic_search` input and output schema.
- `tests/mcp-search-result-shape.test.ts:15-40`: mapped ChunkType extraction.
- `tests/ipc-search-scope.test.ts`: the payload fields that reach the searcher.
- No test pins the compact table or `formatResults` text.

## Phase 1: archive-folder demotion, history waiver and label (no reindex)

- [x] `applyStructureBoost` applies `GMAX_ARCHIVE_PENALTY` (default 0.5) to docs-predicate chunks with an `archive` or `archived` segment relative to the project root, after the docs factor, and records it in `scoreBreakdown.archive`.
- [x] `Searcher.search` takes the project root as a new option, and the 5 in-process callers listed under Path base pass it. Cross-project search uses the containing entry of `filters.projectRoots`. Callers with no root keep today's scores.
- [x] `artifactPreference` gains `history` with the 3 patterns above. `--history` (CLI), `history` (daemon payload, IPC parse) and the MCP `history` argument waive the factor, and so does a scope inside an archive folder. Diagnostics report `historyRequested`.
- [x] `ChunkType.docStatus` is filled by `mapRecordToChunk` and shown on every surface listed under The label.
- [x] Unit tests on stubbed scores, using the stubbed Searcher in `tests/search-artifact-preference.test.ts:43-114`:
  - an archived `.md` chunk with role DOCS gets exactly 0.6 x 0.5, once;
  - a code chunk under `packages/db/src/archive` keeps its code boost and has no label;
  - a history query and the flag each skip the factor and keep the label and the 0.6;
  - a documentation query gives 0.5 alone;
  - a project root under a folder named `archive` demotes nothing;
  - a single `--in` inside an archive folder demotes nothing and keeps the label;
  - `GMAX_ARCHIVE_PENALTY=1` turns the factor off, and `0`, `-1` and `abc` fall back to 0.5;
  - successor-over-archived order on a stubbed P3-shaped pool.
- [x] Format tests updated or added in the files listed under The label.
- [x] `GMAX_ARCHIVE_PENALTY` gets a row in the README environment table next to `GMAX_RERANK` (`README.md:738`), and `docs/known-limitations.md` states the rule (durable behaviour only, no status).
- [x] Agents can find `--history`: the agent cheatsheet (`src/lib/help/agent-cheatsheet.ts`), the plugin skill (`plugins/grepmax/skills/grepmax/SKILL.md`) and the `semantic_search` description (`src/commands/mcp.ts:3746`) each name it in 1 line.
- [x] `gmax-delivery.md` § Archived and superseded docs links this plan, and its numbers name the run each came from (`--in docs -m 20` for 17; the 38-row shortlist for 15 and the simulated 8).
- Built: the factor at `src/lib/search/searcher.ts:457` with the folder match in `src/lib/search/archive.ts`; the label through `src/lib/output/doc-status.ts` on `--agent`, the MCP pointer, detail and structured output (`docStatus`, nullable, `?? null` for an older daemon), TTY, plain and human text, and `--compact` (`DOCS ARCH`). `history` also crosses `gmax serve` (client body, HTTP parse, daemon command), and the client sends it only to a server whose `/health` advertises `historySearch: 1`. `src/lib/llm/tools.ts` passes the project root.
- Checked: `pnpm typecheck` and `tsc -p tsconfig.tests.json` clean; 1 focused `vitest run` over 13 files passed 236 of 236; `biome lint` clean on the changed files. After that run, `tests/doc-status-format.test.ts` swapped its control-character regex for `stripVTControlCharacters` to satisfy lint; phase 3's release check runs it.
- Not pinned by a test: the MCP detail first line, structured `docStatus: "archived"`, the `llm/tools` tag and the pretty compact table.

## Phase 2: frontmatter status column

- [ ] **Refresh mechanism (settled, checked first against the merged watcher module).** Catch-up calls `reconcileMetaEntry` (`src/lib/index/cache-coherence.ts:27-68`) on every indexable file before its mtime and hash skip (`src/lib/daemon/watcher-manager.ts:764-786`, then `:787-825`). A `MetaEntry` whose `hashVersion` is not current returns `reprocess` (`cache-coherence.ts:46-51`), and catch-up queues it with `forceReprocess: true` (`watcher-manager.ts:772-776`). The standalone path also treats such an entry as not cached (`src/lib/index/watcher-batch.ts:83-88`). The refresh uses that path:
  - a one-shot step at daemon start, after `evolveSchema`, reads the frontmatter of each Markdown file in each project (6,404 head reads in <repo>) and marks the entries of the retired ones with a non-current `hashVersion` in `MetaCache` (`src/lib/store/meta-cache.ts:11-17`), then records that it ran so it runs once;
  - the next catch-up reprocesses those files with no watcher-file edit.
  - **Cost:** a forced reprocess turns off embedding reuse (`src/lib/index/batch-processor.ts:773-777`), so those files are re-embedded in full. Keeping reuse would need a new reconciliation action handled in `watcher-manager.ts`, a file `gmax-watcher-correctness.md` phase 1 rewrites; this plan does not take that route.
- [ ] `VectorRecord` (`src/lib/store/types.ts:7-47`) and the table schema (`src/lib/store/vector-db.ts:1076-1141`) gain a nullable Utf8 `doc_status`. `evolveSchema` (`vector-db.ts:1152-1181`) adds list columns only today; it is extended to add this scalar column in place, with no full reindex.
- [ ] The chunker reads `status` from the leading `---` block of each Markdown file once (next to `buildAnchorChunk`, `src/lib/index/chunker.ts:184-200`) and stores `archived`, `deprecated` or `outdated` on every chunk of the file, or null. Reuse copies embeddings only (`orchestrator.ts:379-449`), so every rewritten row carries the current status.
- [ ] The searcher reads `doc_status` with the candidate columns. The archive factor applies when the path rule or `doc_status` holds, and `docStatus` reports the frontmatter value when present, so `[DEPRECATED]` and `[OUTDATED]` appear.
- [ ] **Refresh scope:** reprocess only Markdown files whose frontmatter status is one of the 3 values: 1,158 files in <repo> today (1,093 archived, 34 deprecated, 31 outdated). All other rows read null, which correctly means no retired status. This is not a re-chunk of all 6,404 Markdown files.
- [ ] **No `CHUNKER_VERSION` bump.** `src/config.ts:149-153` reserves a bump for changes that need a full reindex, and `gmax doctor` flags every project below it (`src/commands/doctor.ts:755`). The refresh completes the column without one.
- [ ] **Store timing:** the schema change and the refresh both write to the live store. They run only after the regrowth record ends at 2026-11-11 16:00 UTC (`gmax-catchup-throughput.md:320`, step 7) and after `gmax-watcher-correctness.md` phase 1 lands. Table version, fragment count, live rows and deleted rows are recorded from `gmax status --json` before and after.
- [ ] Tests: frontmatter parsing (quoted values, no frontmatter, `status:` in the body ignored), `evolveSchema` on a fixture table, the one-shot step marking only retired files and running once, and a `deprecated` doc outside an archive folder demoted and labelled.

## Phase 3: release and live check

- [ ] Phase 1 ships in the same release as `gmax-watcher-correctness.md` phase 5 (`release.yml`, `scripts/postrelease.sh --install`), using that release's single daemon restart.
  - `<gmax>/AGENTS.md:42-53` requires every change in the batch to be finished first, so the release waits for both plans.
  - The restart is a model reload. It needs the owner's yes and comes after 2026-11-11 16:00 UTC.
- [ ] Phase 2 ships in a later release, with its own go.
- [ ] The live after-ranks in Verification are recorded in this plan.

## Verification

**Before install** (no restart, no model start):

- Baselines captured 2026-11-09 on 0.26.113 with `gmax "<q>" --root <repo> --agent --scores --explain`. "Score rank" means hit lines re-sorted by `s=`, because `--agent` groups by file (`agent-search-formatter.ts:208-259`).

  | Pair | Query and scope | Today |
  | --- | --- | --- |
  | P3 | `comms data model for conversations, messages and channels`, `--in docs -m 40 --per-file 40` | `comms-data-model.md:10` rank 1, `comms.md:17` rank 15 of 38 |
  | P3 | same, `--in docs -m 20` | `comms.md:17` printed at 17 |
  | P1 | `how companies are priced and billed per place on the bill`, `--in docs -m 40 --per-file 40` | `pricing-2.md:127` rank 24 of 40 |
  | P3b | `AI-first messaging transport, message delivery and handoffs`, `--in docs -m 20` | archived `comms-message-delivery.md` ranks 1 to 3, `comms.md` 5 to 7 (findings:95) |
  | P2 | `Apple Wallet pass for door access credentials`, `--in docs -m 20` | archived `wallet-pass.md` rank 9, successor `wallet-access-strategy.md` rank 6 (findings:89) |
  | Code control | `seed data for a pilot property`, `--in packages/db/src/archive` | `seed-la-pilot.ts` hits, code boost |
  | Waiver control | P1 query plus `archived` | archived plan ranks 1 to 3 (findings:93) |

- **Offline simulation on the saved shortlists** (a simulation, not a measurement): at 0.5, `comms.md:17` goes from 15 to 8 and `comms-data-model.md:10` from 1 to 15. `pricing-2.md:127` goes from 24 to 20.
- **Checks, run once:** `pnpm typecheck`, plus 1 focused vitest invocation over the Phase 1 test files, within the budget in `<gmax>/AGENTS.md:6-7` and `:131-133`. That invocation belongs to the go for this plan's Phase 1. The release batch is shared with the watcher plan, so the release's own checks follow whatever that go authorizes and add no second run here.

**After install** (in the shared release): the same commands. Acceptance rests on relations, not exact ranks:

- In P3, P3b and P2 the successor ranks above every archived chunk.
- In P1, `pricing-2.md:127` ranks higher than its baseline of 24 and above every chunk of `pricing-billing-recenter.md`.
- Every archived hit shows `[ARCHIVED]`, and `--explain` shows `archive=0.50x` and boost about 0.30x.
- The code control has the same scores and no label.
- The waiver control has no `archive=` term and keeps the label.
- `--history` on P3 restores today's order.

**Not scheduled:** a recall or MRR eval. One would load models through the eval runner, so it needs the owner's yes and is not part of this plan's checks.

## Fit with other plans

- **`gmax-watcher-correctness.md` touches none of these files.** Its modules are the 5 `src/lib/index/watcher*.ts` files, `src/lib/daemon/watcher-manager.ts`, `src/lib/utils/watcher-launcher.ts` and `src/commands/watch.ts`; Phase 1 here edits none of them, so it can be built beside the watcher phases and ship in 1 release. Phase 2 edits no watcher file either: it relies on the `reprocess` dispatch in `watcher-manager.ts:772-776`, and starts after watcher phase 1 lands so it can confirm that the merged module keeps that dispatch.
- **`gmax-catchup-throughput.md` step 7:** Phase 1 writes nothing to the store. Phase 2 and the restart in Phase 3 wait for the record to end.
- **`gmax-delivery.md` § Work outside the execution queue (`:7191-7209`):** opening work there needs "a concrete selected outcome" and must "replace an existing milestone or follow its closeout", not create "another parallel omnibus plan".
  - This plan has 1 ruled outcome.
  - It rides the watcher plan's release rather than opening a milestone.
  - The ruling section in `gmax-delivery.md` links it.
  - It stays proposed until the owner selects it.
- **Relevance research row:** it gates new retrieval methods (PPR, graph reranking, expansion, caching) behind evidence. This plan adds a ruled policy factor to an existing scoring stage. It leaves the 0.6 docs factor unchanged and loads no model. It follows `docs/known-limitations.md:93-97` by fixing real misses (the pairs above) before setting the weight.

## Execution

- **Phase 1:** 2 agents in sequence, each returning within 45 minutes (`<gmax>/AGENTS.md:6`), each checked by the main session against its boxes before the next starts.
  1. **Agent 1:** the factor, the path base, the waiver, the flag plumbing (CLI, daemon payload, IPC, MCP input) and `docStatus` on ChunkType. It writes the stubbed-score ranking tests and does not run them.
  2. **Agent 2:** the label on every output surface and the format tests. It then runs `pnpm typecheck` and the batch's single focused vitest invocation over all Phase 1 test files.
- **Phase 2:** 1 agent, after the regrowth record ends and watcher phase 1 lands, under its own go.
- **Phase 3:** the main session, inside the watcher plan's phase 5 release.
- **Proposed total:** 3 agents (2 for Phase 1, 1 for Phase 2). None is started by this plan.
