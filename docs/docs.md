# Docs

## Current release and next work — October 7, 2026

**[v0.26.64](https://github.com/reowens/grepmax/releases/tag/v0.26.64) is released and installed.** Source/tag `f65415f`; all 288 installed package files match the published tarball. [Release CI](https://github.com/reowens/grepmax/actions/runs/37624275485) passed 1,888 tests and the release gates; [macOS watcher validation](https://github.com/reowens/grepmax/actions/runs/37623882747) passed 104 focused tests. Artifact filtering (.62), live-edit queue priority (.63), and native FSEvents gap recovery (.64) now ship.

The earlier read-only sample at 13:16:35 UTC found .64 active and ready, native watching after three real event drops, and zero queued, active or failed paths. After earlier drops, create/edit/delete each reached the index in about 2.5 seconds. This verifies recovery from observed gaps; longer observation remains open. Automatic full-table maintenance is disabled with zero attempts. The optional Hetchy Developer guard fix `1b26495` honors the user's `critical-only` policy. Configuration is restored to two maximum workers; the current pool has one until a future normal startup.

**Production recovery admission and the requested self acceptance review are complete in source `a795475`; the candidate is unpublished.** `gmax recover` provides metadata-only status, strict offline preflight and explicit prune with exact acknowledgement of an uncertain attempt. Recovery requires persistent autostart containment, measured host/disk headroom and exclusive ownership; it cannot stop existing owners or relax normal service policy. Two admission handshakes and monitoring guard the helper, whose durable ownership survives parent death, including against released .64 readers. [Full CI](https://github.com/reowens/grepmax/actions/runs/37636181627) passed 1,934 tests / 195 files, typechecks, formatting, dependency audits and the installed-consumer check. [Linux/macOS acceptance](https://github.com/reowens/grepmax/actions/runs/37636181919) passed all four 600,000-row completion/cancellation/SIGKILL/parent-death fixtures, retaining current/tagged/post-cutoff state and partial FTS without rewriting. Both runners produced identical 296-file tarballs with exact helper/manifest/lock bytes.

The user requested review by the implementer after implementation; this was a separate self review, not external independent sign-off. Real macOS preflight correctly refused insufficient measured physical headroom; Linux refused unsupported production admission. Both left table state and the prune receipt untouched. Native deletion fixtures used injected healthy admission; they prove retention/lifecycle behavior, not live-host admission. Production admission currently supports macOS only. The 512 MiB helper reservation and measured CI RSS are not an enforced macOS physical-footprint cap.

**Next: a separately versioned recovery release, then fresh offline admission before any live prune.** The tested candidate still carries .64 and must not overlay the official registry .64. No live cleanup, restart, registry publication or installation occurred. At 14:31:01 UTC the unchanged daemon 75791/model 76090 remained ready, native after 18 accumulated drops, with zero queued/active/failed paths and maintenance disabled/attempts 0. Underlying host event drops and longer watcher observation remain open.

| Remaining work | Order and scope |
| --- | --- |
| Recovery release and live admission | Source admission/self review and isolated acceptance passed; versioned delivery and a fresh offline host/ownership gate remain before live pruning. |
| Watcher observation | In parallel under ordinary development; record gaps, reconciliation, freshness and daemon identity without a synthetic flood. |
| Output fixes (`work/gmax-output-fixes`, `f17aeee`) | Preserved, unshipped; review and run current-release checks before a separate release. |
| Document search (`work/gmax-document-search`, `794aa87`) | Preserved, unshipped; review and run current-release checks before a separate release. |
| Embedding migration and a shared watcher package | Deferred; no extraction or model change is currently requested. |

The filesystem watcher belongs to gmax in daemon and standalone modes. Hetchy Developer and its helper remain optional controllers, never runtime dependencies. A future shared watcher package must work independently of that app. See the [active incident plan](plans/gmax-host-safety-and-disk-recovery.md) and [session handoff notes](future-sessions.md) for evidence and acceptance requirements. The older release records below are historical.

## Historical release and follow-ups — October 5, 2026

**v0.26.51 is released and registry-installed.** The Claude hook and installer repairs below now ship. Source `7de4c9c`, tag `cbaa6b9`; [release CI 37406418335](https://github.com/reowens/grepmax/actions/runs/37406418335) passed 1,648 tests / 172 files, both typechecks, formatting, build, production/packed-consumer audits and native/tarball checks. The daemon handed over from .50 to .51 and confirmed readiness over IPC (PID 40322). Claude user/project scopes refreshed without changing their source, enabled preferences, other plugins or user settings; Codex retained its complete configuration and the approved two-tool deny list. Installed hook quarantine, renewal, scoped release and native checks passed. MCP v1/legacy/modern/auto tools passed with listeners forbidden. Doctor reports 573,029 rows, 15.7 GB logical / 16.4 GB disk and 70.0 GB free. Restart existing clients to load refreshed integrations. Local evidence: `docs/measurements/2026-10-05-release-v0.26.51/`.

The CI bootstrap warning is identified: the old release setup action embedded pnpm 11.7.0 before switching to pnpm 10.34.6. Fresh audit reproduces four high advisories in that one bootstrap package. Both workflows now pin pnpm/action-setup v6.1.0 (`ea17c68`), whose bundled pnpm and standalone bootstrap are 11.25.0. Exact source/dist versions and integrities agree; isolated audits for both variants and requested pnpm 10.34.6 report zero vulnerabilities. [Main-branch CI 37408026765](https://github.com/reowens/grepmax/actions/runs/37408026765) confirms zero bootstrap vulnerabilities, pnpm 11.25.0 → 10.34.6, all 1,648 tests / 172 files, both typechecks and build. The publishing workflow was not dispatched; its setup uses the same pinned action and inputs. This tooling change does not require a new gmax package release. Local evidence: `docs/measurements/2026-10-05-pnpm-bootstrap/`.

### Previous v0.26.50 release evidence

**v0.26.50 is released and installed.** Explicit CLI `--per-file` values now reach request-scoped retrieval, while omitted requests retain the configured cap or three. Source `7ba859c`, tag `353cdbf`; [release CI 37386229411](https://github.com/reowens/grepmax/actions/runs/37386229411) passed 1,613 tests / 169 files, both typechecks, formatting, build, production audit and fresh packed-consumer audit/native smoke. Registry installation and Claude/Codex integrations were refreshed. Installed concurrent caps six/one, default restoration, CLI expansion, native modules and all four MCP compatibility modes passed. Prior diagnostics, evaluation and result-window fixes remain shipped. Independent answer-ground-truth review and new diagnostic measurements remain prerequisites for ranking acceptance.

The final installed comparison preserved all three pre-install queries' result identities, order and scores. An earlier strict comparison caught one normalized-score difference during deployment; its failed log is retained, and its exact cause is unproven. The shared index continued changing, and lower FTS ranks varied in the final diagnostic comparison. The host memory guard also restarted the first .50 daemon with one worker; final checks used the new ready process. This is deployment evidence, not a frozen ranking acceptance run or proof that long-cycle memory retention is resolved. Local evidence: `docs/measurements/2026-10-05-release-v0.26.50/`.

The plugin audit repairs shipped in v0.26.51: shared Claude quarantine/singleton checks, turn/Bash activity lease renewal, quoted paths and bounded startup; consistent custom Codex home and preserved MCP options; non-destructive Claude source/scope updates. All 1,648 tests / 172 files and both typechecks pass. Claude remains a CLI plugin and Codex uses local STDIO MCP. After the user's approval, the local Codex config disables `investigate` and `review_commit` through `mcp_servers.gmax.disabled_tools`; Codex's CLI confirms both entries and every other parsed setting is preserved. New sessions/restarted clients load this policy; the current session's catalog was not reloaded. This is a local tool-visibility policy, not a default imposed on every installation or a machine-wide CLI restriction.

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
| [Gmax Host Safety and Disk Recovery](plans/gmax-host-safety-and-disk-recovery.md) | Active |

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

Archived docs are indexed by the CLI/JSON output. Showing 8 recent or high-signal highlights out of 134 archived docs:

| Doc | Status Snapshot |
|-----|-----------------|
| [Gmax Checkout Reconciliation](archived/gmax-checkout-reconciliation.md) | Archived: Checkout reconciliation is complete. Shared main is clean at released/source origin/main 4531be7. All four unpublished output commits are preserved on work/gmax-output-fixes at f17aeee; document-search edits are integrated onto released source on work/gmax-document-search at 794aa87. All 32 original dirty/untracked files and the later generated-doc-index update are recoverable from Git snapshots, exact file backups and an additional stash. Original stashes and validated prune branch are intact. |
| [Fix pnpm setup bootstrap advisory](archived/pnpm-bootstrap-security.md) | Archived: Bootstrap warning identified and resolved at 92af4a6. Both workflows pin audited action v6.1.0; GitHub CI37408026765 passes all checks and confirms zero bootstrap vulnerabilities. Installed gmax remains0.26.51. |
| [Repair Claude and Codex plugin lifecycle and installation](archived/plugin-lifecycle-installation.md) | Archived: Groups1/2 implemented and verified in source;1648 tests / 172 files,typechecks/build/consumer checks pass. Group 3 approved and applied to local Codex config; CLI verification passes. Release/install and client refresh complete at v0.26.51; installed smoke and setting preservation pass. |
| [Release and install per-file retrieval control](archived/per-file-release.md) | Archived: v0.26.50 published, registry-installed and verified; documentation and evidence complete. |
| [Request-scoped per-file retrieval control](archived/per-file-retrieval-control.md) | Archived: Explicit per-file request propagation and validation complete in source;1613tests/typechecks/format/build/consumer checks pass. Installed .49 correctly refuses unsupported overrides. |
| [Reviewed relevance diagnostic measurement](archived/reviewed-relevance-diagnostics.md) | Archived: Reviewed exposed successor frozen and measured through installed .49; all80 samples valid with stable ranks. Range-only evaluator support and diagnostics/cap/resource findings documented. |
| [Release and install retrieval diagnostics](archived/diagnostic-release.md) | Archived: v0.26.49 published, registry-installed and live-verified; documentation updated. |
| [Retrieval diagnostics and answer-range review](archived/retrieval-diagnostics.md) | Archived: Bounded opt-in production diagnostics and capability-gated evaluator are source-complete, with result/read equivalence regressions and packaging checks passing. Single-author answer-span proposals preserve the original frozen baseline. |

- Use `runlist list` or `runlist json` for the full inventory.
<!-- GENERATED:dotmd:end -->
