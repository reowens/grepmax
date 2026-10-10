# Docs

## Current execution — October 9, 2026

The [Gmax Delivery Plan](plans/gmax-delivery.md) is the sole execution plan.
0.26.84 is released, installed and serving; publication and installation are complete.
Four former open plans are archived as superseded/deferred, with explicit transfers.
Historical audits, incident reports and agent proposals are reference records, not queues.

| Order | Deliverable | State |
| --- | --- | --- |
| A | Complete bounded storage and path/content query repair | Preplanning complete; first change is bounded path/content index refresh |
| B | Reduce session resource overhead | Selected after A |
| C | Complete one document-search consumer rollout | Selected after B |

The plan defines implementation, root review, required CI, release/install and closeout
for each deliverable. Repeated unchanged cleanup/timing observations are cancelled.
Research, optional polish, watcher extraction and embedding migration are outside the
execution queue. Depot account/provider integration is handed off to platform.

The previous remaining-items inventory incorrectly counted shipped budget packing,
impact rollups, not-found recovery and SQL-template skeleton support. Those are not
pending tasks. Historical evidence and unresolved limitations remain in archived
records and Git history; archiving is not a claim that every proposal shipped.

## Document index

<!-- GENERATED:dotmd:start -->

## Active

| Doc | Status |
|-----|--------|
| [Future Sessions](future-sessions.md) | Active |
| [Gmax Delivery Plan](plans/gmax-delivery.md) | Active |

## Reference

| Doc | Status |
|-----|--------|
| [Repository Audit - 2026-07-09](2026-07-09-repository-audit.md) | Reference |
| [macOS Kernel-Zone Panic Incident - 2026-08-04](2026-08-04-macos-kernel-zone-panic-incident.md) | Reference |
| [Performance Review — 2026-08-04](2026-08-04-performance-review.md) | Reference |
| [2026 08 17 Gmax Agent Facing Health Audit](2026-08-17-gmax-agent-facing-health-audit.md) | Reference |
| [2026-08-25 Release Triage — Retrospective](2026-08-25-release-triage-retrospective.md) | Reference |
| [gmax Agent POV Suggestions](agent-pov-suggestions.md) | Reference |
| [Embedding Layout Decision](embedding-layout-decision.md) | Reference |
| [Known Limitations](known-limitations.md) | Reference |

## Archived

Archived docs are indexed by the CLI/JSON output. Showing 8 recent or high-signal highlights out of 174 archived docs:

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
