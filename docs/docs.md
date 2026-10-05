# Docs

## Current release and follow-ups — reviewed October 4, 2026

**v0.26.48 is released and installed.** It fixes short-result search requests trimming candidates before structural scoring and dedup. Source `6e030a6`, tag `996df70`; [release CI 37255086012](https://github.com/reowens/grepmax/actions/runs/37255086012) passed 1,512 tests / 164 files, both typechecks, formatting, build, production audit and fresh packed-consumer audit/native smoke. Six installed queries at limits 1/3/10 now have stable result prefixes. General semantic relevance still needs held-out multi-repository validation.

The earlier reliability work remains shipped: native Session cache wiring, bounded query/row reads, reproducible consumer packaging, external-store request isolation and refusal of unsupported-daemon fallback readers. The historical FTS merge defect is fixed in the pinned LanceDB 0.38.0 GA runtime; a fresh panic should be investigated as a regression.

MCP uses the pinned SDK server 2.3.0 with legacy and modern STDIO compatibility. Installed CommonJS checks passed real v1, legacy v2, modern v2 and auto-discovering clients; the v1 fixture is development-only. Structured search/trace/dead/health results shipped in .45, the SDK migration in .46, and request cancellation/progress in .47. Cancellation closes only the affected read's IPC connection; active local native work waits for its deadline before store close. Optional LLM workflows and indexing writes are not interrupted. Tasks/subscriptions remain workflow-gated.

MCP remains local-only: stdin/stdout pipes, no HTTP/SSE/TCP listener; daemon home/socket permissions are 0700/0600. Non-loopback optional LLM configuration is refused before model startup. Discovery and catalog listing start no daemon, model or watcher work.

Longer resource cycles remain an observation task under ordinary sessions. Compare timestamped `Resource snapshot:` and `Compaction result:` records within the same daemon PID, accounting for hdev's memory guard. Do not substitute old process samples or force full rewrites to produce evidence. Exact search remains the default; an absent ANN index is expected after its recall-gate failure.

The October 4 documentation audit corrected README defaults, explicit plugin updates, disabled summary guidance and historical benchmark/audit claims. The subsequent source fix makes both retrieval harnesses credit only ranks 1–10 in `mrrAt10`, preserving twenty-result retrieval and late-hit diagnostic ranks. Twenty-one synthetic regressions cover the cutoff and existing matching rules; historical figures were not recomputed. The deferred plans below were reviewed and retain their existing measurement gates.

Use runlist to consume the latest local handoff and claim plan work. `docs/future-sessions.md` contains detailed local evidence; archived notes describe historical states rather than current operating instructions.

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

Archived docs are indexed by the CLI/JSON output. Showing 8 recent or high-signal highlights out of 85 archived docs:

| Doc | Status Snapshot |
|-----|-----------------|
| [Retrieval MRR@10 cutoff](archived/mrr-at-ten-cutoff.md) | Archived: Both harnesses now give reciprocal-rank credit only to ranks 1–10. Late-hit diagnostics and twenty-result retrieval remain; 21 synthetic tests and both typechecks pass. |
| [Lance FTS Incremental-Merge Panic — Upstream Pursuit](archived/lance-fts-merge-upstream.md) | Archived: Closed. lance-format/lance#8310 was fixed by lance#8312 (lance 11.0.0-beta.22); gmax pins @lancedb/lancedb 0.38.0 GA (lance 11.0.0). The 0.26.27/0.26.28 canary on the GA pin ran 2026-09-07 to 2026-09-16 with zero optimize failures, FTS rebuilds, or panics. The drop-and-rebuild guard stays as a tripwire. |
| [LanceDB 0.31 → 0.38 Upgrade](archived/lancedb-0.38-upgrade.md) | Archived: Shipped initially in v0.26.23 with a beta overlay, then replaced by the LanceDB 0.38.0 GA pin. The upstream FTS fix is included; the v0.26.27/0.26.28 canary ran September 7–16 with zero optimize failures, FTS rebuilds or panics. The drop-and-rebuild guard remains a recovery tripwire. The body below preserves the August prerelease investigation as historical evidence. |
| [Mcp Server Migration](archived/mcp-server-migration.md) | Archived: The Server-to-McpServer migration shipped in `e80daca`; the result-shape follow-up shipped in `04a87a4`. The current server registers 27 tools with Zod schemas, explicit registered-project scoping, protocol coverage, and subsequent lifecycle/performance hardening. |
| [v0.26.2 Stability Cycle](archived/stability-cycle-v0.26.2.md) | Archived: Historical v0.26.2-v0.26.5 stability cycle. SC-001 and SC-003 were fixed and live-verified; SC-002 recovery shipped and restored compaction, but FTS merge panics recurred repeatedly through 2026-08-03. The dated observation window and formal exit snapshot were never completed, and the 2026-08-04 watcher/index/store changes supersede this baseline. |
| [Documentation refresh, October 2026](archived/docs-refresh-oct-2026.md) | Archived: README, docs index, limitations, contributor guidance and deferred plans now reflect v0.26.48. Historical rollout instructions and FTS closeouts are corrected; all runlist warnings are resolved. |
| [Ordered Reliability Follow-ups](archived/ordered-reliability-followups.md) | Archived: All five fixes and local-only security shipped in v0.26.44; CI, installed IPC, health, sandbox, native cache telemetry and scheduled compaction passed. |
| [External stores](archived/external-stores.md) | Archived: Phase 3 shipped in v0.26.44, tag 825ccd6. Native protocol plus real eject/remount verification passed; CI 37094408479 passed and installed daemon reports the correct version. |

- Use `runlist list` or `runlist json` for the full inventory.
<!-- GENERATED:dotmd:end -->
