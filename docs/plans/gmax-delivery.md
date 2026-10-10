---
type: plan
status: active
created: 2026-10-10T06:45:25Z
updated: 2026-10-10T06:45:25Z
surfaces:
  - store
  - daemon
  - search
  - mcp
modules:
  - src/lib/store/vector-db.ts
  - src/lib/daemon/daemon.ts
  - src/lib/daemon/rows-handler.ts
  - src/lib/daemon/search-handler.ts
  - src/commands/mcp.ts
domain: Complete storage/query repair, session resource reduction, and document-search rollout
audience: internal
parent_plan:
related_plans:
related_docs:
current_state: 0.26.84 is released, installed and serving. Independent version retention, bounded small-fragment cleanup, cleanup selection and lookup diagnostics have shipped. Incomplete path/content index coverage and larger-fragment cleanup limits remain. Replanning is complete; the repair implementation below has not started.
next_step: "Implement milestone A using existing coverage and query-stage evidence: bounded path and content index refresh, followed by remaining storage eligibility fixes. Do not reopen unchanged observation runs. Review, qualify and deliver the concrete change before advancing to session resource work."
summary: One execution plan with three ordered deliverables. Historical incidents and untriggered research are not an execution queue.
---

# Gmax Delivery Plan

## Recenter decision

This is the sole execution plan. It replaces the four former open plan records:
host safety/disk recovery, multi-fragment cleanup, semantic-search landscape, and
embedding migration. Their history is preserved in the archive. Archiving means
superseded or explicitly deferred, not that every proposal was implemented.

The earlier 36-item inventory mixed current repair needs, optional research and
already-shipped agent features. It is not an execution queue. Token-budget packing,
impact rollups, agent not-found recovery, SQL-template skeleton summaries and
search/daemon module extraction already shipped; do not recreate them.

## Delivered baseline

- 0.26.84 publication, both existing Node installations, both existing plugin scopes
  and normal daemon handover are complete. Release and source CI passed.
- Independent old-version retention is running without enabling full-table rewrites.
- Bounded small-fragment deleted-row cleanup, protected readers, interrupted-writer
  recovery and the oversized-first-task selection correction are delivered.
- Watcher recovery/diagnostics, scoped worker-starvation fixes, document-search
  contracts, MCP cancellation/progress and duplicate-CI trimming have shipped.
- Existing evidence establishes slow lookups spend most time in the native query.
  Incomplete path/content index coverage is a concrete repair target, not proof of
  the cause of every slow request. Historical failed/partial runs remain unchanged.
- The latest repeated cleanup/timing observer was stopped at the user's direction.
  Its partial result is not a passing throughput or long-term storage acceptance.

## Ordered deliverables

Only milestone A is current. B and C are the selected later sequence, not additional
active plans. Root owns implementation, post-implementation review and delivery.
Do not create child plans or spin agents without a new explicit delegation request.

### A. Complete storage and query repair

**Outcome:** ordinary edits can regain path/content index coverage and reclaim
obsolete data through bounded operations while searches remain usable. A successful
small cleanup must not stand in for handling the known remaining eligibility cases.

1. Use the existing manifest inventory, uncovered-index evidence and query-stage
   timings. Inspect the pinned SDK/native capabilities and implement incremental
   path and content index refresh with exact ownership/current-head checks. Keep
   source/write/free-space/reader budgets and atomic publication. A full-table
   rewrite, disabled containment, larger memory allowance or looser guard is not a
   solution. If the SDK cannot supply a bounded operation, implement the necessary
   helper contract rather than silently invoking its full rebuild.
2. Resolve remaining cleanup eligibility: oversized source fragments, affected index
   updates that exceed the write ledger, and fresh unreferenced objects missed by
   version cleanup. Use an ownership-proven bounded migration/reclamation strategy;
   never delete objects solely because they look unused. Retained readers, tags,
   current rows and interruption recovery remain protected. Any unsupported case
   must stay explicit; it cannot be labeled reclaimed or cleared.
3. Root reviews the final implementation. Add only regressions for demonstrated
   gaps and the new operation. Reuse existing native, reader, quota and crash cases
   for changed contracts. Verify mixed indexed/unindexed fragments, edit/delete
   transitions, indexed-query equivalence, preserved current rows, protected
   readers, cumulative writes and interruption recovery in temporary stores.
4. Run the required source/native/package gates for the final change, then complete
   one release/install/handover sequence using the accepted artifact. Preserve
   settings and sessions. Verify installed version and the changed operation;
   another unchanged timed production observation is not a release prerequisite.

**Completion:** the changed operations have accepted correctness/resource evidence,
the accepted artifact is installed, and each selected coverage/eligibility case has
a working bounded implementation. A demonstrated unsupported case is a blocker:
keep A open and resolve it before advancing to B; documenting it is not completion.
Close delivered subitems immediately; do not reopen them without a new failure or
contract change. Report limits without claiming permanently flat disk size or
universal query latency.

### B. Reduce session resource overhead

**Outcome:** additional agent sessions do not unnecessarily duplicate substantial
Gmax state, and ordinary indexing leaves bounded capacity for interactive reads.

Start from the known per-session MCP residency and existing daemon query routing.
Prefer lazy initialization and existing IPC sharing before introducing a new shared
server architecture. Address native/cache retention or busy/embedding-transport
cases only when existing evidence identifies a concrete owned defect. Keep process,
cache and queue budgets explicit; do not add a permanently resident extra worker.

**Completion:** a defined multi-session temporary scenario demonstrates lower
incremental resident state and preserved search/cancellation/lease behavior; root
review, required CI, release and installation are complete. Host kernel drift that
is not attributed to Gmax is a recorded limitation, not an endless Gmax task.

### C. Complete one document-search consumer rollout

**Outcome:** one explicitly selected consumer uses the shipped document interface
with a defined coverage policy, scope, freshness and honest unavailable states.

Resolve expected documents excluded by file policy, including the `secrets.*`
collision, without exposing credentials or bypassing exclusions indiscriminately.
Choose the consumer and authority contract before altering its settings. Broader
protected-fusion quality has not passed: either keep the existing production ranking
or qualify a concrete ranking change using fresh held-out judgments, preserving
lexical-only evidence. General code relevance is addressed only for recorded real
misses; no blanket ranking retune is included.

**Completion:** the selected consumer has an accepted end-to-end source/pointer and
freshness contract, unavailable states remain explicit, the coverage policy is
documented, and any Gmax changes are delivered. Work in another repository requires
that repository's owner/authorized handoff; do not claim their integration complete
from a Gmax interface test.

## Work outside the execution queue

These retain their evidence and reopen conditions. They are neither scheduled tasks
nor excuses to delay A. Opening one requires a concrete selected outcome and must
replace an existing milestone or follow its closeout; it must not create another
parallel omnibus plan.

| Area | Disposition and reopen condition |
| --- | --- |
| Watcher event-drop cause | Recovery/diagnostics are shipped; the underlying host/native drop cause is not closed. Use an actual new failure and existing gap metadata to identify a change. No repeated quiet-window acceptance or new watcher migration. |
| Native/host long-cycle memory | Historical attribution is incomplete. A reproducible Gmax-owned allocation defect belongs in B; unrelated host behavior remains reference evidence. No daily sampling task or new soak is scheduled. |
| Lower-priority performance | Nested class/method chunk duplication; embedding overlap/batching/reranker bucketing; repeated file classification; quadratic chunk splitting; row hydration; duplicate response serialization; blocking housekeeping process checks; graph N+1 lookups. Select only for a concrete cost relevant to A/B or after this plan closes. |
| Agent formatting | Not-found recovery already shipped. Additional error/output-contract coverage requires a demonstrated inconsistency; no blanket snapshot suite is scheduled. |
| Embedded languages | SQL skeleton MVP already shipped. Broader GraphQL/CSS/template symbol support requires a concrete corpus failure. |
| Relevance research | PPR/k-hop candidate recovery, graph-distance reranking, static expansion, generated hypotheses, semantic cache, seeded/hot-cold indexing and Merkle/chunk invalidation remain gated by the archived evidence/fixture thresholds. No active research target. Local model startup still requires an explicit in-session command request. |
| MCP protocol additions | Catalog hints, progressive discovery, Tasks and subscriptions require a real supported client workflow. Keep local STDIO; no speculative transport or protocol work. |
| Shared watcher | An independent package is optional. Watching stays in Gmax unless deliberately extracted; Hetchy Developer cannot be a dependency. |
| Embedding migration | Zero-downtime staging/cutover is unimplemented and deferred until a superior model, table layout/granularity and capacity are chosen. Archiving the former plan does not ship migration. |
| Depot/account reporting | Platform owns vaulted credentials, account usage and provider integration. Gmax's two existing uncommitted generic collector edits are preserved for disposition with that handoff; they are not a delivered provider integration or a new Gmax runtime milestone. |

## Execution and closure rules

- One current milestone, one owner and one finite acceptance contract. No new plan
  for each diagnosis, test pass, package step or observation window.
- Implement, review, run required checks, release/install and close the delivered
  work. Source-only progress is not delivery. Record blocked portions explicitly.
- Run checks once for a final change. Repeat only for a new change, failure or
  unresolved concern. Unchanged automatic-cleanup/timing observations are cancelled.
- Fix a new CI failure before adding unrelated scope. Documentation-only replanning
  does not require native builds, runtime probes, storage operations or model loads.
- Preserve critical-only host policy, the small GPU model, maximum two workers,
  client settings and live sessions. No manual production prune/rebuild or full-table
  compaction is part of this replan.
- Update this plan and the short orientation when a milestone delivers. Archive this
  plan only after its selected deliverables close, or with an explicit transfer of
  every remaining item. Archiving a record is never evidence of a completed repair.

## Version History

- 2026-10-09: Recentered the repository at the user's direction. Consolidated four
  open plans, corrected shipped items in the earlier inventory, retired repeated
  observation work and selected three ordered deliverables. No implementation,
  release, runtime restart, settings change or production storage operation occurred
  during replanning.
