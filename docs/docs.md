# Docs

## Current state — October 22, 2026

**Gmax supports document search for indexed Markdown in registered projects.**
Reviewed 0.26.93 is public through GitHub trusted publishing, with exact registry
bytes and signed provenance verified. It is installed in both existing Node roots
and Claude scopes, with accepted live handover. Storage, session, graph, ranking,
optional Gemma and document readiness work is delivered. Small remains the default; settings and protection are preserved.

The [necessity audit](plans/gmax-delivery.md#necessity-audit--october-21-2026)
replaces the previous expanding queue:

| Item | Disposition |
| --- | --- |
| Startup can stop another Gmax instance's daemon/workers without ownership proof | Delivered: reviewed 56c7806 / 0.26.93 is public, byte/provenance verified and installed; source/archive/native/installed checks pass. Trusted publisher recovery passes. |
| CPU/memory/disk history | User selected a smaller sampler; isolated0d5282c fixes both round1 blockers, under parent-model round2 review. Original overhead regression remains unresolved; not shipped. |
| Linux P3 setup | User-requested deployment, pending actual machine/access and selection; independent of document search |
| Three-file docs exercise, new search helper and required external consumer rollout | Withdrawn; no demonstrated need |
| Context composer, graph/ranking expansion, model promotion, automation and other enhancements | Optional; removed from the mandatory queue |

The audit covers the sole live plan, reference/suggestion/limitation records,
archived metadata, root docs and source TODO markers. Earlier findings/evidence
remain intact; historical instructions do not restart work. Existing release and
security gates still apply to any actual change. Only the manually dispatched
release workflow is enabled; push/PR CI remains absent. The user-authorized
[repair](plans/gmax-delivery.md#process-ownership-repair--ready-plan) is complete.
Trusted publication succeeded in run39717358032; reviewed cache recovery 52ea74e
passes [verification-only run39718868523](https://github.com/reowens/grepmax/actions/runs/39718868523).
The manual MFA path is withdrawn. The newly selected reduced resource sampler is isolated and under review; its bounded measurement follows.

## Document index

<!-- GENERATED:dotmd:start -->

## Active

| Doc | Status |
|-----|--------|
| [Future Sessions](future-sessions.md) | Active |

## Reference

| Doc | Status |
|-----|--------|
| [Repository Audit - 2026-07-09](2026-07-09-repository-audit.md) | Reference |
| [macOS Kernel-Zone Panic Incident - 2026-08-04](2026-08-04-macos-kernel-zone-panic-incident.md) | Reference |
| [Performance Review — 2026-08-04](2026-08-04-performance-review.md) | Reference |
| [2026 08 17 Gmax Agent Facing Health Audit](2026-08-17-gmax-agent-facing-health-audit.md) | Reference |
| [2026-08-25 Release Triage — Retrospective](2026-08-25-release-triage-retrospective.md) | Reference |
| [Graphify and related projects — October 19, 2026](2026-10-19-graphify-related-projects.md) | Reference |
| [gmax Agent POV Suggestions](agent-pov-suggestions.md) | Reference |
| [Embedding Layout Decision](embedding-layout-decision.md) | Reference |
| [Known Limitations](known-limitations.md) | Reference |
| [Linux GPU support and P3 Ultra G2 commissioning](linux-gpu-p3-design.md) | Reference |

## Archived

Archived docs are indexed by the CLI/JSON output. Showing 8 recent or high-signal highlights out of 180 archived docs:

| Doc | Status Snapshot |
|-----|-----------------|
| [Gmax Host Safety and Disk Recovery](archived/gmax-host-safety-and-disk-recovery.md) | Archived: Superseded by Gmax Delivery Plan. Delivery through 0.26.84 is complete; remaining index coverage and cleanup eligibility work transfers to milestone A. Historical uncertainty is preserved. |
| [Embedding Reembed Atomic Cutover](archived/embedding-reembed-atomic-cutover.md) | Archived: Deferred without an execution commitment. No superior model/layout/capacity decision exists; background staging and cutover remain unimplemented. |
| [Semantic Search - Measure-First Decision Record](archived/2026-05-25-semantic-search-landscape.md) | Archived: Retired as an execution plan. Shipped semantic work remains shipped; untriggered mechanisms remain deferred reference decisions. |
| [Multi-fragment Compaction Cleanup](archived/multi-fragment-compaction-cleanup.md) | Archived: Superseded by Gmax Delivery Plan milestone A. Independent retention and small-fragment cleanup shipped; remaining eligibility cases remain explicit. |
| [Gmax Checkout Reconciliation](archived/gmax-checkout-reconciliation.md) | Archived: Checkout reconciliation is complete. Shared main is clean at released/source origin/main 4531be7. All four unpublished output commits are preserved on work/gmax-output-fixes at f17aeee; document-search edits are integrated onto released source on work/gmax-document-search at 794aa87. All 32 original dirty/untracked files and the later generated-doc-index update are recoverable from Git snapshots, exact file backups and an additional stash. Original stashes and validated prune branch are intact. |
| [Fix pnpm setup bootstrap advisory](archived/pnpm-bootstrap-security.md) | Archived: Bootstrap warning identified and resolved at 92af4a6. Both workflows pin audited action v6.1.0; GitHub CI37408026765 passes all checks and confirms zero bootstrap vulnerabilities. Installed gmax remains0.26.51. |
| [Repair Claude and Codex plugin lifecycle and installation](archived/plugin-lifecycle-installation.md) | Archived: Groups1/2 implemented and verified in source;1648 tests / 172 files,typechecks/build/consumer checks pass. Group 3 approved and applied to local Codex config; CLI verification passes. Release/install and client refresh complete at v0.26.51; installed smoke and setting preservation pass. |
| [Release and install per-file retrieval control](archived/per-file-release.md) | Archived: v0.26.50 published, registry-installed and verified; documentation and evidence complete. |

- Use `runlist list` or `runlist json` for the full inventory.
<!-- GENERATED:dotmd:end -->
