---
type: plan
status: awaiting
created: 2026-10-29T13:06:23Z
updated: 2026-10-29T13:07:41Z
surfaces:
modules:
  - src/lib/workers/orchestrator.ts
  - src/lib/index/batch-processor.ts
  - src/lib/index/index-config.ts
domain:
audience: internal
parent_plan: docs/plans/gmax-delivery.md
related_plans:
related_docs:
current_state: READY FOR IMPLEMENTATION; planning only. Named Windows worker route selected as the smallest existing transport; live inference and activation remain unqualified.
next_step: On a later implementation selection, finish the 7-step source/fixture/docs batch. No worker activation, model load or release is authorized by this plan.
summary: Move background dense and ColBERT inference off P3 through a bounded named Gmax worker task, retaining P3 parsing, reuse, source fencing and the only store writer.
---

# Remote background embedding

## Decision and evidence

User selected planning on October 29, 2026. This document is implementation-ready
scope, not evidence of an implemented or activated remote backend. The
[delivery plan](gmax-delivery.md) owns shipped state; [local-worker integration](gmax-local-workers.md#source-checkpoint-and-limits)
owns the existing named-machine transport. The separate cooling owner owns fan
and power settings. No cooling, worker, model, service or client setting changes
are part of this documentation batch.

Released 0.26.110/source `920afc5419ea65bc314833a79b6c09600e1cc556` forks local
processes in `src/lib/workers/pool.ts:190`. The child reads/parses/skeletonizes
files, skips reusable chunks and computes dense plus ColBERT representations
in `src/lib/workers/orchestrator.ts:298,374,393`. P3's batch processor supplies
reuse keys, revalidates the file after work and writes vectors at
`src/lib/index/batch-processor.ts:648,665,836`. Those ownership boundaries stay.
The MLX client is localhost-only and dense-only
(`src/lib/workers/embeddings/mlx-client.ts:11,245`); changing its address alone
would leave ColBERT on P3 and would not establish authenticated fleet inference.

The retained passive window, October 29 at 12:44:03–12:44:13 UTC, measured Gmax
at 0.872 core, including its entire child at 0.351 core, versus about 6.26 busy
host cores. Package temperature rose 74→91°C; fan RPM was unreadable. Most host
CPU was not attributed by the two-census process sample. These are not embedding
stage timings, acoustic measurements or a prediction of offload benefit.
Source records: `/home/reoiv/.local/state/gmax-p3-fans/20261029-live/observation.json`
and `guard.json`; no new sample is selected here.

## Chosen transport and first target

Use the existing named Gmax job/artifact bridge, initially **`dell-win`**
(Windows x64), with a fixed new `embed-batch` task. Do not add an HTTP listener,
public endpoint, fleet registry, streaming protocol or arbitrary shell command.
The endpoint is the existing roster identity and authenticated Windows Worker
SSH/job-account path, not a new invented address or credential. The current
roster and its pinned-host/authentication procedure remain authoritative.

Evidence in the sibling Platform repository, all read-only in this assignment:

- `scripts/worker-pool.tsv:40` lists `dell-win` enabled for named tasks;
  [accepted Gmax Windows source/cache tasks](gmax-local-workers.md#short-windows-cache-and-selected-unit-acceptance)
  establish an existing route, not current idle capacity or inference readiness.
- `scripts/gmax-worker.mjs:49-74` sends an exact frozen packet and fetches named,
  hashed artifacts with `allowFallback:false`; uncertain completion refuses.
- `scripts/lib/worker-windows.mjs:147-153,750` accepts the exact Gmax bridge,
  source closure and job envelope. `scripts/lib/worker-windows-job.cs:185-214`
  creates a memory-limited, kill-on-close job and assigns a suspended child
  before execution. No new transport or interactive remote shell is needed.
- The Linux alternative is deliberately not v1: `scripts/gmax-worker.mjs:39-45`
  refuses an enrolled Linux Worker without a Gmax capability; signed lanes in
  `packages/worker/src/job-contract.mjs:10` and `job-executor.mjs:16-25` admit
  verification tasks, not embedding. Do not disguise inference as a test, use
  an administrator SSH escape, enable a held Mac, or reroute automatically.

This picks a documented candidate and transport. Availability, installed exact
model artifacts, host-key mapping and native Windows inference compatibility
remain unverified. Resolve their actual values from existing roster/preparation
metadata at a separately authorized activation, without changing the design or
asking the user to invent an endpoint. No new server is required. A metadata-only
`describe` operation reads the prepared runtime/model manifest and files without
creating an ONNX session; it establishes configuration, not loaded readiness.

## Routing, inference and payload contract

1. Add optional typed global configuration
   `backgroundEmbedding: { mode: "local" | "remote", worker?: string,
   runtimeCheckout?: string, runtimeCommit?: string }`.
   Missing configuration remains `local`. `remote` also requires an explicit
   reviewed immutable Gmax source checkout/full commit matching the activated
   package and prepared runtime, with its adjacent Platform integration. The
   global npm install does not itself have an adjacent Platform checkout; never
   infer this from daemon cwd or capture an unrelated/private working tree.
   Validate the source/package identity and refuse an absent or mismatched bridge.
   This reuses a selected committed runtime, not a new worktree created by this
   planning turn. `remote` requires the named admitted
   `dell-win` route for v1; unknown names/capabilities refuse. This is only
   background watcher/catch-up `processFile` work and daemon-owned pending-project
   synchronization (`daemon.ts:indexPendingProject`). Pass an explicit background
   route through `syncer.ts:SyncOptions`; the default stays local for direct
   CLI/user-requested full index/rebuild. Foreground query encoding and reranking
   retain their existing local route.
   Do not use this setting as an excuse to start/index another repo.
2. P3 retains file reads, containment, chunk/skeleton construction, formatting,
   content hashes, reuse lookup and filling, native stores, writes and leases.
   `processFile` carries a background-route tag and task attempt fence from its
   existing caller. Only chunks absent from reuse go remote. A fully reused
   file makes zero remote calls and must not initialize local document models.
3. Extract the current dense-plus-ColBERT calculation into a narrow shared
   `hybrid-embedding.ts` helper accepting existing model instances/generation.
   Preserve dense normalization, the 256-token Granite limit, the 512-token
   ColBERT document limit, quantization, scale, pooled vectors and token IDs.
   Split parser initialization from model initialization: remote-mode parsing
   must not call the current combined `ensureReady()` and accidentally load
   ColBERT locally. Local foreground query readiness remains independently lazy.
4. Use a versioned data-only request: `protocolVersion`, unique `jobId`,
   `daemonEpoch`, opaque `fileRevisionId`, `attemptId`, ordered `chunkId`s,
   input digest, deadline and exact embedding-generation fingerprint plus
   artifact-contract digest. Each item contains only already formatted document
   text (and a separate dense-input text only where the existing contract needs
   it). No absolute project paths, file contents outside selected chunks,
   credentials, environment, executable/command, native objects or store handles.
5. Initial bounds: 16 chunks per request; 32 KiB UTF-8 per chunk; 512 KiB total
   text and 1 MiB serialized embedding-input envelope; keep the existing separate
   64-MiB Gmax runtime-source cap (≤88 MiB complete base64 packet), never ship
   the indexed Platform source tree as a runtime packet. Split at existing chunk
   boundaries without new truncation. Dense/ColBERT token limits remain exactly
   those above, rather than changing eligibility or model behavior. Reject a
   single oversize chunk as deferred with a reason; do not silently alter it.
   One outstanding remote job across the daemon, one awaiting client request,
   and at most one background file waiting in a local child. Leave other work
   queued in the existing processor, preserving foreground pool priority.
6. Fixed `embeddings.json` artifact: matching IDs/digests/fingerprint, ordered
   results with dense float32 vectors, signed-int8 packed ColBERT bytes in
   canonical base64, positive finite scales, pooled float32 vectors and integer
   token IDs. Dense dimension must equal P3 generation; token count ≤512;
   packed byte length must exactly equal token count × declared ColBERT width
   from the prepared artifact contract. No duplicate/missing/unrequested IDs,
   extra arrays, NaN/Infinity or malformed base64. Cap decoded result at 8 MiB
   and serialized artifact at 12 MiB; validate before allocation/commit. Do not
   put vectors in the existing small terminal-status/log fields.
7. Inference uses the identical prepared ONNX Granite model and ColBERT int8
   model, tokenizer assets, quantization and pinned ONNX runtime as P3's active
   generation. Require the existing generation fingerprint **and** a digest of
   the exact model/tokenizer files, preprocessing contract and runtime revision;
   matching architecture names or dimensions alone are insufficient. V1 refuses
   Gemma/MLX-only generations and unsupported tiers, rather than switching
   models. No corpus migration or re-embedding is included. Float32 conversion
   and cross-OS inference do not imply bitwise parity; actual numeric/token
   parity is unqualified until an explicitly selected real-runtime check.

## Execution, failure and resource ownership

Keep a bounded one-shot job, not a new always-on inference service. Models live
in the worker's dedicated, read-only, prepared model cache; no download on a
background request. They load once per admitted job and are disposed on terminal
exit. Dependency/runtime preparation is keyed by committed Gmax source/lock,
platform/architecture, Node and model-manifest digest. Cache the immutable source
packet bytes on P3 once per daemon/runtime revision; never recapture the whole
working tree per chunk. Existing frozen-source transfer per job is retained for
v1; its overhead and cold model load may slow catch-up. Persistent model hosting
is not required for this first implementation or silently added as a prerequisite.

The named worker gets one reservation/job, a 180-second total deadline including
transfer/setup/inference/result collection, 2 CPUs and below-normal priority,
2 GiB aggregate owned RSS ceiling and existing host admission/memory floor
(at least 8 GiB free/available by the platform's native metric). Keep the existing
Windows Job Object memory/kill-on-close/deadline protections; add narrowly scoped
embedding-job affinity/priority before `ResumeThread` plus whole-job working-set
sampling, since existing committed-memory accounting is not an RSS equivalent.
A failure to enforce or observe the selected bounds refuses work. This is not
permission to change the worker's global configuration or other jobs.

The P3 transport/controller uses the corrected fresh owned Linux cgroup with
`memory.swap.max=0` before payload exec, existing 2-CPU/nice10/2-GiB/180-second/
8-GiB-floor, containment/OOM/cleanup rules. Apply that isolation only to its own
helper, not the shared daemon/service. Delegation from the actual daemon
launch context has not been established by the earlier agent-owned guard receipts;
missing delegation is a truthful remote-unavailable state, never an unguarded
fork or permission to change the service cgroup. Windows Job Object limits do **not** prove
zero pagefile use: record that platform difference explicitly; no swap-policy,
pagefile or power change is selected. A later Linux target would require its
actual delegated/systemd per-job no-swap enforcement and an admitted capability,
not a fallback or a second transport in this batch.

Use the existing Windows source lock, slot reservations, authenticated host
selection, native task launcher and hashed-artifact collection. Extend only the
exact new task/input/artifact shapes. Cancellation closes the owned request and
uses the existing worker task cancellation/deadline path; retain the slot and
attempt fence until terminal receipt **and** owned job cleanup are confirmed.
Disconnect/unknown cleanup is `remote_unknown`, never an opportunity to submit a
duplicate job. Persist the single outstanding job identity, worker, fence and
terminal/cleanup state in a private bounded record under P3
`PATHS.globalRoot/remote-embedding-job.json`, without chunk text or secrets.
Recover that record before admitting remote work after a daemon restart; epoch
changes invalidate returned data but do not erase remote custody. First trigger
and terminal/cleanup evidence stay distinct.

Check remote availability/custody before dispatching parsing work, not after
repeatedly spawning a local child. Do not feed a remote outage into the current
5–60-second backend retry loop (`batch-processor.ts:793`) or the full-sync
`processFileWithRetry` timeout retry (`syncer.ts:378`). Default retries are zero
for a submitted job. Refusal/outage leaves the file pending as `remote_deferred`, with reason and no local-inference fallback or
spawn loop. For unknown completion, retain the outstanding identity and block
new remote submission until terminal reconciliation from the existing receipt
mechanism. Resume deferred work only on explicit operator retry/routing change
or one confirmed transition from unavailable to ready; give it a new attempt ID
only after the prior attempt is terminal. Invalid/partial responses never fill
half a file's embeddings or commit a subset; collect all non-reused chunks for
the current file first. Keep existing file revalidation immediately before write;
a changed/deleted/policy-excluded file or generation/epoch/attempt mismatch drops
the result. Remote completion cannot authorize a P3 write by itself.

Store leases and filesystem truth remain exclusively P3-owned. Remote failure
never closes shared connections or frees a local worker beneath an unresolved
native operation. Foreground local query work remains separate from the remote
reservation. Offload is not a claim that parsing/Lance/FTS CPU or all fan noise
will disappear.

## Exact implementation boundary and 7 ordered steps

The following are proposed edits, not edits made by this planning assignment.

1. **Define configuration and data contract.** Change
   `src/lib/index/index-config.ts` and add
   `src/lib/workers/remote-embedding-protocol.ts` with the exact bounds/fences,
   artifact validator and model contract above. Keep existing config readable;
   remote is explicit opt-in. No dependency/model upgrade or public result
   schema/store-format change.
2. **Separate parsing from inference.** Change
   `src/lib/workers/orchestrator.ts`, `worker.ts`, `process-child.ts` and
   `pool.ts`; add `src/lib/workers/hybrid-embedding.ts`. Local paths delegate
   to unchanged math. `processFile`'s background tag selects remote only after
   reuse, with models lazy; `encodeQuery`/rerank never inherit that tag. Resolve
   the reviewed runtime checkout/commit independently of installed npm package cwd. Preserve
   existing per-file admission and priority. Do not import the dirty unreleased
   ColBERT query-feature refactor as part of this extraction.
3. **Add one fixed worker task.** Add `src/embedding-batch.ts` as a data-file
   entry (`node --import tsx src/embedding-batch.ts <fixed-input> <fixed-output>`),
   importing only the protocol/shared embedder/model helpers, never daemon/store
   startup. In sibling Platform, extend `scripts/lib/gmax-project.mjs`,
   `scripts/gmax-worker.mjs`, `scripts/gmax-worker-task.mjs` for a versioned
   `embed-batch` packet and exact `embeddings.json` result. Keep other task
   schemas/results backward compatible. The metadata `describe` variant branches
   before any lazy import of inference/native model modules. Use the existing prepared dependency tree;
   no per-job install, test, build or model download.
4. **Connect bounded custody.** Add
   `src/lib/workers/remote-embedding-client.ts` and a fixed
   `scripts/remote-embedding-job.cjs` adapter to that sibling bridge; extend
   `scripts/local-worker.cjs` only for the fixed data operation. Extend
   Platform `scripts/lib/worker-windows.mjs` and `worker-windows-job.cs` only
   where the named embedding task needs its input closure, affinity/priority,
   working-set guard and existing stop/result hooks. No generic command door,
   enrolled Linux bypass, new daemon, source-copy authority or fallback route.
5. **Integrate background state and fencing.** Change
   `src/lib/index/batch-processor.ts`, `src/lib/index/syncer.ts` and
   `src/lib/daemon/daemon.ts` to attach
   route/revision/attempt, enforce one remote reservation, defer rather than
   count remote outages as corrupt files, and expose additive bounded background
   status: route, worker, available/deferred/busy/unknown, queued/active count,
   last terminal reason and model contract. Extend `src/commands/status.ts`
   for that display. Do not expose text, secrets or holder IDs; preserve JSON
   compatibility for existing fields and paused-reader behavior.
6. **Finish fake fixtures and operator docs together.** Add one focused
   `tests/remote-background-embedding.test.ts`, mocking all transports, models,
   clocks and stores. Cover routing/background-only/no-local-fallback, reuse,
   exact wire validation, stale/cancelled/partial results, slot ownership and
   deferred/unknown states, including the Platform task validators where
   feasible. Update README, this plan and handoff with setup and rollback:
   prepare exact models/runtime on the selected worker only under later
   authorization; verify metadata without loading; select remote; revert the
   configuration to local to stop future remote admission. Await or cancel an
   existing owned attempt before local work can retry that file. Persisted
   model/index identity never changes on routing rollback.
7. **Close the source batch with only selected verification.** On a future
   explicit implementation selection, propose at most one fake-only focused
   invocation (`node_modules/.bin/vitest run tests/remote-background-embedding.test.ts`)
   and one guarded production compilation
   (`node_modules/.bin/tsc --noEmit --incremental false`), under the existing
   scoped limits. These commands are **not authorized or run now**. Inspect
   the selected cross-repo diff, finish source/fixtures/docs and local scoped
   commits in both repositories. No independent review, native/GPU run, broad
   tests, additional typecheck, profiling or implicit release/activation gate.

## Completion, permissions and remaining facts

Source-batch completion means all 7 steps are implemented coherently, selected
fake/type evidence is reported with its limits, and the local commits contain
all selected files. Fake tests and the TypeScript compile do not compile or
exercise Windows Job Object changes, remote ONNX sessions or resource enforcement;
those remain explicitly unvalidated at source-batch closeout. It does not mean
remote inference has run. Package release,
P3 deployment, worker preparation/enrollment/configuration and real activation
are later selected operations, not automatically queued by this plan. Any local
model over 1 GiB requires the contract's explicit in-the-moment authorization;
no planned fake test or metadata handshake grants that authorization.

Before claiming live compatibility, a future expressly selected activation must
establish exact target availability/auth mapping, prepared model/runtime hashes,
actual resource containment, the matching immutable runtime checkout/commit,
and same-generation token/numeric compatibility on bounded supplied inputs. This is a stated evidence gap, not a request to launch
a new qualification campaign now or a source-batch test acceptance gate.
Numerical tolerances must be selected from the actual same-artifact baseline;
no tolerance or performance result is invented in this document.

Existing 0.26.110 deployment/isolated-guard completion remains complete, with its
exact rollback in the [retained receipt](assets/mcp-cleanup-release-20261029/isolated-guard/completion.md).
Core8 is configured and directly advertised; the retained parent catalog check
was 329/full28, not an observed core8 refresh. The failed relevance attempt count
remains unknown, with no retry/reset; unrelated later dependency, ColBERT query,
resource-history and hourly-hook work stays separate. CPU attribution/backend
experiments and cooling settings are not selected by this plan. No current
availability/version claim is added to AGENTS.md or CLAUDE.md.

## Version History

- **2026-10-29T13:07:41Z** Status: in-session → awaiting — Planning complete; implementation, verification and worker activation are not started.
- **2026-10-29T13:07:41Z** Started (planned → in-session).
