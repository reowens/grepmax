# Docs

## Current release and follow-ups — reviewed October 5, 2026

**v0.26.50 is released and installed.** Explicit CLI `--per-file` values now reach request-scoped retrieval, while omitted requests retain the configured cap or three. Source `7ba859c`, tag `353cdbf`; [release CI 37386229411](https://github.com/reowens/grepmax/actions/runs/37386229411) passed 1,613 tests / 169 files, both typechecks, formatting, build, production audit and fresh packed-consumer audit/native smoke. Registry installation and Claude/Codex integrations were refreshed. Installed concurrent caps six/one, default restoration, CLI expansion, native modules and all four MCP compatibility modes passed. Prior diagnostics, evaluation and result-window fixes remain shipped. Independent answer-ground-truth review and new diagnostic measurements remain prerequisites for ranking acceptance.

The final installed comparison preserved all three pre-install queries' result identities, order and scores. An earlier strict comparison caught one normalized-score difference during deployment; its failed log is retained, and its exact cause is unproven. The shared index continued changing, and lower FTS ranks varied in the final diagnostic comparison. The host memory guard also restarted the first .50 daemon with one worker; final checks used the new ready process. This is deployment evidence, not a frozen ranking acceptance run or proof that long-cycle memory retention is resolved. Local evidence: `docs/measurements/2026-10-05-release-v0.26.50/`.

The earlier reliability work remains shipped: native Session cache wiring, bounded query/row reads, reproducible consumer packaging, external-store request isolation and refusal of unsupported-daemon fallback readers. The historical FTS merge defect is fixed in the pinned LanceDB 0.38.0 GA runtime; a fresh panic should be investigated as a regression.

MCP uses the pinned SDK server 2.3.0 with legacy and modern STDIO compatibility. Installed CommonJS checks passed real v1, legacy v2, modern v2 and auto-discovering clients; the v1 fixture is development-only. Structured search/trace/dead/health results shipped in .45, the SDK migration in .46, and request cancellation/progress in .47. Cancellation closes only the affected read's IPC connection; active local native work waits for its deadline before store close. Optional LLM workflows and indexing writes are not interrupted. Tasks/subscriptions remain workflow-gated.

MCP remains local-only: stdin/stdout pipes, no HTTP/SSE/TCP listener; daemon home/socket permissions are 0700/0600. Non-loopback optional LLM configuration is refused before model startup. Discovery and catalog listing start no daemon, model or watcher work.

Longer resource cycles remain an observation task under ordinary sessions. Compare timestamped `Resource snapshot:` and `Compaction result:` records within the same daemon PID, accounting for hdev's memory guard. Do not substitute old process samples or force full rewrites to produce evidence. Exact search remains the default; an absent ANN index is expected after its recall-gate failure.

The October 4 documentation audit corrected README defaults, explicit plugin updates, disabled summary guidance and historical benchmark/audit claims. The subsequent source fix makes both retrieval harnesses credit only ranks 1–10 in `mrrAt10`, preserving twenty-result retrieval and late-hit diagnostic ranks. Twenty-one synthetic regressions cover the cutoff and existing matching rules; historical figures were not recomputed. The deferred plans below were reviewed and retain their existing measurement gates.

A passive check at 19:55 PDT October 4 found the same .48 daemon PID 89172 running for ~29 minutes. One normal compaction completed in one attempt / 26.3 seconds; doctor reported 14.9 GB logical / 15.9 GB physical, 103.9 GB free and no orphan/stale temporary data. Five retained resource samples included maintenance footprint up to 1,950 MB and recovery to 749 MB at idle, with heap 59–70 MB, one worker and zero pending files. This short cycle supports continued observation; it does not establish long-cycle retention is resolved. No restart or forced maintenance was used.

Use runlist to consume the latest local handoff and claim plan work. `docs/future-sessions.md` contains detailed local evidence; archived notes describe historical states rather than current operating instructions.

## Retrieval diagnostics — released and installed October 5, 2026

Opt-in production search diagnostics now record candidate-stage ranks and removal outcomes, actual concentration-gate activation and rerank invocation, effective settings/allowlisted daemon ranking environment and FTS health. Candidate output is bounded to the first 200 post-seed fusion candidates with total/truncation explicit. The default results and database-read counts are preserved. The evaluator's `--diagnostics` flag requires `searchDiagnostics: 1` in daemon ping and excludes missing diagnostic responses.

All release gates pass; repository Biome retains its existing optional-chain warnings and configuration notices. The installed .49 daemon advertises `searchDiagnostics: 1`. Three live comparisons preserved results and scores, each with a bounded 200-candidate truncated trace, healthy FTS and explicit gate/rerank invocation fields. This deployment smoke does not replace the frozen relevance baseline or resolve its ground-truth caveats. Installed MCP passed v1, legacy v2, modern v2 and auto clients with every server listen call forbidden; transport remains local-only.

The answer-range review proposes six source-grounded spans and two query clarifications. It specifically separates arbitrary search-method chunks from actual RRF merge code, and handoff preparation from atomic prompt/plan publication. This single-author proposal is local evidence for independent review; it is not a frozen successor, rescored baseline or fresh held-out set. Original October 4 artifacts and metrics are preserved. Local evidence: `docs/measurements/2026-10-05-relevance-review/`.

## Reviewed diagnostic triage — October 5, 2026

A separate successor was frozen before querying .49: six answer-span amendments, two scoped query variants and all 40 cases marked exposed/development. This fresh single-agent source pass is not independent adjudication. All 80 samples were valid with identical ranks across repetitions: target Recall@10 72.5%, MRR@10 0.42625, hits@1 27.5%. These are changed-fixture measurements, not an improvement over v1 or a ranking acceptance gate. The source evaluator adds explicit range-only target matching; 25 targeted tests and both typechecks pass. Original v1 evidence remains unchanged.

The 11 targets outside ten comprise three confirmed per-file cuts, three pooled cuts, three late returns and two unknowns absent from truncated traces. FTS was healthy; automatic reranking actually ran in four samples. A complete offline final-selection replay reproduced every baseline result before testing caps four/six. Raising the cap recovers some targets but displaces others and reduces file diversity. Preserve the production default of three. v0.26.50 now routes explicit CLI `--per-file` values into request-scoped retrieval; omitted requests retain configured defaults. CLI, Unix IPC, local fallback and optional loopback HTTP paths validate and propagate the value, with capability checks refusing unsupported live daemons. Pooled selection needs a separate experiment. Local evidence: `docs/measurements/2026-10-05-reviewed-diagnostics/`.

The same daemon PID survived this ~25-minute check and completed one normal compaction in one attempt. Five maintenance samples reached 1,969 MB footprint then 1,947 MB; no idle-recovery or long-cycle conclusion follows. Doctor reported 15.4 GB logical / 16.7 GB disk, 55.5 GB free and zero pending reconciliation. Host free-space variation is not attributed solely to this index.

## Multi-repository baseline — October 4, 2026

The source-only `pnpm bench:relevance` runner now measures frozen local fixtures through the existing production daemon. Forty curated cases (16 dev / 24 held-out) cover four repositories and languages, with two sequential, interleaved repetitions. All 80 samples were valid and each case's rank was identical across repetitions. Overall frozen-target Recall@10 was 57.5%, corrected MRR@10 0.3275 and hits@1 20%. Median IPC latency was 60.05 ms / p95 153.13 ms under ordinary activity; this is not a controlled latency gate.

| Corpus language | Cases | Target Recall@10 | MRR@10 |
| --- | ---: | ---: | ---: |
| TypeScript | 10 | 50% | 0.2083 |
| JavaScript | 10 | 60% | 0.3167 |
| Python | 10 | 50% | 0.3600 |
| Swift | 10 | 70% | 0.4250 |

The frozen fixture used declaration targets. Four of its 17 top-ten misses demonstrably returned useful implementation body chunks without the declaration; others include callers or plausible alternative answers. Preserve the original scores and audit these cases before constructing a reviewed successor fixture. The cases are source-curated, not recorded user-session misses. In these original baseline artifacts, fusion-pool membership and actual concentration-gate decisions remain unobserved; explain's `rerank` component is not an activation flag. No ranking tuning, reindex, daemon restart or new model startup was performed. Both typechecks, targeted Biome checks, artifact-refusal checks and all 1,556 tests / 166 files pass. Local fixtures, raw output and the per-case audit remain in ignored `docs/measurements/2026-10-04-relevance/`; see the [README workflow](../README.md#frozen-multi-repository-baseline) for reproduction.

## Deferred work

- [Embedding Reembed Atomic Cutover](plans/embedding-reembed-atomic-cutover.md) requires a
  meaningfully better measured model before implementation. The earlier 768d tier lost to 384d.
- [Semantic Search — Measure-First Decision Record](plans/2026-05-25-semantic-search-landscape.md) keeps
  PPR, HyDE, query expansion and semantic caching gated on measured misses or latency.
- Static graph results remain approximate for dynamic dispatch, reflection and receiver binding;
  dead symbols and test candidates are hypotheses. See [Known Limitations](known-limitations.md).

Never start a summarizer or multi-GB LLM without current explicit user authorization.

<!-- GENERATED:dotmd:start -->

## Active

| Doc | Status |
|-----|--------|
| [macOS Kernel-Zone Panic Incident - 2026-08-04](2026-08-04-macos-kernel-zone-panic-incident.md) | Active |
| [Performance Review — 2026-08-04](2026-08-04-performance-review.md) | Active |
| [2026 08 17 Gmax Agent Facing Health Audit](2026-08-17-gmax-agent-facing-health-audit.md) | Active |
| [2026-08-25 Release Triage — Retrospective](2026-08-25-release-triage-retrospective.md) | Active |
| [Embedding Layout Decision](embedding-layout-decision.md) | Active |
| [Future Sessions](future-sessions.md) | Active |

## Planned

| Doc | Status |
|-----|--------|
| [Embedding Reembed Atomic Cutover](plans/embedding-reembed-atomic-cutover.md) | Planned |

## Reference

| Doc | Status |
|-----|--------|
| [Repository Audit - 2026-07-09](2026-07-09-repository-audit.md) | Reference |
| [Known Limitations](known-limitations.md) | Reference |

## Archived

Archived docs are indexed by the CLI/JSON output. Showing 8 recent or high-signal highlights out of 98 archived docs:

| Doc | Status Snapshot |
|-----|-----------------|
| [Release and install per-file retrieval control](archived/per-file-release.md) | Archived: v0.26.50 published, registry-installed and verified; documentation and evidence complete. |
| [Request-scoped per-file retrieval control](archived/per-file-retrieval-control.md) | Archived: Explicit per-file request propagation and validation complete in source;1613tests/typechecks/format/build/consumer checks pass. Installed .49 correctly refuses unsupported overrides. |
| [Reviewed relevance diagnostic measurement](archived/reviewed-relevance-diagnostics.md) | Archived: Reviewed exposed successor frozen and measured through installed .49; all80 samples valid with stable ranks. Range-only evaluator support and diagnostics/cap/resource findings documented. |
| [Release and install retrieval diagnostics](archived/diagnostic-release.md) | Archived: v0.26.49 published, registry-installed and live-verified; documentation updated. |
| [Retrieval diagnostics and answer-range review](archived/retrieval-diagnostics.md) | Archived: Bounded opt-in production diagnostics and capability-gated evaluator are source-complete, with result/read equivalence regressions and packaging checks passing. Single-author answer-span proposals preserve the original frozen baseline. |
| [Multi-repository relevance baseline](archived/multirepo-relevance-baseline.md) | Archived: Reusable daemon-path runner and frozen 40-case four-repository baseline complete; both repetitions valid with identical ranks. Declaration-target scores and post-measurement ground-truth limitations are documented. |
| [Retrieval MRR@10 cutoff](archived/mrr-at-ten-cutoff.md) | Archived: Both harnesses now give reciprocal-rank credit only to ranks 1–10. Late-hit diagnostics and twenty-result retrieval remain; 21 synthetic tests and both typechecks pass. |
| [Lance FTS Incremental-Merge Panic — Upstream Pursuit](archived/lance-fts-merge-upstream.md) | Archived: Closed. lance-format/lance#8310 was fixed by lance#8312 (lance 11.0.0-beta.22); gmax pins @lancedb/lancedb 0.38.0 GA (lance 11.0.0). The 0.26.27/0.26.28 canary on the GA pin ran 2026-09-07 to 2026-09-16 with zero optimize failures, FTS rebuilds, or panics. The drop-and-rebuild guard stays as a tripwire. |

- Use `runlist list` or `runlist json` for the full inventory.
<!-- GENERATED:dotmd:end -->
