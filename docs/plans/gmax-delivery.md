---
type: plan
status: active
created: 2026-10-10T06:45:25Z
updated: 2026-10-10T10:13:41Z
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
current_state: "Milestones A and B are delivered: 0.26.86 is published, registry integrity and byte identity with the source-qualified accepted artifact verified, both Node runtimes/plugin scopes and the ready active daemon verified. Local acceptance passed; no GitHub CI ran. All six workflows remain preserved and Actions remains disabled. Next session is a full CI/release requirements review, including release-only CI and trusted publishing; future policy is not locked. C stays queued."
next_step: "Review all CI/release requirements with the user before milestone C. Inventory triggers, runner/providers, local/Depot checks, duplicate work/minutes, Linux/macOS/build-box needs, npm trusted publishing, source/provenance and installation. Propose concrete options without restoring automation or treating the future policy as settled. Do not repeat unchanged acceptance tests."
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

Milestones A and B are complete. 0.26.86 is published, registry-verified and installed
in both runtimes/plugin scopes; the serving daemon is ready/active. Local checks
and installed startup acceptance passed. C stays queued behind the requested CI review.
Root owns review, integration and delivery. GitHub Actions is currently disabled
and release checks run locally. The user's latest direction is a full review of CI
and release requirements next session, including release-only CI and trusted
publishing. Future policy is not settled. Do not restore automation or treat earlier
zero-CI instructions as an approved final architecture; review requirements and
propose concrete changes first. Do not start agents without renewed steering.

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
4. Run the source/native/package checks locally for the final change, then complete
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

#### Milestone 1 implementation progress — October 10

Delivered 0.26.85 contains selected path/content index segments,
small compatible segment merging, partial physical-row relocation, resumable
complete-reference orphan inventory, a durable cumulative source-read journal,
protocol-3 receipts with protocol-2 recovery, capability-gated daemon admission and
one-minute follow-up admission after a completed unit. Existing safety budgets and
independent version retention remain in place.

Root review corrected physical-row verification after deletions, effective coverage
for retired fragment bits, logical coverage across segments, immutable FTS merge
inputs and explicit bounded-backlog refusal. Optimized native run 38036901011 passed
21 shipping and four fault cases on each of macOS/Linux. Packaged-consumer run
38037232882 passed on both platforms with concurrent Node protected readers and
independent Python verification of all 29 production-schema fields. Historical source CI passed before the user stopped GitHub CI; earlier failed runs
remain failed evidence. Final release-source checks then ran locally: 2,304 source
tests, 41 script tests, 23 Rust cases (plus a nested subprocess check), typechecks,
formatting and dependency audits passed. Python discovery passed 60 of 64 tests;
the four opt-in MLX HTTP cases then passed in the locked environment without model
loads. The 21 native shipping cases ran against the accepted binary in a temporary
store, including the task-owned small-volume cases. The packed npm consumer passed
watcher, prune, concurrent reader and new repair checks.

0.26.85 is published at source `6d1ff59`. A local publish attempt refused an
overwrite because the existing release had completed; the registry source and
SHA-512 integrity were verified before installation. Both existing Node roots
match all 313 registry package files, both plugin scopes match all 15 plugin files,
and the serving daemon is ready/active on 0.26.85 with five watch leases. Settings
and the two unrelated Depot edits remain unchanged. The installed temporary-store
check preserved all 29 fields and completed orphan reclamation and row relocation
within the existing read/write caps. No production manual prune/rebuild or unchanged
storage/timing observation was performed. Milestone A is closed.

#### October 10: zero GitHub CI

The user explicitly prohibited all GitHub CI and directed that workflows be moved
and preserved. GitHub Actions is disabled for this repository. All six workflow
files were moved byte for byte to `automation/legacy-github-workflows/`; none was
deleted. The release hook no longer watches CI or polls the registry. The full local
release suite is explicit `release:check`, and version staging names only the three
version files. Twelve focused hook/quarantine checks passed. There is no automatic
GitHub publication job. Publication and installation are explicit local operations;
future Depot work must not use GitHub Actions. The abandoned CI-reuse patch remains
isolated and unintegrated. The MCP startup
patch was subsequently reviewed and integrated under milestone B.

Private delivery proof is in `/private/tmp/gmax-milestone-1-evidence/`:
`local-release-checks.json`, `artifact-proof.json`, `final-proof.json` and
`installed-smoke.json`. It establishes the delivered selected cases, not permanent
flat disk size or universal query latency. B is next; C remains queued.

#### Milestone 1 implementation contract — preplanning complete

Milestone 1 is A above. This section fixes its scope and sequence; it does not create
another plan. The implementation and qualification above are now delivered;
this retained contract records the design that guided them. The pinned
implementation is Lance 12.0.0 / LanceDB 0.39.0, as recorded in the maintenance and
package locks. No SDK upgrade is required by this plan.

**Capabilities checked in source:**

- `CreateIndexBuilder.fragments(...).execute_uncommitted()` passes selected fragment
  IDs through both B-tree and inverted-index training. It can build bounded index
  segments without a data rewrite.
- `DatasetIndexExt.commit_existing_index_segments(...)` retains disjoint existing
  segments and rejects unsafe partial replacement/metadata mismatches. Use this
  path, not the ordinary builder's `replace(true).await`, which replaces the whole
  logical index. Compute effective coverage at the exact protected head.
- General `optimize_indices` has index-name/merge options but no source-fragment
  selector. `append()` alone does not bound its uncovered-data input. Do not use it
  for this operation or assume a cumulative-write cap also bounds reads.
- Native cleanup presently insists on whole selected files totaling at most 32 MiB,
  and counts affected index objects before copying. Increasing those constants
  would not solve index-write amplification safely.
- Lance exposes staged fragment writes, deletion-vector updates and `Operation::Update`
  transactions. These are the chosen primitives for partial row relocation: copy a
  small set of live rows, mark exactly those originals deleted in the same data
  commit, and leave other rows/addresses in place. This is a proposed composition
  of verified APIs; its query and crash correctness still requires new regressions.
- Deferred index remapping exists, but introduces a fragment-reuse mapping whose
  eventual drain also needs bounds. It is not the default fix and must not become
  another unchecked accumulating structure.
- SDK cleanup explanation has a candidate-list limit, not a bounded enumeration
  guarantee, and shares the retained-manifest timestamp cutoff. It cannot alone
  prove that a newer unreferenced object is safe to delete.

Source references: pinned `lance` `index/create.rs`, `index/scalar.rs`, `index.rs`,
`index/append.rs`, `dataset/fragment.rs`, `dataset/write.rs`; `lance-table`
`transaction/operation.rs` and `transaction/index_maintenance.rs`; Gmax
`engine.rs`, `selection.rs`, `meter.rs` and `prune.py`. The upstream
[compaction options](https://docs.rs/lance/12.0.0/lance/dataset/optimize/struct.CompactionOptions.html)
confirm deferred remapping and source/buffer controls. The Cargo source provenance is
`cbeec97cb893a66ad6b3db87f25a57ab0093f358`.

**Fixed scope and implementation order:**

| Work unit | Implementation | Required result |
| --- | --- | --- |
| 1. Bounded index repair | Add an index-refresh operation to the metered native helper. Select an uncovered cohort from manifest/index metadata; build path/content segments preserving existing field, tokenizer and position settings; publish with the exact head/owner and keep disjoint old segments. Bound small-segment merging so repeated edits do not create unlimited query fan-out. | Coverage increases for selected current live rows; existing indexed/unindexed matches remain equivalent; no data file or large base index is rewritten. This is the first implementation change. |
| 2. Remaining storage eligibility | Keep the shipped small-fragment path. Add bounded row relocation for larger fragments or expensive remaps. Stage all fields and selected row addresses; commit new rows plus original-row deletions atomically, then index the newly created fragments within the same protected operation. Remove the exhausted original fragment only when no live rows remain. | Larger fragments make finite progress without whole-fragment copying or whole-index remapping. Each commit preserves exact row content/IDs and prevents duplicate or missing live rows. Old physical files are reclaimed only after retained-reader/version protection permits it. |
| 3. Orphan reclamation | First reclaim helper-owned abandoned objects through the durable ownership journal. For pre-existing unowned objects, add a bounded resumable reference inventory covering every retained manifest, tag, reader, branch/base declaration and pending operation. Expire recent-object protection only under unchanged exclusive ownership. | Reclaim only objects with a complete absence-of-reference proof, even when newer than the oldest retained manifest. Truncated inventories, unsupported references, unknown owners or a changed head defer deletion. Never fabricate a new manifest to move the cleanup cutoff. |
| 4. Daemon integration and delivery | Route all new operations through the existing exclusive admission, protected-read window, runtime capability checks and recovery-before-writers lifecycle. Schedule one bounded unit at a time; retention keeps priority and live edits regain admission between units. | Autonomous progress with explicit coverage/deletion/backlog state, then one reviewed release and installation for the completed milestone. No new maintenance command or user-driven pruning loop is required. |

**Resource and recovery contract:**

- Keep the 512 MiB non-refunding cumulative write allowance and at least 1 GiB
  extra free-space margin. Every data, index, metadata, journal and verification
  write is charged, including retries and recovery for the same attempt. Preserve
  the existing host-policy checks, process reservation and finalization reserve.
- For oversized-file relocation, replace the whole-file-size eligibility proxy
  with a qualified range-read meter for the selected rows. Keep a 32 MiB ceiling
  on submitted source-data reads per unit, including selection and verification;
  target at most 8 MiB of copied row payload. Keep the existing 32,768 live-row and
  64-fragment limits, 64-row scan batches and bounded caches. Large underlying
  files are not permission to read them in full. Refuse an oversized range before
  issuing it; shrink the next work selection rather than resetting its allowance.
  Do not advertise this path until the new meter is exercised end to end.
- Metadata enumeration gets explicit object/file/version limits and a durable
  cursor. A cursor is progress, never proof of a complete reference inventory.
  Revalidate the inventory's head, protected versions and ownership before any
  delete; a mismatch invalidates the proof. No full production row scan.
- Bound index segments and mapping metadata as well as bytes. Merge only selected
  small compatible segments under the same ledger; never merge a large base as
  automatic fallback. The first implementation must establish finite catch-up
  capacity in the mixed-fragment fixture, not merely create more small segments.
- Extend the helper request/receipt with a versioned operation discriminator,
  selected source identity, coverage before/after, owned output identities and
  explicit intermediate committed heads. Keep protocol-2 recovery supported.
  An old or unknown receipt/capability cannot authorize a new operation.
- Each manifest publication is atomic. A relocation's data commit and subsequent
  index commits are distinct valid heads; do not claim one multi-operation atomic
  SDK transaction. Protected readers stay on the before head until verification
  and drain. On interruption, distinguish uncommitted owned output from a valid
  committed intermediate head, recover idempotently, and preserve current rows.
  Never roll back across a newer user write or report partial coverage as complete.
- `no-work` is valid only when the selected operation has no eligible backlog.
  Backlog excluded by a bound gets a specific reason and progress counts. A
  refusal must not disable independent version retention or repeatedly retry
  the same impossible batch without selecting another eligible unit.

**Checkout and integration:** root implements on one isolated branch/worktree from
this planning commit. The shared main checkout contains two unrelated Depot edits;
preserve them byte for byte and keep them outside commits and package staging.
Before integration, compare against the then-current main and reconcile only actual
conflicts. The version hook now stages only the three version files. Release
from an explicitly reviewed checkout without including unrelated edits. Do not create a PR. The user superseded the repeated-release-CI requirement on October 10: routine
pushes must return promptly, qualification runs explicitly, and publication may
reuse accepted native artifacts for the same source and acceptance contract. Keep
artifact identity and packaging validation; do not rebuild unchanged qualified
binaries merely because a release tag was pushed.

**Change map:**

- Native: extend `lance-maintenance/native/src/engine.rs`, `meter.rs`, `owned.rs`
  and `selection.rs`; isolate index refresh, row relocation and reference inventory
  in small modules rather than growing one monolithic handler. Extend the durable
  commit/receipt contract only where the new operations require it.
- TypeScript: extend `src/lib/store/bounded-maintenance.ts`, `vector-db.ts` and
  `src/lib/daemon/daemon.ts`; retain the existing coordinator, leases and paused
  reads. Add operation-specific status to existing diagnostics. Do not redesign
  search ranking, MCP transport, watcher ownership or resource policy here.
- Qualification/package: extend the existing native shipping/fault acceptance,
  Node-created full-schema consumer fixture and lifecycle/receipt tests. Update
  source digests/capability manifests through the existing packaging scripts.
  The historical Linux and macOS workflows are preserved outside the active
  GitHub directory; execute checks locally under the zero-GitHub-CI rule.

**Finite acceptance for the new change:**

| Case | Pass condition |
| --- | --- |
| Mixed indexed/unindexed edits | Selected path/content coverage grows, untouched index/data objects remain byte-identical, and exact-file plus lexical queries match the scan baseline before and after edit/delete transitions. |
| Larger fragment / large affected index | The old path refuses or cannot progress; the new bounded relocation moves a selected subset, preserves all production-schema fields and live IDs, and completes the finite fixture over several admitted units without exceeding reads/writes/segment limits. |
| Newer orphan | An owned orphan and an aged unowned object newer than the oldest retained manifest are reclaimed only with complete proof. Referenced, recent, externally owned, truncated-inventory and changing-head controls remain untouched. |
| Readers and interruption | Old readers keep valid snapshots; cancellation or injected failure at staging, data commit, either index publication and reader drain recovers without row loss, duplicate live IDs, lost old segments or allowance reset. |
| Scheduling and status | Continuous simulated edits cannot starve retention or eligible repair; one refused cohort cannot hide eligible work. A completed small unit cannot clear a larger remaining backlog. |
| Delivery | Final source/native/package checks pass on Linux/macOS. The registry artifact, both existing installations, plugin scopes and serving daemon match; settings/sessions remain preserved. A small operation-specific installed check verifies the new contract. |

Use new temporary fixtures and existing relevant regressions, not another unchanged
15-minute observer or a new multi-hour storage study. Root performs review after
implementation. Source checks and native qualification are explicit operations, not automatic
work that blocks every push. Reuse accepted evidence for unchanged contracts;
reruns are justified by a relevant source change or failed gate. No PR, new agent spin, live manual recovery or
publication occurs during preplanning. This historical preplanning phase is closed. Do not reserve a release version before the
final source is ready; account for concurrent sessions before tagging.

**Preplanning exit:** scope, chosen APIs, bounds, change locations, failure behavior,
acceptance and delivery order are recorded. The remaining uncertainty is whether
this proposed API composition passes its new implementation regressions; that is
implementation work, not a reason to repeat planning or historic observations.
Milestone 1 is complete as recorded above. B/C remain
inside this same plan.

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
review, local checks, release and installation are complete. Host kernel drift that
is not attributed to Gmax is a recorded limitation, not an endless Gmax task.

#### October 10: MCP startup implementation and acceptance

0.26.86 source `bcd5eb9` contains the reviewed lazy-startup change. The ordinary
`gmax mcp` entry avoids loading the full CLI command registry. Local search/cache,
worker, watcher registry and parser dependencies load only when required; concurrent
parser requests share one initialization. Disabled summaries stay disabled and no
local model starts. Existing daemon routing and per-session watch leases remain.
Explicit global CLI options retain the compatible registry path.

The finite three-session comparison on Node 22 measured aggregate RSS decreasing
from 390.9 MiB to 263.1 MiB (32.7%). The candidate loaded zero database/parser/native
modules during discovery and daemon-routed searches. This is temporary-fixture
process residency, not a guarantee about total physical host memory. New sessions
use the change; existing sessions adopt it on reconnect and are not forcibly killed.

Root review and all local checks passed: 2,311 tests in 227 source files, 41 script
cases, 23 Rust cases, all 64 Python cases including four separately exercised MLX
HTTP checks without model loads, both typechecks, formatting and registry dependency
audits. The packed consumer passed watcher, pruning, protected-reader and repair
contracts. Native source/binaries are unchanged and qualified artifacts were reused.
Regression cases preserve search, progress, cancellation, distinct renewable leases,
local fallback and clean session teardown. No GitHub CI ran.

Main and `v0.26.86` are pushed, npm publication completed after user MFA, and the
GitHub release is published. The successful publication used the CLI and user MFA
without the preview or GitHub CI. Registry SHA-512
integrity and byte-for-byte equality with the accepted tarball were verified. The
registry omits `gitHead`; source identity is tied to the recorded clean release
checkout `bcd5eb9` through the exact source-qualified tarball, not a registry source
attestation. Review source/provenance guarantees with trusted publishing next session.
The identical registry artifact is already installed in both Node roots. All 314
package files and 15 plugin files match, both plugin scopes are
updated, and the daemon is ready/active on 0.26.86. Both installed entries passed
the three-session startup checks with zero heavy modules. Settings and unrelated
Depot files are unchanged. Existing clients reconnect to adopt the startup change.
No reinstall or repeated startup/native acceptance was needed because the artifacts
are identical. Milestone B is complete.
Private evidence is `/private/tmp/gmax-mcp-startup-evidence/`, including
`qualification-summary.json`, the paired session reports and accepted tarball.

### Next session: review all CI and release requirements

The user remains dissatisfied with the CI setup and requested a full review before
further execution. This review takes precedence over starting C. The earlier zero
GitHub CI direction explains the current disabled configuration; the latest direction
reopens future policy. Release-only CI is a possibility, not a selected solution.
Trusted publishing must be included rather than assumed permanently replaced.

Inventory all triggers, checks, runner/provider choices, artifact builds, publication
and installation steps. Reconcile push speed/no routine waiting, tests in repo or
Depot, duplicate work/minutes, Linux/macOS coverage and the incoming local Linux
build box. Review npm OIDC trusted publisher configuration and its required workflow
identity. The preserved `release.yml` has `id-token: write` and npm OIDC publishing;
its move plus repository Actions disablement stopped that path from running.
Do not change credentials or publisher settings to make the review easier.

Present one coherent set of options and concrete workflow/hook changes for the user
to review. Do not restore old automation, delete preserved YAML, add push/PR jobs,
rerun unchanged tests or wait on CI while reviewing. No final future CI architecture
has been approved. Keep C queued until this requested review and steering finish.

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
- Fix a shipping failure before publication; CI does not monopolize execution or
  block independent implementation work authorized by the user. Documentation-only replanning
  does not require native builds, runtime probes, storage operations or model loads.
- Preserve critical-only host policy, the small GPU model, maximum two workers,
  client settings and live sessions. No manual production prune/rebuild or full-table
  compaction is part of this replan.
- Update this plan and the short orientation when a milestone delivers. Archive this
  plan only after its selected deliverables close, or with an explicit transfer of
  every remaining item. Archiving a record is never evidence of a completed repair.

## Version History

- **2026-10-10T10:13:41Z** Status: in-session → active — Milestone B delivered in published, registry-verified and installed 0.26.86. Next session: full CI/release requirements review, including release-only CI and trusted publishing; future policy is not locked. C queued.
- **2026-10-10T10:04:27Z** Started (active → in-session).
- **2026-10-10T10:04:24Z** Status: awaiting → active — User reports npm login complete; resume direct CLI publication and registry verification. No preview or GitHub CI.
- **2026-10-10T10:01:00Z** Status: in-session → awaiting — B implemented and locally installed/verified in 0.26.86; npm publication requires fresh authentication/MFA. C remains queued. No GitHub CI.
- **2026-10-10T09:35:23Z** Started (active → in-session).
- **2026-10-10T09:33:04Z** Status: in-session → active — Milestone A delivered in 0.26.85: both runtimes/plugin scopes, ready active daemon and installed repair verified. Zero GitHub CI: workflows moved intact, Actions disabled. B is next; agents and isolated patches remain stopped.
- **2026-10-10T08:19:42Z** Started (active → in-session).
- **2026-10-10T06:58:33Z** Status: in-session → active — Milestone 1 preplanning complete; implementation order, pinned APIs, bounds, recovery, acceptance and isolated-checkout delivery fixed. Ready for work unit 1; no implementation yet.
- **2026-10-10T06:50:16Z** Started (active → in-session).
- 2026-10-09: Recentered the repository at the user's direction. Consolidated four
  open plans, corrected shipped items in the earlier inventory, retired repeated
  observation work and selected three ordered deliverables. No implementation,
  release, runtime restart, settings change or production storage operation occurred
  during replanning.

- 2026-10-09: Milestone 1 preplanning completed against the pinned native/SDK source. Selected fragment index builds, partial row relocation and reference-proven reclamation; recorded budgets, protocol recovery, checkout isolation, finite acceptance and one delivery sequence. No implementation or production observation was run.
