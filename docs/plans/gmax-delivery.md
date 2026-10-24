---
type: plan
status: paused
created: 2026-10-10T06:45:25Z
updated: 2026-10-24T00:20:53Z
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
domain: Complete storage/query repair, session resource reduction, document-search rollout, and Linux commissioning with conditional GPU support
audience: internal
parent_plan:
related_plans:
related_docs:
  - docs/linux-gpu-p3-design.md
current_state: "Mac 0.26.96 retains bounded read-only service: native recovery refuses an older verified orphan receipt after the table advanced. Isolated Granite Metal GPU and ColBERT CPU stage profiling passed; normal Mac indexing remains blocked. P3 readiness is tracked by the platform session-host plan. Resource statistics remains held."
next_step: "Finish Mac baseline step 1 by repairing and qualifying native recovery of a verified receipt after later writes, then restore normal service. ColBERT MLX, CUDA and resource history are not started. Preserve the queued session-start-hint trim and optional NVM/worktree cleanup."
summary: "Mac baseline step 1 is partial: actual Granite Metal GPU use is proved, while native cleanup recovery blocks normal indexing. ColBERT remains CPU. Resource statistics stays held."
---

# Gmax Delivery Plan

<a id="current-direction--document-search-rollout-preparation"></a>

## Mac GPU baseline step 1: recovery and measurement

**Step 1 remains partial.** Normal Mac indexing is blocked by native receipt
recovery. The single isolated acceptance invocation passed actual Granite Metal
GPU inference and measured ColBERT CPU work. No model, provider, index generation,
worker setting, host policy or P3 setting changed. Resource history remains held;
ColBERT MLX and CUDA implementation have not started.

### Native recovery blocker

The installed 0.26.96 daemon refused one recovery attempt with
`Reclamation changed logical data/index state`. The pending receipt is phase
`verified`, before/after/verified-copy version 5410, with both owned protection
tags still pointing to 5410. Its orphan inventory is incomplete with no selected
candidates and no reclaimed files. Independent version pruning previously
completed at version 5585; that completion does not finalize this separate
receipt. Exact receipt, native output, binary digest and preservation checks:
[recovery.json](assets/mac-mlx-baseline-20261023/recovery.json).

The source recovery branch at
`lance-maintenance/native/src/engine.rs:1471` checks the current head against the
old before fingerprint for every repair receipt before reaching the branch at
`:1505` that verifies an already recorded after-version through its owned tags.
`lance-maintenance/native/src/orphans.rs:352` requires equal before/after
fingerprints, so later ordinary table writes make that first branch refuse this
otherwise protected historical comparison. The proposed repair routes receipts
with a recorded after-version through the existing protected before/candidate
verification; only an attempt with no recorded after-version uses current-head
candidate discovery. Preserve tag checks, exact historical comparison, source
journals, the non-resetting write budget, current-head protection and reader drain.
Do not delete or rewrite the receipt to force service open.

Remaining step 1 work is a qualified native repair, including a disposable
orphan attempt interrupted after verification, later ordinary writes, successful
protected recovery, and refusal when either historical snapshot or owned tag
changes. Packaging still requires matching native source and artifact proofs for
both shipped platforms, as enforced by `scripts/prepare-bounded-runtime.cjs:45`.
No native source or artifact was changed in this assignment. The existing Mac
store remains available through explicit bounded read-only service, with its
receipt and protection tags retained; normal indexing and daemon-owned MLX are
not restored. The temporary child-process observer was removed by a graceful
handover to that read-only service, without another recovery retry.

### Measured embedding stages

[acceptance.json](assets/mac-mlx-baseline-20261023/acceptance.json) records the
single invocation, inputs, source hashes and all timings. It ran installed
0.26.96 code with a private observer around the packaged MLX server and model
calls. The model itself and all inference algorithms were unchanged. The MLX
server reported `Device(gpu, 0)`, available Metal, evaluated real embeddings and
about 91 MiB active Metal memory. Every dense batch used MLX; CPU fallback count
was zero. ColBERT's installed `executionProviders: ["cpu"]` session performed the
second neural stage (`src/lib/workers/embeddings/colbert.ts:48`).

| Stage | Measured result |
| --- | --- |
| MLX process/model startup | 6.10 s |
| ColBERT first load | 128 ms |
| Granite MLX, 16-text warm batch, including loopback HTTP | 57-71 ms |
| ColBERT CPU, same warm batch, including its preparation and output processing | 167-177 ms |
| ColBERT CPU inference within those warm batches | 163-171 ms |
| Real 3,822-byte source file, 8 vectors | Granite 38 ms; ColBERT 224 ms |

ColBERT is the larger measured embedding stage. These are 3 warm batches of 16
source substrings up to 600 characters plus 1 real source-file run, not a
production corpus benchmark or a quality comparison. End-to-end timers include
additional pressure admission checks inserted by the private harness; stage
timers exclude those checks. Do not attribute the remaining time to parsing or
storage, or derive production throughput from these end-to-end totals. No
VectorDB was instantiated and no index insert/delete was called by the profiler.

The managed MLX Python environment was materialized by `uv` offline from its
cache and retained for later normal startup. The owned MLX process stopped, port
8100 was released, and configuration, project
registry and native receipt match the before-state. Private command/output and
observer sources remain in
`/Users/Shared/P3-Installer/mac-gmax-baseline-20261023/`. One test invocation was
used; there was no retry. Current P3 workspace and commissioning status belong
to [the platform session-host plan](../../../../platform/docs/plans/p3-session-host.md),
not the earlier dated P3 qualification below.

## Necessity audit — October 21, 2026

**User instruction:** audit all remaining repo work for absolute necessity and stop
adding work without a demonstrated reason. The current queue below supersedes
older milestone ordering and proposals. This is an audit, not authorization to
implement an additional feature or run another experiment.

**Document search is delivered.** Gmax searches indexed Markdown documents in
registered projects through `gmax mcp --existing-index-only`. The implementation
selects the caller's project; it is not specific to this repository. It returns
source paths/lines and indexed digests, with explicit cold/busy/unavailable states.
Project ignores determine which files enter the index. An ignored file is not a
missing document-search feature. README.md and DOCUMENT-SEARCH.md describe the
supported interface; native/packaged fixtures use arbitrary temporary projects.
The connection lifecycle defect is fixed and delivered in 0.26.92. The later
three-file pilot was an owner-chosen sample, not a general feature completion gate.

**Withdrawn:** changing this repo's ignore rules, adding
`scripts/search-documents.cjs`, requiring 3/3 pilot coverage, selecting an external
consumer, and making Linux wait for that exercise. No such helper or ignore change
was implemented. Those proposals lacked a demonstrated user need.

### Current remaining necessities

| Item | Evidence and necessity | Disposition |
| --- | --- | --- |
| Daemon startup can stop another Gmax instance's processes | In 0.26.92, `ProcessManager.killStaleProcesses` finds all same-name daemons/workers, but checks this home's heartbeat/socket and never establishes each target's ownership. With no local daemon, a healthy other-home daemon can be called stale; workers are signalled unconditionally. A prior test incident is recorded in this plan. Exact installed-module simulation reproduces both cases with fake PIDs and zero real signals. This can interrupt indexing or another session. | **Delivered in reviewed 0.26.93 / 56c7806.** Public npm bytes, signed provenance, GitHub release, both installations and live handover are accepted. |
| CPU/memory/disk history | Explicit user request, implemented in an isolated candidate; source approval exists but the original +41.935 ms p95 regression and control-precision problem remain unresolved. It is absent from the installed release. | **On hold by user direction.** Preserve source-approved `0d5282c` and inconclusive diagnostic; original regression stays open. No further investigation, integration or release selected. |
| Linux P3 setup | Explicit user-requested deployment/design work. CPU installation/baseline is useful for that deployment, not required to complete the Mac product. | **CPU installation and bounded acceptance complete October 23.** Existing user installation 0.26.96 matches all 324 published files and passes search, document search, FTS, MCP and indexed file-change checks. Normal account is Small/CPU/one worker with models ready; no production project added and no test process retained. GPU/CUDA remains optional; resource statistics stays on hold. |

The delivered ownership repair verifies the target instance/home and process
start identity before signalling. Unknown ownership refuses. Its regressions cover
foreign daemons and standalone watchers, recycled PIDs and cooperative same-home
handover. The earlier audit used simulated processes; accepted release and live
handover evidence is recorded below.

### MCP context packing — delivered in 0.26.94

The selected fix is delivered. When a function body exceeds the MCP
`build_context` size budget, the tool skips it and tries later candidates. It
reuses the CLI's existing `packByBudget` helper, keeps relevance order and
file/line references, and counts entry points, separators and the footer toward
the existing approximate token limit. An oversized body is never forced in.
Existing MCP sessions need a normal restart to load the updated server code.
This does not select the broader shared context composer or model/ranking work.
Resource statistics and its performance investigation remain on hold.

**Reviewed product source/tag:**
`58faaace8ded9e34136839cc904d155f0c63e9d4` / `v0.26.94`.
Implementation is preserved in `.claude/worktrees/mcp-context-packing-20261022`.
Three regressions fail against released source and pass with the fix. Four added
registered-tool cases cover oversized-first omission, fitting-result order and
labels, oversized entry-point labels, footer reserve and no forced body.

Validation passed: 2,461 source tests in 237 files, source/test types, build and
security audits. Independent parent-model review approved the exact source and
passed 101 tests in six files. Four compiled archive cases pass; installed
0.26.93 reproduces the original omission. The exact consumer audit, ownership,
document bridge, daemon/standalone watchers, native Session/containment, locked
prune and bounded cleanup checks pass. Biome passes with pre-existing warnings.
The initial Python suite ran 50 tests with 13 optional-runtime skips.

The 324-file archive changes only `dist/commands/mcp.js` and the three version
manifests; native payloads and the other 320 files match 0.26.93.
Archive SHA256:
`1e8c7ebb903971f463d57b68f4262f7a749697c8f91b54839d8b794d46abff8e`.
Source/archive receipts, registry/provenance, installation, plugin/native and
recovery proofs are in
`/private/tmp/gmax-mcp-context-release-0.26.94-20261022`.
Product review: `/private/tmp/gmax-mcp-context-packing-review-v1-20261022.md`.

**CI failure and recovery:** the original
[publication run](https://github.com/reowens/grepmax/actions/runs/39732926638)
rebuilt identical content and accepted npm publication at 06:18:12 UTC. Registry
verification received 404s, then failed at 06:23:52 UTC on an unhandled metadata
read timeout before the 480-second deadline. The product build and tests passed;
this failure did not require another npm publication.

Reviewed workflow fix
`a8b3617d36c049ac75f7fdcd2ece99ccefab639e` retries transient HTTP/network reads
within the same deadline and caps request waits/backoff by remaining time. Wrong
version, URL or bytes, malformed metadata and nontransient HTTP errors still
fail. Nine source tests, 18 independent offline scenarios, actionlint, embedded
Python syntax and diff checks pass. The full Python suite now runs 59 tests with
13 optional-runtime skips. Product source, tag and archive are unchanged.
Workflow review: `/private/tmp/gmax-registry-timeout-review-v1-20261022.md`.

The public registry archive matches SHA256, SHA512 and size; npm latest is
0.26.94. Sigstore verifies the exact artifact against the original publisher
`58faaac`, run `39732926638`, and GitHub workflow/main identity.
[Verification-only recovery](https://github.com/reowens/grepmax/actions/runs/39734613010)
**passes with the sole npm publication step skipped**. It rebuilds/compares the
same artifact, verifies registry bytes and publishes the
[GitHub release](https://github.com/reowens/grepmax/releases/tag/v0.26.94).
The original red run is historical; no duplicate publication occurred.

**Installed acceptance:** all three existing prefixes (Homebrew Node 26.12.0,
NVM Node 22.23.1 and 22.23.4) verify all 324 package files. The last was a stale
0.26.92 install, now reconciled. Native checks pass in all three runtimes without
loading a model. Both existing plugin scopes verify 15 files; other plugin
records are unchanged. Cooperative 0.26.93 → 0.26.94 handover completed with a
ready/active/open daemon, PID 35010, and configured worker count 2. PID/readiness
is dated acceptance evidence.

Gmax configuration, store identity, safety markers and 26 unrelated root files
are preserved. Two Claude settings hashes changed after the initial snapshot;
their 06:14:03 UTC mtime precedes local installation/plugin updates. They were
left untouched and recorded in `settings-proof.json`. Do not claim all client
settings matched that earlier snapshot or restore unrelated changes.

Delivery and CI recovery are closed. No manual MFA, repeat publication,
installation, handover or model experiment remains. Resource statistics is
absent from this release and stays on hold.

### Reduced resource sampler — October 22, on hold

**Latest user direction: put this work on hold.** Preserve the isolated prototype
and all source/review/measurement evidence. Do not resume performance testing,
integration or release without new direction. The unresolved regression remains
recorded; it does not block the separately requested Linux deployment.

The user agreed to owning a small recorder that reuses built-in counters and the
reviewed bounded writer. Telegraf remains an optional independent development
reference, not a bundled dependency. Node processes use built-in CPU/memory
counters; the already-owned Python backend uses its existing resource adapter.

Work is isolated in `.claude/worktrees/resource-sampling-20261022`, branched from
retained `479eb23`. The old source, frozen unreleased0.26.91 archive, failed
+41.935ms p95 result and failed controls remain unchanged. This is a reduced
prototype, not integrated into installed0.26.94; product integration and full
release qualification must not be inferred from isolated results.

Remove request/task UUIDs, AsyncLocalStorage context, per-result CPU snapshots,
operation histograms/details and per-operation project HMAC work. Keep explicit
60-second process sampling, finite five-second capture, cached workload state,
owned-backend counters, lifecycle events and the reviewed storage/capture fences.
Disk inventory remains a separate bounded activity; it must not run per request
or be represented as an instantaneous/complete capture-end measurement. No new
monitoring dependency, model load, production scan, setting change, service
handover or publication is selected by this prototype step.

Check the real worker message path with a model-free mocked worker, retain the
capture/epoch/ownership/storage regressions, then make a bounded model-free
measurement. Compare same-treatment controls before interpreting off/on latency.
Short or noisy measurements are diagnostic only; they cannot waive the existing
3% latency/CPU/retention qualification or retroactively explain the old42ms result.
Use an independent parent-model reviewer for the exact final source under the
standing owner-plus-independent-review requirement.

**Prototype checkpoint:** exact commit
`12cc7be7e48122ab312854b29244dae7d4b87608` removes the request-side collection
paths. Focused validation passes162JavaScript tests in16files,3Python counter
tests, source/test typechecks and build. Six optional MLX server tests skip
without their runtime; no backend/model execution is claimed. The real
process-child handler fixture verifies100task replies produce no CPU samples or
resource payloads between timer ticks; off cancels periodic reports. The CLI
marks operation tracking and standalone parent CPU as not collected.

Historical disposable off/on/capture smokes passed before12cc7be, with zero
models and unchanged settings/source during that run. Their hashes do not bind
12cc7be or the corrected candidate; they are not exact-source acceptance. Evidence is
`/var/folders/n2/c5kbh3vj7_s4t9_q0xc42z0m0000gn/T/gmax-sampling-measure-YUQ8m9`.
These five-second cases do not cover baseline minute cadence or qualify overhead.
**Round1 requested changes** for12cc7be: retained CLI/MCP pools stopped
refreshing preferences and saving periodic worker samples, and the diagnostic
could write the installed service's shared safety latch. Report:
`/private/tmp/gmax-resource-sampling-review-v1-20261022.md`.

**Corrected candidate:** `0d5282cfed7cca1c2bf11100dc28805376304f22` adds
minute-throttled preference refresh at existing request/report boundaries and
worker-only emission/flush, including packets arriving during an earlier flush.
Off/on revokes the grant and resets the CPU baseline; direct-parent counters stay
uncollected. The fixture isolates HOME before product imports, so latch/ledger
writes stay private, while read-only primary containment checks and the selected
real host-pressure probes remain active. No production safety override was added.
168JavaScript tests in17files,3Python tests, source/test typechecks, build, script
syntax and diff checks pass. New regressions cover retained CLI/MCP pools,
intermediate memory spikes, stale grants/disabled-gap counters, delayed flushes,
private critical-latch/ledger writes and primary quarantine refusal. Parent-model
round2 **approved exact source0d5282c**, independently passing142JavaScript tests,
3Python tests and an async/write-failure fixture. Report:
`/private/tmp/gmax-resource-sampling-review-v2-20261022.md`. Performance, package,
release and installed-release integration are explicitly outside that approval.

The committed explicit measurement helper runs one off/off control pair, one
off/on pair (70seconds per arm, retaining actual minute collection), then a
30second off/capture pair. It retains raw cycle/stage wall times and sampling
spans in at most1MiB per case, with a10minute global/95second case bound. It
uses one owned synthetic worker, disposable Lance stores, the unchanged
critical-only policy and guarded child handles; no process-group sweep or model
starts. Every result remains diagnosticOnly/qualified:false: this is one control
pair, parent/worker self CPU excludes probe-child CPU, and no full release
acceptance or cause for the original regression can be inferred.

**Completed after review, exact0d5282c / Node22.23.1:** all three smoke cases
and all six measurement cases finished within their deadlines. Source/controller
hashes and protected settings match before/after; private fixture homes were
removed. Zero models, one owned synthetic worker per case, zero dropped records,
zero collection errors and zero queued bytes at completion. The on case includes
one actual measured-phase minute event; capture includes five measured-phase
five-second events and completes back to off. Neither terminal drain nor the
capture's initial pre-measurement sample is counted as a timer event.

| Case | p95 wall latency (ms) | Parent + worker CPU (% of one core) | Peak sampled parent RSS (MiB) |
| --- | ---: | ---: | ---: |
| Off control A,70s | 50.128 | 14.124 | 357.516 |
| Off control B,70s | 70.536 | 14.585 | 357.719 |
| Off treatment,70s | 68.523 | 14.437 | 357.141 |
| On treatment,70s | 43.579 | 13.749 | 357.422 |
| Off capture control,30s | 49.670 | 13.497 | 357.641 |
| Temporary capture,30s | 75.737 | 13.941 | 359.469 |

**Disposition: functional diagnostic completed; overhead is inconclusive.**
Off/off p95 varies+40.712%, failing both3% resolution and10% raw-pair precision.
On being faster is not evidence of an improvement. Capture's observed CPU change
is+0.444 percentage points of one core, but one noisy pair cannot establish its
incremental cost. RSS is parent-only sampled resident memory, not unique physical
memory or retained collector overhead; CPU excludes probe children. No full
idle/model/disk/retention/package qualification ran. Do not clear either the
original+41.935ms regression or the performance gate.

Raw-stage inspection locates part of the off/off variation inside the worker RPC
wall spans: processFile p95 is23.660→35.410ms and encodeQuery19.693→29.422ms.
Native query p95 is3.097→5.640ms. These composite spans do not distinguish host
probes, scheduling, IPC or worker work; they are observations, not cause attribution.
Do not rerun the same comparison and hope for a pass. If this work is resumed, reproducible collection-off controls are a prerequisite
before any overhead claim or release work. This is not an active next step.

Smoke evidence:
`/var/folders/n2/c5kbh3vj7_s4t9_q0xc42z0m0000gn/T/gmax-sampling-measure-EsB8OP`.
Measurement evidence (raw cases, summary, closure and owner binding proof):
`/var/folders/n2/c5kbh3vj7_s4t9_q0xc42z0m0000gn/T/gmax-sampling-measure-3l1wRI`.
The isolated source remains clean at0d5282c; the installed release is unchanged by this prototype and the
sampler is not shipped.

### Process-ownership repair — ready plan

**Requested now:** plan the necessary repair. This records the implementation and
acceptance contract; no product code, process, model, setting or index changes are
performed in this planning turn. Work is limited to daemon startup/handover and
its process-termination decisions.

**User-visible outcome:** starting or upgrading Gmax cannot stop a different Gmax
instance's daemon or workers. A normal same-home upgrade still shuts down the old
daemon through its socket and waits for it to finish. An unresponsive or
unidentifiable existing process produces an actionable refusal, not a guessed kill.

**Chosen minimal design: remove unsafe automatic termination rather than build a
new process registry.** A process title, a PID file, a stale heartbeat or the absence
of this home's socket is insufficient permission to signal another process.
Home-specific IPC remains the supported way to ask an existing daemon to stop.
Unidentified abandoned processes may remain running; this is an explicit recovery
limit, not permission to broaden the scan. Existing owned-child teardown remains.

1. **Freeze the failure and isolate the change.** Create an implementation checkout
   from released v0.26.92, without copying the root's unrelated dirty files. Turn
   the audit's two exact cases into regressions: another-home daemon plus worker,
   and a worker with no local daemon. They must fail against the old termination
   decisions. All OS discovery/signals/spawn calls are injected or denied by the
   harness; real tests cannot enumerate or signal the host's Gmax processes.
2. **Remove the global startup sweep.** In
   `src/lib/daemon/process-manager.ts`, remove the all-system startup path that
   calls `killProcess` for every `gmax-daemon`/`gmax-worker`. Remove its invocation
   from `Daemon.start()` in `src/lib/daemon/daemon.ts`. Startup relies on this
   home's existing socket/lock arbitration. A healthy same-home peer is reused or
   blocks the new start; a foreign same-name process is irrelevant. Keep the
   separate periodic cleanup limited to this daemon's actual children and preserve
   its two-observation protection. Do not replace the deleted sweep with cwd,
   command-line, environment or name-based ownership guesses.
3. **Close the adjacent startup/handover holes.** In
   `src/commands/watch.ts` and `src/lib/utils/daemon-restart.ts`, keep socket-based
   shutdown but remove the blind raw-PID SIGTERM fallback. A failed shutdown request
   returns an error and starts no replacement. Version-mismatch `watch --daemon -b`
   currently starts anyway after a 20-second drain wait; replace that with the
   existing bounded restart discipline (90-second exit wait), then refuse if the
   old daemon has not exited. Recheck the same-home socket before spawning so a
   concurrently started successor is adopted. PID reuse must never authorize a
   signal. `Daemon.start()` also currently kills PIDs from the standalone-watcher
   registry: a registry entry alone is insufficient. If an existing watcher cannot
   be stopped through an already-owned handle/cooperative interface, refuse before
   opening shared indexing resources and identify the watcher that needs an
   explicit stop. Do not silently absorb it or delete its registry entry.
4. **Verify the whole termination boundary with a small matrix.** Update existing
   `tests/process-manager-draining.test.ts`, `tests/daemon-restart.test.ts`,
   `tests/daemon-lifecycle.test.ts` and affected startup/host-safety fixtures;
   add focused ownership cases where the existing seams do not cover them.

   | Case | Required result |
   | --- | --- |
   | Other-home daemon/workers exist; this home is empty | Startup makes zero termination requests to them; it does not exit just because they exist. |
   | Worker belongs to a standalone watcher or unknown parent | Startup leaves it alone; registry-only takeover refuses safely. |
   | Healthy/busy same-home daemon exists | Reuse or refuse duplicate startup; no signal fallback. |
   | Same-home version upgrade drains successfully | Request shutdown on this home's socket, wait for actual exit, then start/adopt one successor. |
   | Shutdown fails, times out, or old daemon keeps draining | Explicit failure; no SIGTERM/SIGKILL and no replacement start. |
   | PID is recycled, metadata is missing/corrupt, or probes fail | Never signal from that evidence; report refusal where it blocks takeover. |
   | A successor appears while the caller waits | Adopt the ready same-home successor; do not race another startup. |
   | This daemon has an untracked direct-child worker | Existing owned-child cleanup still works; unrelated/tracked children are excluded. |
   | Quarantine/read-only startup | Preserve the existing refusal/read-only policy; no hidden process cleanup. |

   The fixture must deny real process discovery and every nonzero host signal by
   default, not merely use a temporary HOME. The packaged regression runs the exact
   candidate with synthetic discovery/liveness, records termination requests and
   verifies zero foreign targets. No model/backend/native index is needed for this
   process-control acceptance. Do not execute the old unsafe startup on the host.
5. **Review, qualify and deliver the one fix.** Run the focused regressions first,
   then both typechecks and applicable existing release checks on the immutable
   candidate. Independent review of that exact candidate uses the parent model
   with inherited options when delegation is authorized. Freeze one archive,
   verify its changed-path packaged regressions, publish through the existing local
   process, verify registry bytes, update both existing prefixes/Claude scopes and
   perform one normal home-specific handover. Final live check is version/readiness
   and preserved settings, not a new soak, model comparison or performance study.

**Files expected to change:** process-manager.ts, daemon.ts, watch.ts,
daemon-restart.ts and their focused tests; daemon-client.ts only if the existing
exit-wait/socket helpers need a small contract adjustment. Keep generic process
utilities used by unrelated owned-model/helper lifecycles unchanged. Update the
process-ownership limitation and release metadata after acceptance. No new
ownership database, service, user command, document helper or unrelated feature.

**Done:** the original two failures fail before/pass after, the matrix passes,
normal same-home upgrades still work, the exact reviewed archive is installed and
serving, and the repair no longer signals pre-existing processes based only on a
name, registry PID or local liveness failure. If safe ownership is unavailable,
refusal is the intended behavior. Record that changed recovery behavior plainly.

### Repair implementation checkpoint — October 22 UTC

The user selected **“do it”** for implementation, independent review, qualification,
publication, installation and a normal same-home handover. The isolated checkout
`.claude/worktrees/process-ownership-20261022` starts from released v0.26.92 and
contains none of the root's unrelated edits.

Current candidate: **56c7806a6166766f4ba31e10616431f8234a68ae**, version **0.26.93**.
Global startup termination and raw-PID restart fallback are removed. A same-home
upgrade requests socket shutdown and waits for actual exit. Unknown owners and
registry-only watcher takeover refuse. Cleanup changes shared control files only
after the instance acquired and validated the home lock; its own partial resources
are still released. Daemon markers are rechecked under the lock. Watcher evidence
is rechecked after startup waits, immediately before storage construction and after
maintenance recovery before writer admission. Read-only policy, definitely dead
entries and owned-child cleanup retain their intended behavior.

The early startup check was wrongly treated as valid after later asynchronous
waits. Independent parent-model review exposed the missing lifecycle boundaries:

| Rejected source | Blocker | Correction |
| --- | --- | --- |
| e3128ec | Refusal followed by CLI shutdown deleted predecessor controls. | ec09033 scoped cleanup to acquired ownership and revoked it on lock compromise. Four full refusal/cleanup regressions distinguish the fix. |
| ec09033 | A drain marker appearing during lock acquisition bypassed the initial check. | 0259162 revalidated daemon evidence under the acquired lock before granting cleanup/publication. Three late-marker regressions distinguish the fix. |
| 0259162 | A watcher appearing during lock acquisition or socket listening bypassed the initial registry check. | 56c7806 revalidates at storage/writer admission. Six lock/socket arrival regressions fail before/pass after; recovery, read-only and dead-entry cases are covered. |

All three earlier archives are rejected, even though their narrower consumer gates
passed. Do not publish them. Their private directories are
`/private/tmp/gmax-process-release-0.26.93-20261022` and the corresponding `-v2-` and
`-v3-` directories. Review reports are
`/private/tmp/gmax-process-ownership-review-v1-20261022.md` through `v3`.
The current fourth review uses **codex / gpt-6.1-sol / high / default**, with no
nested agents. Report: `/private/tmp/gmax-process-ownership-review-v4-20261022.md`.

**Checks:** 97 focused tests in seven files pass. Both typechecks, build and format
pass (three pre-existing warnings and two infos). Original startup/restart failures
also fail against released source. The built-package VM checks full failed-start
cleanup, late daemon markers and late watcher entries; it rejects the previous
archives and passes the corrected build. Its filesystem, lock, socket and process
dependencies are injected; no real targets, discovery, signals, models or stores
are used. The full suite passes: **2,457 tests in 237 files**. Exact archive qualification passes: consumer dependency audit, ownership VM, document interface, daemon/standalone watcher recovery, native Session/containment, locked prune and bounded cleanup.

No dependencies changed. JS audit reports zero affected packages; Python audits
cover 69/15/58 packages with zero affected; 50 stdlib Python tests pass with 13
capability skips. Native payloads are carried from the accepted installed package
with source/checksum checks. Previous archives changed only the six affected
compiled modules, README and three version files; the new archive must confirm the
same boundary.

**Source approved:** round4 independently passed 97 focused tests and 16 injected
proof cases; all six negative controls rejected 0259162. Exact reviewed HEAD stayed
clean. The final archive is
`/private/tmp/gmax-process-release-0.26.93-v4-20261022/grepmax-0.26.93.tgz`,
324 files, 129,265,877 bytes, SHA256
**f1d119dba343ff4ace1f8c5875640243aa91465914816f1c1843e8c8a9e58088**.
Ten packaged files differ from 0.26.92; all other 314, including native assets, match.
Main and tag `v0.26.93` are pushed at the reviewed source.

**Local repair delivered.** Both existing prefixes were installed from that exact
qualified archive with lifecycle scripts disabled. All 324 package files match in
each prefix. Native LMDB, numkong, ONNX import, filesystem event and Lance checks
pass on Node22.23.1 and Node26.12.0; no model was loaded by those checks. The exact
installed ownership VM passes in both runtimes. Both existing Claude scopes
(user and project `/Users/reoiv`) contain the archive's 15 plugin files, preserving
scope paths, the existing marketplace source and all other plugin records.

The normal version handover requested shutdown through the home socket, observed
old **PID19843 exit**, then started **PID71965 / 0.26.93**, ready in0.6seconds with
two worker threads. The independent final IPC check reports ready, active, operations
open, resource generation1 and no pending rebuild. All nine non-registry settings
files and all 26 unrelated root files remain byte-identical; only the expected
Gmax plugin records changed. Small/GPU, critical-only policy and store/index
identity are preserved. Optional Gemma port18100 remains stopped. These PID/readiness
statements are dated acceptance evidence, not a permanent liveness assertion.

Private acceptance records: `installation-proof.json`, `installed-live.json`,
`plugin-proof.json`, `native-nvm.json`, `native-homebrew.json` and `handover.log` in
the final archive directory above.

**Public delivery is complete.** GitHub trusted publication of the exact v4 archive
succeeded in run `39717358032` using publisher source `911a267`. npm latest is
0.26.93. A full registry download matches the approved raw SHA256 and integrity;
Sigstore verification passes for its package subject, GitHub issuer, workflow,
main ref, publisher commit and run. The signed publisher commit contains the
unchanged reviewed product source. The [GitHub release](https://github.com/reowens/grepmax/releases/tag/v0.26.93)
is public. Existing local installations already contain those exact qualified bytes.

The two earlier manual web-MFA attempts each expired after about six minutes.
The user canceled that replacement path and reaffirmed trusted publishing.
**The manual-publication replacement is withdrawn. Do not restart its MFA flow.**

### Trusted-publication repair — October 22 UTC

The original Release run38037539347 completed its `publish-npm` job successfully on
October10 using `release.yml` with `id-token: write`. Commit `eb1f433` moved that
workflow out of `.github/workflows/`, and repository Actions disablement stopped
the working trusted-publisher path. The repeated manual requests were not a suitable
replacement. Latest user steering selects repair of publication, not broad CI work.

Isolated candidate **4331ed5d2cc8e2e67d26310b62662e2d2f5cf3c6** adds only an explicit
`workflow_dispatch` release publisher at the existing trusted workflow identity.
There are no push/PR triggers. All six legacy YAML files remain inactive and unchanged.
The job validates reviewed source/tag/receipt and archive hash, uses accepted native
payloads, builds on the hosted runner for truthful npm provenance, and requires the
resulting archive to match the approved bytes exactly before trusted publication.
It verifies registry bytes before publishing the prepared GitHub release. Step names,
registry progress and the run summary provide visible feedback. No credentials or
npm trusted-publisher settings change. Routine checks and native qualification are
not rerun in GitHub.

Actionlint1.7.12 passes; 15 focused gate checks (10 negative cases) and five hook tests
pass. Executing the exact build step locally from the clean publication checkout
reproduces SHA256 **f1d119dba343ff4ace1f8c5875640243aa91465914816f1c1843e8c8a9e58088**.
Parent-model review approved publisher `4331ed5` and diagnostic update `86217c6`.
The reports are `/private/tmp/gmax-trusted-publication-review-v1-20261022.md` and
`/private/tmp/gmax-trusted-publication-review-v2-20261022.md`. Actions is enabled
for the single manually dispatched publisher. The draft release holds the reviewed
archive and sanitized source/hash receipts.

Hosted runs [39715686389](https://github.com/reowens/grepmax/actions/runs/39715686389)
and [39716730756](https://github.com/reowens/grepmax/actions/runs/39716730756)
passed setup and source/archive validation, then failed compressed archive equality
before npm publication. Both produced SHA256
`2b77f2c41c709c108c9b2e79d63405050dc2d93476959828b925b5eaab9f0263`.
The diagnostic run found no differences in the 324 regular entries' names, types,
permissions, owners, timestamps or content hashes; entry order also matched.
A fresh Mac compilation matches every approved compiled module.

Approved publisher `911a267` streams both complete uncompressed tar archives through
SHA256. Only matching tar digests allow it to retain the approved gzip bytes. The
final compressed archive must still match the qualified raw SHA256. Hosted run
[39717358032](https://github.com/reowens/grepmax/actions/runs/39717358032) passed:
its complete tar SHA256 is
`d5c922d7d184cc15bc35674d5737c464729703318c6d73ea7231c05b67ec2f1f`, matching the
approved archive. Trusted npm publication succeeded at 03:34:06 UTC. The parent-model
review is `/private/tmp/gmax-trusted-publication-review-v3-20261022.md`; all 25
fixtures and lint/syntax/diff checks pass. The gzip representation, rather than
package contents or tar metadata, caused the earlier raw hash difference.

The final registry step then exhausted its eight-minute limit on a cached404 from
the canonical tarball URL. A query-bypassed download returns all 129,265,877 approved
bytes with matching SHA256/SHA512; signed provenance independently verifies.
After those proofs, the owner published the prepared GitHub release at 03:41:20 UTC.
The failed overall run does not mean npm publication failed; never republish this
immutable version. Private final evidence is `registry-proof.json`,
`registry-dist-tags.json`, `provenance-proof.json`, `provenance-statement.json`
and `registry-attestations.json` beside the qualified archive.

Cache-recovery candidate `52ea74e` adds a fresh verification query on each metadata
and tarball retry while retaining the canonical metadata URL check and raw hash.
An optional boolean `verify_only` skips only npm publication; all source, archive,
hosted build, full tar, final raw, registry and release checks remain mandatory.
It defaults to false. This allows publication verification without trying
to publish an accepted immutable version again. Actionlint, 15 original gate
fixtures, 10 compression fixtures and focused cache/dispatch assertions pass.
Independent parent-model review approved exact
`52ea74ef8b42ede9ba8ac7a1ec63136e3d6b7e69`; report
`/private/tmp/gmax-trusted-publication-review-v4-20261022.md`.
[Verification-only run39718868523](https://github.com/reowens/grepmax/actions/runs/39718868523)
**passes** on that exact source: npm publication is skipped, complete hosted tar
and final archive identity pass, registry bytes match, and the release step
succeeds. GitHub's registry check completes in three seconds. The original
provenance remains bound to actual publication source `911a267` / run39717358032;
the recovery run does not issue new provenance or republish the package.

**Repair closed.** Only the explicit release workflow is active; push/PR CI stays
absent. Both installed copies and the accepted live handover remain the previously
qualified package. No second installation, service handover, model run or index
operation was needed. Resource history and Linux retain their held dispositions.

The installed package and live daemon need no rebuild, reinstall, repeated handover
or model experiment. Resource history stays deferred; its checkout/archive and
failure evidence remain untouched. Linux remains pending actual machine/access.

### Full disposition of previously remaining work

| Item or family | Audit result | Why it is not additional required work now |
| --- | --- | --- |
| A/B storage/query repair and MCP session overhead | Closed | Accepted implementation, release and installed evidence already recorded. |
| G1 trace evidence and G2 graph work limits | Closed | Shipped in 0.26.87/88 and retained in 0.26.92. |
| Ranking correction and optional Mac Gemma | Closed | Shipped in 0.26.89/90; optional Gemma is available and Small stays default. |
| General document search and cleanup-readiness/helper launch corrections | Closed | General interface shipped; 0.26.92 fixes accepted source/package/native/installed failures. |
| Repo-specific document helper, ignore exceptions and 3/3 pilot target | Withdrawn | Invented delivery obligations; the product does not require this repo's internal docs to be indexed. |
| External consumer rollout or permanent client configuration | Remove from mandatory queue | No actual external integration was selected or blocked. |
| C1 shared context composer and C2 evidence enrichment | Optional | Possible consistency/tool-call gains are unmeasured; no current blocking task was established. |
| Additional graph resolver/binding, architecture overview and rationale links | Optional | New capabilities; current static evidence limitations are documented. |
| Callback/dynamic/cross-language graph coverage | Known limitations | A static graph cannot promise runtime binding. Add extraction only for a concrete supported case and need. |
| PPR/k-hop recovery, graph reranking, query expansion, semantic cache and related relevance research | Optional | No new demonstrated miss selects them; some earlier outside-pool premises were invalidated. |
| Gemma default promotion, larger models and automatic embedding migration | Optional/deferred | Current Small workflow works; separate model/index choices and compatibility evidence would be needed. |
| Language/DSL expansion, formatting polish, snapshot suites and module cleanup | Optional or already shipped | Shipped SQL/context/formatting work stays closed; broader changes need an observed failure or explicit request. |
| Historical performance catalog: duplicate chunks, batching, bucketing, repeated classification, split copying, hydration/serialization, housekeeping probes and graph N+1 | Reference only | Historical findings mix shipped fixes and possible optimization. No new measured user problem justifies a blanket performance project. |
| Watcher event drops, native/host long-cycle memory and kernel attribution | Retain uncertainty | Recovery/containment shipped; no fresh failure justifies another observer, soak or rewrite. |
| Old FTS creation races, missing-fragment corruption and native panic histories | Conditional regressions | Older evidence is not a current reproduced failure. Retain safeguards/recovery; reopen on actual recurrence. |
| Prune-only helper, bounded index repair and reference-proven orphan reclamation | Already delivered in A/current package | Old “unshipped” statements in limitations are stale; native upstream caveats do not reopen accepted bounded work. |
| Reader PID-reuse lease wedge and shutdown hang | Fixed | Known-limitations record and current lease code contain the fix; do not recreate it. |
| Sandboxed-client access | Supported configuration requirement | Missing Unix-socket/write permissions explain refusal; no new product feature or automatic permission widening required. |
| Consumer/source/Python security checks | Required for an actual release | Preserve existing gates; not a new scheduled audit, upgrade project or release trigger. |
| Trusted release publication | Selected repair | Restore the existing trusted publisher after the failed manual replacement; explicit releases only, no push/PR CI. Additional automation and MCP protocol features remain optional. |
| Shared watcher extraction | Optional | Standalone Gmax already owns watching; no external runtime dependency is needed. |
| Depot/account reporting and preserved dirty checkout files | Outside current product queue | Platform owns account/provider work. Preserve unrelated evaluation/collector edits; no unsolicited cleanup/integration. |
| Pending older handoff | Historical context only | Read through runlist without consuming; describes completed G2 activation and must not revive old work. |

### Audit scope and evidence

Reviewed runlist's **194 records**: one live plan, ten reference docs, one draft
evaluation, one orientation and one pending handoff; 180 archived records were
checked as retired metadata, not reopened as tasks. Inspected the current plan's
all remaining-item families, known limitations, old agent/performance/health audits,
root README/contract/security/CI docs and source/test/script TODO markers. No
standalone TODO/FIXME implementation queue was found (word-boundary search).
The old reference findings were assessed as potential obligations, not asserted
reproduced against today's source. This is a necessity audit, not a full security,
correctness or zero-defect certification of every file.

The process-ownership check executes the exact installed compiled module in a VM
with fake process IDs, mocked discovery, liveness and termination. It requests
termination of simulated foreign daemon 910001 and worker 910002 when local
liveness is absent, and of worker 910002 with no daemon present. No OS discovery,
signals, service/model startup or index change occurs. The current TypeScript
module matches source at v0.26.92. Private proof:
`/private/tmp/gmax-necessity-audit-20261021/process-ownership-proof.json`, compiled
module SHA256 `610483edc1e8e88390bdd89ac65c6ec2fec528e8666bb9346fb607ee195089bb`.
The prior real incident is in “Selected delivery — ranking correction, then optional
Gemma” below. Independent source approvals remain scoped to their reviewed changes.

**Baseline:** 0.26.92 / `3b2d52f`, public registry bytes verified, both existing
Node roots/all 324 files and both Claude scopes/all 15 files accepted. Small/GPU,
two workers, critical-only policy and settings remain unchanged. Earlier live
readiness/PID observations are dated evidence, not permanent liveness claims.

<a id="proposed-document-search-work--exact-changes"></a>

The former three-document/helper proposal at this anchor is withdrawn. Use the
necessity audit above; no replacement helper or repo-specific indexing exercise is
planned.

### Document-readiness delivery history

The following checkpoints describe their state at the time. The final 0.26.92
acceptance below supersedes all pending-login, pending-publication, offline-daemon
and review-next instructions in these historical records.

### Coding-session pilot — first read-only observation

The pilot uses the installed `/opt/homebrew/lib/node_modules/grepmax/dist/bin.js`
with `mcp --existing-index-only`, invoked by an owned bounded stdio client. Current
source is answer authority. The three named documents and SHA256 byte digests were
frozen before requests: `DOCUMENT-SEARCH.md`, `docs/known-limitations.md`, and
`docs/linux-gpu-p3-design.md`. Queries asked about source-pointer verification,
static graph limitations and CPU-before-CUDA commissioning. Prefixes were limited
to those exact files. This is a small usability pilot, not a ranking benchmark.

Observation at2026-10-21T13:32:20–21UTC:

- Bridge identity/catalog and status succeeded, generation1, warm query state ready.
  Coverage was **1/3**, partial, with degraded index metadata. `DOCUMENT-SEARCH.md`
  had a digest matching current source. The other two files were not covered;
  root `.gitignore:28` excludes `docs/`. That policy explains their exclusion and
  must not be silently bypassed or called an indexing defect.
- All three semantic requests returned **store_unavailable**, no pointers. A ready
  worker status did not establish a usable existing native store. Source inspection
  shows `existingTableForRead` refuses an absent connection or failed table open/
  protected checkout; the underlying live cause remains unassigned. Do not label
  this a fixed product bug or start a model/rebuild to mask the failure.
- All corpus byte digests remained unchanged. The owned bridge exited, with zero
  stderr bytes. No model/service startup, installation, rebuild, client-setting or
  coverage-policy change was performed. The pilot has not passed end-to-end.

Evidence: `/private/tmp/gmax-document-pilot-20261021.json` and its bounded client
`/private/tmp/gmax-document-pilot-20261021.cjs`. Next investigate store availability
through read-only evidence; define narrow intended coverage before indexing any
additional documents. Retain explicit failure/freshness states throughout.

### Document-store investigation and isolated correction

User selected **“investigate, go now.”** Investigation found a source lifecycle
counterexample: `VectorDB.performVersionCleanup` closed its connection/session and
released the cache reservation, then admitted read-only traffic while `db` remained
null. The connection could remain null after successful or failed pruning until an
ordinary operation called `getDb`. Restricted `existingTableForRead` correctly
refused to create that connection, so document search alone could not recover.
Warm-worker status and coverage metadata did not establish native-store readiness.

Isolated fix **`76c43d3`**, based only on shipped0.26.90 `86042c9`, is in
`.claude/worktrees/document-store-readiness-20261021`, branch
`fix/document-store-readiness-20261021`. Maintenance now awaits actual old-handle
closure, rechecks cancellation/containment, reopens the existing table under its
owned lease/reservation, verifies the head version, and closes the temporary table
handle before opening the read window. The current connection remains available
during and after pruning. Missing/changed/failed opens refuse before the helper or
read-window callback. Restricted document reads still cannot create a connection,
seed a table, evolve schema or start a runtime. No ranking change is included.

The new readiness regression **failed on the original source** (`db` was null at
read-window admission), then passed with the correction. Final validation:
**97 tests in7files**, source/test typechecks, changed-file Biome and whitespace
checks pass. Coverage includes real native connection/table close/reopen across
helper success and failure; missing/changed/failed head verification; cancellation;
existing no-connection/no-seeding, containment, bounded-maintenance and daemon
admission contracts. The native lifecycle tests use a private synthetic empty
store and mock the prune helper; they are not real physical-pruning acceptance.
Log: `/private/tmp/gmax-document-store-tests-20261021.log`.
Proof: `/private/tmp/gmax-document-store-investigation-20261021.json`.

Current read-only observation found no daemon socket or pid marker. Its own log
ends with a240-minute idle shutdown and normal cleanup. It was not restarted for
this investigation. Therefore the previous live heap cannot establish unique
attribution of every earlier store_unavailable response; the lifecycle defect is
independently reproduced and repaired in source. Current config/store-registry
hashes match the protected baseline. No product installation/publication, model
startup, real pruning/index rebuild or client/coverage-policy change occurred.
Resource-history source/evidence remain untouched and its performance item stays
deferred. Next review/qualify this exact small candidate, then deliver and rerun the
installed pilot; C remains open until consumer/source/freshness/coverage acceptance.

### Authorized delivery preparation — 0.26.92

The user selected **“go”** for parent-model review, package qualification, separate
release/install and the installed document pilot. The owner uses the runlist skill
for this sole plan. Resource-history performance remains open/deferred and its
0.26.91 artifact is not part of this release. Version0.26.92 deliberately avoids
confusion with that immutable deferred artifact.

ROUND1 approved exact76c43d3. Package failure qualification then exposed a separate
concrete helper-launch defect: an ENOENT spawn had no PID, but the stop handler
called ChildProcess.kill anyway; the private fixture's caller group exited143.
No live daemon existed and no production store was involved. The final guard
requires a safe positive child.pid before SIGTERM or scheduling SIGKILL, while
still awaiting child close before rejecting/releasing admission. The actual
failure fixture retains its evidence; no-PID unit regressions distinguish the fix.

Final clean source **3b2d52fc614eaecb455b22dd8863143158bc4233**, branch
`release/document-store-0.26.92`, is in
`.claude/worktrees/document-store-release-20261021`. VectorDB matches reviewed76c43d3
exactly. In addition to the helper guard, only release metadata, dev-only security
patches and test-fixture corrections differ from the prior candidate. Fresh audit
found2 moderate Vitest/mocker advisories; Vitest is pinned to patched5.0.3, with
production/optional dependency entries unchanged. The old HTTP control was race-
dependent; its native child now waits for pooling and closes the peer at reused
socket assignment, asserts ECONNRESET, then verifies two new connections through
the actual client. No model/backend is started. The child is bounded to10seconds.
ROUND2 independently approves this exact final source, including the helper and
fixture changes. Reports are `/private/tmp/gmax-document-store-review-v1-20261021.md`
and `gmax-document-store-review-v2-20261021.md`; both T3 tasks are completed and read.
They used parent codex/gpt-6.1-sol/high/default, without nested delegation.

Validation on the final candidate: **2417 tests/236files**, both typechecks, build,
format gate (existing3warnings/2infos), JS audit0known vulnerabilities and Python
registry audits69/15/58packages with0affected. Stdlib Python50tests,13capability
skips. Earlier full passes/failures, dependency choices and fixture failures remain
recorded privately; a new change justified final rechecking. Qualified bounded
native artifacts are carried from the accepted installed package, with source/
checksum/acceptance validation; no native compiler or model qualification reran.

Frozen exact tarball at
`/private/tmp/gmax-document-release-0.26.92-20261021/grepmax-0.26.92.tgz`,324files,
SHA256 **8a36930e7504bc6f104fd5f08522a3c4d04bca5ae807da8af76069a5cc539166**.
Fresh consumer dependency resolution/audit and bridge/import-boundary checks pass.
The installed-tarball lifecycle fixture passes **51 concurrent document reads**
while pruning2old versions, retains current2rows and tagged version1, and passes
post-prune plus actual missing-executable failure/read recovery. It uses synthetic
vectors and private stores, fixture-only immediate retention (production120000ms
unchanged), injected host admission, and the existing Python3.13 interpreter on a
private child PATH. The first isolated runtime setup lacked that interpreter and
refused; its failure is retained. No source/runtime defaults were weakened.
All remaining generic consumer gates passed: daemon/standalone watcher recovery, native Session/containment, real locked prune and bounded cleanup with current Node readers/all29fields preserved. The owner accepts the exact324-file package for publication.
Proof/logs are under the named release directory, including candidate-proof.json,
lifecycle-proof-final.json and consumer-final.log. User settings/markers remain
unchanged; daemon is idle/offline. npm whoami returnedE401. With the exact artifact ready, npm login --auth-type=web
--browser=false generated a fresh user login request; the old owned requests are canceled. The latest request825cdb2b was also canceled after continued user failure; no new link is generated. User-directed local Terminal npm login is the next authentication path.
No approval URL is stored in documentation because it is ephemeral. Never use the agent's
browser or reuse an expired approval link. No install/publication/startup yet.

### Publication resumed after manual authentication

The user completed login from their own Terminal; npm whoami verified **reoiv**.
Main and annotated tag v0.26.92 are pushed at exact reviewed3b2d52f. The owner
started publication of the accepted tarball with scripts disabled. Owned PTY91562
is still running at npm’s separate publication MFA requirement; a fresh approval
URL was delivered directly to the user and is not stored here. Registry acceptance
has not yet been confirmed. Installation, plugin refresh, normal startup and the
live pilot remain pending. Existing source/package qualification is unchanged.

### Publication accepted; registry processing pending

User completed the publication MFA. Owned publish PTY91562 exited0 with
`+ grepmax@0.26.92` and npm’s package-processing notice. This is publication
acceptance, not yet registry-byte verification: version endpoint still returns404
and latest remains0.26.90. A bounded registry check/download is running. Installation,
plugin refresh and normal startup wait for the exact archive match. No retry publish
is warranted and no further authentication is requested.

### Installed 0.26.92 and live coding-session pilot

npm accepted publication after user MFA and exited0. Registry metadata now exposes
0.26.92 with the exact accepted SHA512 integrity/SHA1/324-file count. Its archive
endpoint still returns404 during propagation. To continue the authorized fix,
the owner installed the already accepted immutable local archive while leaving
registry-download verification open; this does not claim registry bytes verified.
The public release binds source3b2d52f/tag v0.26.92 and SHA256 in checksum assets:
https://github.com/reowens/grepmax/releases/tag/v0.26.92.

Both existing global roots are updated: Node22.23.1/NVM and Node26.12.0/Homebrew.
All324 shipped files per root match the accepted archive. Installed native checks
pass in each runtime: LMDB write/read, NumKong, ONNX import, native watcher event,
Lance create/read and optional Gemma contract identity, without loading Gemma.
The old Homebrew26.8.1 executable is unavailable due an external library upgrade;
no OS/package-manager repair was attempted. The existing Claude marketplace source
is preserved; user/project scopes update to0.26.92 and all15plugin files per scope
match. Other plugins and all9protected settings paths are unchanged.

A fresh read found ready active0.26.90 daemon59690, started after the earlier offline
observation. Normal version handover drained it and started **71807**, confirmed
by IPC ready/active/open,0.26.92, generation1 and no rebuild pending. Small/GPU,
two workers and critical-only policy are unchanged; port18100 has no listener.
No manual production prune, rebuild, model migration or coverage change occurred.

The repeated existing-index-only MCP pilot now passes transport/read availability:
all3requests return ready; the authority question returns the expected
DOCUMENT-SEARCH.md pointer, SHA256 matching current bytes, at lines28–58. The owner
reread current source and confirmed its digest/provenance/source-authority rule.
Coverage remains **1/3** and index metadata remains degraded. The graph/Linux
questions do not return their expected sources because docs/ is excluded; results
from the covered document are not accepted as answers to those questions. This is
partial consumer acceptance, not a3/3quality claim or broad rollout. Corpus hashes
are unchanged; owned bridge exited with0stderrbytes.

Current pilot scope is the named already-covered document through this coding
workflow, with source reread/hash validation and explicit partial/unavailable
states. Admitting docs/known-limitations.md and docs/linux-gpu-p3-design.md needs a
small explicit coverage decision; no broad ignore/default secret exclusion change.
C1/context and Linux commissioning remain separate. Resource-history performance
stays open/deferred: clean479eb23checkout and frozen0.26.91archive are unchanged.
All26unrelated dirty files retain their protected digests. Evidence is final-proof,
plugin-proof, installed-live, install logs and registry metadata in the0.26.92
release directory; pilot is gmax-document-pilot-installed-02692-20261021.json.

### Final public artifact acceptance — 0.26.92

Registry processing completed. Downloaded132,876,431bytes match the reviewed
archive exactly: SHA2568a36930e7504bc6f104fd5f08522a3c4d04bca5ae807da8af76069a5cc539166,
SHA1/integrity match registry metadata, and latest resolves0.26.92. This closes the
registry-verification gate left open above; local installations therefore match
all324files of the accepted public archive. registry-proof.json and final-proof.json
record this outcome. Source/package/native/plugin/live/pilot acceptance is complete
for the readiness fix and already-covered document. Broader C rollout stays open
for the narrow two-document coverage decision; resource-history remains deferred.

<a id="resource-history-recovery-plan--current-execution"></a>

## P3 CPU acceptance — October 23, 2026

**Delivered:** the P3's normal user installation is `~/.local/bin/gmax` version
0.26.96. It was already present at execution time and was preserved, verified
against every file in the public npm archive, and tested. The originally agreed
0.26.94 was installed separately for the initial CPU baseline; it did not replace
the newer installation. No Gmax source or release change was needed.

The normal account now has Small/CPU/one worker and query logging off. Its
previously empty `~/.gmax` received the configuration and 27 verified model/grammar
files copied from the successful test. No fixture project was registered there.
No daemon or worker is left running. The existing shell profile already adds
`~/.local/bin`; a shell opened before that directory existed may need a fresh login
or the explicit binary path above. From a real project, use `gmax add .`.

**Environment:** Ubuntu 26.04.1 LTS, kernel 7.0.0-38-generic, x86_64/glibc 2.43,
Core Ultra 9 285 / 24 logical CPUs, about 64 GB RAM, Node 26.12.1, npm 11.20.0.
The recorded CPU governor is `powersave`; it was not changed. Only Intel graphics
was observed. No GPU driver, system npm prefix or system service was changed.

**Checks passed:** native CPU indexing; CLI semantic search with expected source
paths; extraction; inbound trace to the expected caller; context; lazy MCP startup
without a daemon; coding MCP search/context; document coverage and search with
matching SHA256 and source lines; native watcher create/delete and document edits;
restart with the existing index; and graceful shutdown. The existing-index-only
document bridge returns `daemon_unavailable` while stopped and starts no runtime.
On 0.26.96, indexed symbol creation, rename/removal and deletion were checked
through indexed symbols rather than live file excerpts. `doctor` reports no
orphaned readers, stale temporary files, embedding mismatch or schema mismatch.

0.26.94 initially reports missing full-text search. The 0.26.96 supported command
`gmax repair --fts` builds it in the isolated store in 0.1 seconds, after which the
warning disappears. This is existing released behavior, not a new repair.

**Bounded measurements:** a fixed source snapshot of commit `58faaac` contains
79 files / 14,114 lines / 465,915 bytes from `src/lib/index`, `src/lib/utils`,
`src/config.ts`, `src/commands/config.ts` and `package.json`. One-worker initial
indexing under 0.26.94 took 169.7 seconds and produced 1,155 rows, in addition to
the 11-row contract fixture. First fixture setup including model/grammar downloads
took 51.2 seconds; npm installation took 85.9 seconds. A CLI query against the
completed fixture during source indexing took 0.81 seconds. Sampled aggregate RSS
across owned Node processes reached about 1.4 GiB, including concurrent test
clients; sampling every 250 ms is not an exact allocator or unique-memory peak.

For 20 warm MCP requests across four fixed queries, 0.26.94 recorded median
39.4 ms / p95 64.2 ms. Current 0.26.96 with FTS recorded median 39.4 ms /
p95 45.9 ms / maximum 62.2 ms. The latter request group consumed 1.03 CPU seconds
across surviving owned processes over 0.81 wall-clock seconds, and ended at about
842 MiB aggregate RSS including both MCP clients. Different FTS state and the
small sample do not establish a version speedup. Current indexed create, rename
and deletion reached the index within about three seconds in this fixture.

The current installation occupies 1,562,943,488 allocated bytes, the normal
model/grammar/config home 192,536,576 bytes, and the isolated tested index about
24 MB. Extra archives and the separate 0.26.94 test installation are qualification
evidence, not required per-project storage. Swap remained unused at the recorded
checks. These are small-corpus results, not a large-repository capacity claim or
a CPU/GPU comparison; no further benchmark is selected.

**Evidence:** P3 `~/.local/state/gmax-p3-qualification-20261023/` retains the
harnesses, source tar, archives, logs, `results.json`,
`current-0.26.96-results.json`, `host-facts.json`, `existing-0.26.96-proof.json`
and `primary-ready-proof.json`. A local copy of the small records is in
`/private/tmp/gmax-p3-acceptance-20261023/`. Two failed harness assertions are
retained: one excluded the trailing empty source line; the other incorrectly
asked the Markdown-only document status tool about TypeScript. Corrected checks
passed; neither was treated as a product failure. The initial live-excerpt edit
observation is superseded by the current indexed-symbol rename check.

Archive SHA256: 0.26.94
`1e8c7ebb903971f463d57b68f4262f7a749697c8f91b54839d8b794d46abff8e`;
0.26.96 `9f1499e71239228284ca47de25d3fceb7bfaa95564fc6a01a0afd00e28730ade`.
Both match all 324 installed package files. Source snapshot tar SHA256:
`e4f5257607bf8aaace96bd54bc4fc2e37e20774ee378d8ac1f1418ddb613bce1`.

CPU installation and this finite acceptance are complete. Resource statistics
remains on hold. GPU/CUDA and larger workloads require a separate selection;
the historical GPU acceptance gates below are not claimed complete.

## Resource-history recovery plan — deferred

**Deferred by the later user instruction “leave this item open, move forward.”**
This section preserves the recovery contract and completed steps. It is not the
current execution queue. The original regression remains unresolved; no new run,
source change or release is selected. A future resumption starts from the recorded
step 3 checkpoint and must address the reviewer investigation's attribution limits.
The earlier instruction to keep repairing after a failed timing gate explains this
plan's origin; it does not override the user's subsequent deferral.

### What went wrong in the execution

- The owner fixed review counterexamples sequentially without first building a
  complete ownership/interval/settlement matrix. Independent review became the
  primary way to discover classes of bugs, producing repeated candidate churn.
- The timing fixture combined worker CPU, IPC, native queries and periodic native
  inserts into one percentile. It retained no per-cycle/stage timings, separate
  parent/worker CPU or event timeline. With inserts in10% of cycles, p95 can fall
  in that cohort; the aggregate cannot identify the cause of the42ms difference.
- No same-treatment A/A stability check established whether this fixture could
  resolve the3% target. Calling the71% signal "noise" was premature: product cost,
  harness bias and host variation remain competing explanations.
- The owner treated "do not publish or rerun unchanged" as "stop fixing". That was
  wrong. Source approval and passing correctness checks do not finish delivery.
- Frontmatter still described418f220/review3 while appended history described a
  later approved source and failed performance. Current state/next action must
  remain authoritative and current, with chronological evidence preserved below.

### 1. Make the failure attributable before another long comparison

Owner works in the isolated resource-history checkout. Keep477779b and its archive
as the immutable reference; create a new candidate for any harness/product change.
Preserve the failed run and all prior reports. Add bounded private fixture output:

- Raw cycle ID, treatment/order, fixed work count and database starting state;
  worker dispatch/queue/round-trip, native query, native insert and total wall time.
  Report insert and non-insert distributions as well as the original weighted
  composite; do not replace a failing composite with a faster selected subset.
- Parent and owned-worker user/system CPU separately; synthetic PBKDF CPU/wall,
  IPC control/sample/result counts and bytes, timer creation/reset counts, and
  parent event-loop delay. Establish exactly where the extra CPU and tail wait go.
- Collector tick/flush/inventory/GC timestamps, queue/drop/error state and bounded
  writer-stage wall/CPU measurements: guard/lease acquisition, enumeration,
  reservation, data write/sync and release. Profiles run only in clearly labelled
  diagnostic blocks; profiled timings cannot serve as release acceptance.
- Instrumentation is identical in both arms. Bound trace state/output to10MiB,
  write outside hot loops, retain all outcomes, and verify tracing overhead using
  a short uninstrumented cross-check. No real query/content/environment capture.

Deliverable: a small diagnostic report and timelines that can assign the observed
increase to a stage/role, or show which control is unstable. No causal claim from
one aggregate percentile.

### Step1 completed — 2026-10-21

User selected **“do1”**. Isolated commit `10dd5d67ebd328bec02bcc9bffa292cc267724b7`
adds the shared model-free case runner, bounded recorder/reporter, dry16-block
control/ABBA manifest, private case/report commands and usage documentation at
`scripts/RESOURCE-OVERHEAD.md`. Product `src/`, Python runtime and version files
remain identical to approved `477779b`; its failed-run evidence and frozen archive
are preserved. This is a new fixture candidate, not renewed release approval.

Traces retain raw cycles and insert cohorts, worker enqueue/preparation/round-trip
spans, native query/insert spans, parent/worker CPU, estimated IPC traffic split
from fixture protocol, timer/sample counters, collector/writer timelines, GC and
event-loop observations. Plain cases retain raw latencies and role CPU without the
trace wrappers. Profiles occupy separate explicitly ineligible blocks. Reports
reject mismatched state/builds, incomplete/dropped evidence, profiled controls and
invalid assignments. Per-case output ceilings reserve a total10MiB batch budget;
trace strings, counters and outstanding RPCs are bounded. Profiler transient
buffers and serialization copies are disclosed separately under heap/RSS ceilings.

Validation: **8 focused checks passed**, including480-cycle trace capacity and
five tiny mixed-path cases (3 operations each): traced/plain off/on, plus a separate
parent/worker profile smoke. All completed with zero model loads, trace omissions,
pending RPCs and queue drops; private reports reject smoke as qualification.
Plain/traced off/on fixtures have matching starting state and source/runtime
bindings. Syntax, test typecheck, formatting and whitespace checks passed.
Evidence: `/private/tmp/gmax-resource-step1-final-20261021/step1-proof.json`, raw
case files, dry manifest and report; final test log
`/private/tmp/gmax-resource-step1-tests-v3-20261021.log`. Total retained evidence
is about97KiB. Primary config/store/client hashes, unrelated root dirty files and
the immutable334-file archive hash still match the earlier preservation proof.

**The original regression is still unattributed.** These tiny cases verify evidence
plumbing, not timing precision or performance acceptance. No12-minute matrix,
full qualification, model, daemon, reviewer, install or publication ran in step1.
The next action is step2: a finite outer controller and controlled attribution.

### 2. Run one bounded diagnostic matrix, with controls

Initial diagnostic controller:12minutes maximum including setup/warmup/cleanup,
private homes, no daemon/model loading, same owned-worker and memory ceilings.
At most16 short blocks, each with80 fixed operations targeting20seconds and a hard
30second case bound. Prescribe seeds, operation order and fixture starting state.
Use same-treatment off/off and on/on controls, then counterbalanced ABBA blocks
for worker+IPC, native read and native insert paths. Prepare/reset identical tiny
store states outside measured windows; keep setup inside the controller budget.
Collect isolated writer measurements within the remaining budget, with forced
flushes explicitly labelled diagnostic, never baseline-cadence acceptance.

Controls must demonstrate resolution materially below the3% target (aim<=1%
median same-treatment bias), and retain the existing+/-10% raw-pair ceiling.
If controls vary materially, fix the fixture/state/warmup/pacing first. If controls
are stable and a treatment stage regresses, fix the product path. Both may need
repair. Do not weaken thresholds, discard slow samples, choose favourable pairs,
change host policy/affinity or repeat an unchanged experiment seeking a pass.

Check actual frequencies before optimizing. Reporter.configure clears/rearms and
forces a sample when called, but current parent control delivery is tied to
scheduling/worker attachment, not simply every dispatch. Count it. Also measure
forced per-result counters, context/metadata allocation, IPC volume, native insert
latency and synchronous guard work. These are hypotheses, not diagnoses.

### Step2 executed — 2026-10-21; control precision failed

User selected **“do2”**. Diagnostic controller/source `4fb648f` passed13 focused
checks, syntax/type/format/whitespace checks, then ran the prescribed controls and
ABBA worker/query lanes. It retained12 completed blocks and a failed insert
preparation: the row-state check used a table handle opened before four warmup
writes and saw64 rather than68 rows. The controller stopped and reaped its group.
This was an actual fixture bug; it was corrected instead of ending work there.

Commit `a435154` opens a fresh table for that preparation check. A native regression
verifies68 rows and subsequent inserts. An explicit four-block residual pass ran
only the previously unmeasured insert tail, rejecting changed product bytes,
repeated measured blocks and any new twelve-minute budget. The original evidence
is immutable; the two harness builds remain separate. All16 planned measured
blocks/1280 cycles completed, with the failed preparation also retained, from
**12:02:14.662 to12:12:42.019UTC (627.357seconds)**. This is not a passing
single-build matrix or release gate.

Controls fail unchanged requirements: off/off p95 **94.027→61.429ms(-34.669%)**;
on/on **61.825→69.857ms(+12.992%)**; median absolute p50 bias18.830%. Worker
raw pairs disagree (+8.091%/-15.278%). Query off/off drifts2.246→8.950ms.
Corrected insert on/on drifts14.744→38.134ms. No samples/cohorts were discarded.

Stage evidence localizes substantial worker-tail variation to existing admission
probes:160 admissions/320sysctl/160zprint calls per80-cycle worker block. One163.551ms
off cycle spends101.851ms in probe wall spans. Native read/write variation also
persists without measured worker probes; this is not a complete probe-only cause.
Reporter configure/timer reset counts are zero during measured work; per-result
packet p95 is0.013ms on/0.003ms off, so per-dispatch timer rearming is unsupported.
Short-block writer guards occur only in the labelled terminal drain;60second
periodic overhead remains untested here. No exact cause can be retroactively
assigned to the older untraced59/101ms observation.

The CPU description falsely said no subprocesses execute during measured work:
existing pressure probes do. Commit `66963d5` corrects the description to parent/
owned-worker **self** CPU, excluding probe-child CPU, and records the full diagnosis
and next corrective checks in `scripts/RESOURCE-OVERHEAD-DIAGNOSIS-20261021.md` in
the isolated checkout. Do not sum nested stage CPU or replace the original raw
composite with probe-subtracted wall time. The mixed query path still holds an
older table handle across inserts; step3 must define/verify current-index visibility.

Verification after the correction:14 focused checks passed in the full invocation;
the new insert smoke initially exceeded Vitest's default5second timeout because
owned fixture cleanup itself takes about5seconds. Its timeout now exceeds the
fixture's own30second bound;7 targeted checks, including the native insert
regression and residual-report validation, pass (15 distinct checks covered).
No blanket timing retry was used to obtain passing controls. Syntax/type checks
pass. Current product source, Python runtime, package/version files and immutable
reference tarball are unchanged. All17 attempted-case process groups are absent;
all completed cases have zero model loads/omissions/pending RPCs/queue drops.
Batches total3,473,696bytes (<10MiB); observed parent RSS peaks about136MiB.

Evidence: original `/private/tmp/gmax-resource-step2-matrix-4fb648f-20261021/`,
separate `/private/tmp/gmax-resource-step2-insert-tail-20261021/`, derived
`/private/tmp/gmax-resource-step2-stage-attribution-20261021.json`, preservation/
closure `/private/tmp/gmax-resource-step2-proof-20261021.json`. Live socket ping
`/private/tmp/gmax-resource-step2-live-20261021.json` verifies ready/active0.26.90,
PID10475, operations open. Primary config/store/client hashes and unrelated root
edits match the pre-run proof. No model, service transition, reviewer, full
qualification, install or publication ran.

**Next is fixture repair, not release:** verify write visibility through the exact
query path and warm native inserts; pair treatments within a shared owned process/
worker lifetime with verified equivalent state and labelled transitions; preserve
admission behavior, raw timings/cohorts and CPU thresholds. Then use the existing
one6minute corrective verification after the concrete change. Failure to resolve
same-treatment variation returns to diagnosis rather than speculative product
optimization or another full acceptance run.

### 3. Fix the demonstrated cause and verify the complete boundary class

Patch the responsible product path, fixture, or both. Each change must state the
measured cause, expected mechanism and falsifying check. Candidate optimizations
include idempotent control handling/coalescing only if frequency/cost is confirmed,
batching/avoiding repeated collector work, or correcting unmatched native state
and timing instrumentation. Keep the non-expiring ownership guard and all privacy,
quota, capture-deadline, stale-grant and host-policy guarantees intact.

Before another review, use one owner checklist covering state transitions and
pending operations: off/on, baseline/capture, deadline/stop/quarantine/storage,
acquire/revoke/release/exit, pending marker/target/close, late callback and retry.
Retain the prior independent reproducers as regressions. Run focused checks after
edits; run the complete required suite/package gates once the candidate is ready.

One targeted verification controller, maximum6minutes, follows a concrete change
and its predicted mechanism. It is not another full acceptance run. If still wrong,
continue code/trace analysis and make the next corrective action explicit; reaching
an experiment cap does not mark the problem solved or end ownership. Additional
timed work needs a stated changed hypothesis and finite budget, not an automatic
repeat. No model test is introduced by this plan.

Deliverable: explained before/after stage evidence, no safety regressions and a
stable fixture. The failed71% observation must be accounted for, not merely vanish
from a later aggregate.

### Step3 current checkpoint — repairs landed, acceptance not cleared

User requested **one agent on the original regression while the parent does step3**.
T3 capabilities selected the actual parent provider/model/options: Codex,
`gpt-6.1-sol`, high/default. The read-only research task completed and its terminal
result was acknowledged. It found that warmup consumes the32-detail/minute budget,
so earlier short blocks did not test later detail/HMAC bursts; it confirmed nine
compiled modules match the frozen archive and refuted per-dispatch timer rearming.
Full report is copied into isolated
`scripts/RESOURCE-OVERHEAD-ORIGINAL-REGRESSION-20261021.md`. Task ID:
`node:delegated-task:command%3Amcp%3Ab263ab35-7f5e-4c2c-9dc8-88a96623ffdc%3Adelegate-task%3Aoriginal-resource-regression-investigation-parent-v1-20261021`.
No experiment, source edit, model or service action was delegated.

Parent commit `95c7210` fixes exact-query freshness using checkoutLatest and a
cross-handle distinct-vector sentinel, warms incremental inserts, verifies native
IDs/vectors/schema/version/fragment counts/data sizes, and holds one parent/worker
lifetime through counterbalanced blocks. Guarded transitions/acknowledgements,
warmup, clear and confirmed native close are outside raw cycle timing. Actual
native binary and Node/V8/OpenSSL/OS identities are recorded. Owner boundary
checklist is at `scripts/RESOURCE-OVERHEAD-OWNER-CHECKLIST.md` in the isolated tree.

Its one six-minute controller completed **33blocks/1060cycles in284.251seconds**:
`/private/tmp/gmax-resource-step3-corrective-95c7210-20261021/`. Pooled off/off p95
-1.540%, on/on-18.751%; median absolute p50 bias14.602%, and individual pairs fail
10%. Raw treatment p95+8.700% cannot identify overhead under those failed controls.
The plain/traced on check+21.321% flags possible measurement cost but is itself
small/unstable, not a causal attribution.

The continuous65second block observes **one real periodic tick and32 measured
detail records**. Operation p95/max0.011/0.034ms, ingest0.029/0.044ms, cached
identifier maximum0.262ms. Periodic collection39.930ms includes26.745ms async flush
and0.327ms guard; it falls between measured cycle spans here, so overlap effects
are not cleared. Parent GC maximum0.736ms. Worst117.150ms cycle includes87.791ms
in probe waits,0.083ms operation/ingest spans, no detail append or collect overlap.
This narrows current direct-cost candidates; the older untraced41.935ms difference
still cannot be retrospectively decomposed.

A concrete changed-method hypothesis followed, not an unchanged retry:
`9e60589` removes dense control-window instrumentation, retains raw stage/cycle
wall times and role self CPU, and warms the exact operation wrapper. Its stated
four-minute cap completed **12blocks/720cycles in197.675seconds**:
`/private/tmp/gmax-resource-step3-wall-only-20261021/`. Off/off p95+5.526%, on/on
+1.372%, median absolute p50 bias8.013%; individual controls still exceed10%.
Treatment+18.584% remains unqualified. Native insert p95 is6.406/66.754ms with12
insert samples/arm; stage percentiles are not additive. Removing dense tracing
alone does not settle control precision.

The parent continued source/trace analysis after failure: insert is outside the
tracked search/index wrapper; VectorDB.insertBatch acquires its JS write gate,
opens/validates a table, then invokes SDK add. Automatic maintenance is not started
by constructing this fixture DB. Current commit **`479eb235320573584c418f8ff80af78eef36f740`**
prepares separate gate/ensure/schema/SDK/native-engine spans (with explicit engine
support flag) and restores hooks on cleanup. They have unit and native integration
coverage; **no timed run with the new internal spans has started**. Detailed
checkpoint/results are in isolated `scripts/RESOURCE-OVERHEAD-STEP3-20261021.md`.

Validation:86 focused checks passed before timed work; new additions plus final
three-file harness invocation22checks cover88 distinct checks together with the
unchanged66 resource boundary checks. Type/syntax/format/whitespace checks pass.
One Mac /var→/private/var test-path alias failure was fixed and retained in logs.
All45 measured blocks/1780cycles have matching per-run worker/native state,
visibility proofs, zero model loads/drops/errors/omissions/pending RPCs and empty
queues. Batches total6,213,574bytes (<10MiB), both owned groups absent. Private
`/private/tmp/gmax-resource-step3-proof-20261021.json` binds evidence/commits,
protected settings, unrelated edits and immutable archive preservation. Live ping
`/private/tmp/gmax-resource-step3-live-20261021.json`: ready/active0.26.90/PID10475,
operations open. Product source/Python/version files remain identical to477779b.
No real model, service transition, full qualification, install or publication ran.

**Do not call step3 complete or start step4 acceptance.** Query/warmup/state and
observability repairs are concrete; precision and original-regression acceptance
are not. Next is targeted insert-layer attribution with same-treatment controls,
a stated changed hypothesis and finite budget, using the prepared hooks. Keep raw
end-to-end/cohort evidence, admission policy and thresholds. No selected subset,
probe subtraction, changed percentile or normalization can replace a failing gate.

### 4. Review the complete final candidate and qualify once it is ready

Use one independent reviewer running the parent model with inherited settings.
Supply the exact frozen candidate, all earlier findings/responses, the ownership
matrix, diagnostic evidence and revised fixture. Review includes test validity and
attribution, not only product source. No repeated full package/boundary qualification
while source is still moving. Harness-only changes keep product-source approval
in scope but still require review of the changed qualification method.

Only after the diagnosis/repair/stability evidence and final review pass, run the
full finite qualification:3idle+3active off/on pairs,2minutes per mode,24measured
minutes inside one30minute controller, plus the separate30second off/diagnostic
pair. Retain idleCPU<=0.5%onecore, medianactivep95regression<=3%, raw-pair+/-10%,
retained managed proxy<=16MiB, queue<=2MiB and diagnosticCPUincrement<=1%. Preserve
raw per-stage/cycle evidence so another failure is immediately actionable.
No concurrent builds/reviews/heavy tests or watched-root document edits during
measurement. Use actual production cadence in acceptance, not diagnostic forcing.

If a gate fails, publication remains held and the identified failure returns to
step3 with evidence. Do not finish with only "unreleased/cause unresolved". Never
relax a safety/performance requirement to force completion.

### 5. Deliver and verify the user-visible result

Bind the accepted source, exact tarball, review and all final evidence. Publish,
verify registry bytes, install both existing Node runtimes/plugin scopes and
perform the established graceful handover without restarting/replacing Small just
for metrics. Verify installed off-by-default behaviour, private inspection/export,
explicit bounded capture, stop/expiry and restored saved preference, plus all
protected settings/client/index identity hashes. Use fresh npm approval links or
the exact terminal command if authentication is needed; no agent browser.

Done means the cause is explained and repaired, the fixture distinguishes treatment
from its own variation, the reviewed candidate passes unchanged gates, and the
installed feature is verified. New history stays off by default. Live0.26.90,
Small/GPU/two workers/critical-only and root evaluation/Depot edits are preserved
until the reviewed delivery step. C1/context and C/D remain separately queued.

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

- **Current release: 0.26.92**, source `3b2d52f`, published and registry-byte-verified;
  both existing Node roots and Claude scopes updated, normal handover and installed
  document-readiness acceptance complete. See the final public artifact acceptance.
- A/B storage and session-overhead work is complete, including bounded cleanup,
  protected readers, interrupted-writer recovery and lazy MCP startup.
- G1 trace evidence and G2 graph work limits shipped in 0.26.87/88 and remain in
  the current release. The later host review completed their live activation.
- Ranking correction shipped in 0.26.89; optional isolated Mac Gemma integration
  shipped in 0.26.90. Small remains the default; no model promotion is selected.
- The new resource-history collector did **not** ship. The original performance
  regression and failed controls remain open/deferred, with their evidence intact.
- Native-query latency, watcher-drop causality and long-cycle resource behavior
  retain the limits recorded below. No repeated unchanged production observation
  or claim of permanently flat disk use is part of completion.

## Ordered deliverables

**A/B/G1/G2, ranking, optional Gemma and the document-readiness repair are closed.**
General document search is delivered and the extra consumer-rollout obligation is
retired. The necessity audit at the top identifies one current process-ownership
defect. Linux deployment is separately pending; C1/context is optional and
resource-history recovery is deferred.
The remaining-work table at the top is authoritative; the original contracts and
dated acceptance records below are retained for reference, not instructions to
repeat completed checks or select a consumer again from scratch.

Root owns integration and delivery. GitHub Actions remains disabled; explicit local
qualification/publication is the selected path. Future automation or trusted-
publisher reconfiguration requires its own selected change. Preserve settings,
sessions, host protection and the Small model/index identity.

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

### CI and release requirements review — completed for 0.26.87

The requested review was completed during G1 delivery below. The earlier zero
GitHub CI direction explains the disabled configuration; the selected current path
is explicit local qualification/publication. Release-only CI remains an optional
future change. Trusted publishing was reviewed without changing credentials or
publisher settings; the permanent automation architecture remains unselected.

The review covered triggers, checks, runner/provider choices, artifact builds,
publication/installation, push speed, duplicate work, local/Depot execution,
Linux/macOS coverage, the incoming build box and npm OIDC workflow identity. The preserved `release.yml` has `id-token: write` and npm OIDC publishing;
its move plus repository Actions disablement stopped that path from running.
Do not change credentials or publisher settings to make the review easier.

No future CI architecture has been approved. Do not restore old automation, delete
preserved YAML or add push/PR jobs without a selected change. The review no longer
blocks C; C still requires selection of its consumer and authority contract.

#### Selected G1 release path — October 19

The user authorized completing the review, artifact qualification, publication and
installation. For 0.26.87 use the existing explicit local release path. Actions
was verified disabled through the GitHub API; all six archived workflows remain
unchanged. This resolves the path for G1 without selecting a permanent automation
architecture or restoring routine push/PR jobs.

| Concern | Reviewed evidence and selected treatment |
| --- | --- |
| Triggers/push speed | Archived CI runs Linux plus macOS on main pushes and PRs, while release tags invoke native/consumer work again. Keep routine pushes free of hosted jobs for G1; publish explicitly after acceptance. |
| Duplicate checks/minutes | Reuse the hash-bound 182-test G1 source acceptance and type/lint results. Run fresh dependency audits, clean compilation, allowlist audit, standalone packed-consumer gates and packaged/installed G1 checks. No repeated source suite or native rebuild solely for a tag. |
| Native/Linux/macOS | Installed 0.26.86 carries accepted darwin-arm64/linux-x64 binaries with matching native-source digest and execution/fault proofs. The checkout's ignored older artifact directory does not match and is excluded. Validate/reuse the installed assets; this Mac cannot provide a new Linux execution result. |
| Depot/build box | No configured Depot release provider or commissioned Linux P3 is available. Neither becomes an implicit publishing dependency. Their integration belongs to separately selected work. |
| Trusted publishing | The archived release workflow expects GitHub owner/repo reowens/grepmax, workflow release.yml, id-token permission and a hosted Linux publish runner. It is inactive. npm whoami confirms reoiv after user web login; trusted-publisher inventory itself requests extra MFA, so its actual settings remain unverified and unchanged. Current publication uses user authentication. |
| Provenance/artifact | Commit only owned source/tests, public README and version files; exclude Depot edits and in-progress private plans. Compile/pack in a clean detached checkout. Publish the exact accepted tarball, record source SHA and checksums, and verify registry byte identity. Manual local checksums are not npm/Sigstore build provenance. |
| Install/rollback | Install that registry artifact into the existing NVM and Homebrew prefixes, refresh existing plugin scopes and verify file identity plus real installed trace behavior in isolated fixtures. Preserve settings, existing sessions and the host stop; the release hook skips daemon handover while quarantine is active. Retain previous artifact/assets for rollback. |

The official [npm trusted-publisher documentation](https://docs.npmjs.com/trusted-publishers/)
currently supports hosted GitHub/GitLab/CircleCI publishers, not self-hosted runners.
The [provenance documentation](https://docs.npmjs.com/generating-provenance-statements/)
also requires a supported cloud build environment. A local Linux box can perform
checks/builds but cannot simply impersonate that OIDC identity. A future optional
release-only workflow needs explicit runner/workflow identity and artifact/provenance
design; restoring the archived omnibus workflow would duplicate accepted work.

Release qualification found a fresh Python audit blocker: aiohttp 3.14.3 is affected
by GHSA-2g87-pp6c-29x5, GHSA-494j-54xm-rwp3 and GHSA-5wr8-gcqf-gqf3, whose patch is
3.14.4 ([maintainer release](https://github.com/aio-libs/aiohttp/releases/tag/v3.14.4)). Raise the existing advisory floor and refresh only aiohttp plus its required
yarl>=1.25.1 dependency. The updated 69-package MLX lock and 15-package maintenance
lock audit clean. Four HTTP contract checks pass in a fresh locked environment
without lifespan/model loads; four audit-gate tests pass. JavaScript audit has no
findings. Source commits: 1508cf9 (G1/version/docs) and b85d60f (Python security patch).

The final b85d60f artifact is `grepmax-0.26.87.tgz`, 315 allowlisted files,
SHA-256 `6d332a2abd7656d4ee9e49e7c0a01edc07c5b345479fdfbb5280ac3f39918497`.
Standalone consumer audit, document boundary, daemon/standalone native watcher
recovery, native session/containment, prune and bounded cleanup acceptance all
passed. Real packaged G1 trace checks passed for nested candidate ancestry, exact
producer spelling omissions, public spans/schema, legacy unknown metadata and
actual CLI agent output, without model/daemon startup. The watcher fixture first
used fresh-home strict defaults and paused on warning pressure; rerunning under
the user's selected critical-only policy passed without changing production policy
or clearing the real stop. The rejected pre-audit tarball is retained separately.
Evidence: `/private/tmp/gmax-g1-release-0.26.87/`; `SOURCE-ARTIFACT.json` binds source,
checks and accepted artifact, while rollback 0.26.86 is retained in `rollback/`.

#### G1 publication and installed acceptance — October 19

[0.26.87 is published](https://github.com/reowens/grepmax/releases/tag/v0.26.87)
from clean source commit `b85d60f47993ec9a804f5dd02698f66a4c549c72` and annotated
public tag `v0.26.87`. npm latest resolves to 0.26.87. The downloaded registry
archive matches the accepted tarball's SHA-256 and SHA-512 integrity exactly.
Public release assets contain `SOURCE-ARTIFACT.json` and `SHA256SUMS`; the registry
omits gitHead, so this is explicit source/checksum binding, not build provenance.

Both existing NVM Node 22.23.1 and Homebrew Node 26.8.1 installations report
0.26.87. All 315 packaged files in each installation match the registry archive.
Both existing Claude user/project scopes point to 0.26.87; all 15 plugin files
match. Actual installed graph/CLI checks pass on both Node versions using isolated
temporary stores: nested candidate ancestry, producer omissions, public spans/schema,
legacy unknown metadata and the agent evidence summary. No model or live index was
loaded. Settings, host-stop hashes and both unrelated Depot file hashes remain
unchanged; existing client sessions were preserved.

The live daemon remains ready on 0.26.86 under the existing host quarantine. No
handover, marker removal or forced session restart occurred. G1 publication and
installed acceptance are complete; live activation is explicitly deferred until
host policy permits a separately selected handover. This does not close C/D or
implement G2 hard bounds/context composition.

Private evidence is `/private/tmp/gmax-g1-release-0.26.87/`, including
`registry-metadata.json`, registry tarball, `installed-identity.json`,
`installed-nvm-trace.json`, `installed-homebrew-trace.json`, plugin inventories and
preserved-settings hashes. The prior 0.26.86 artifact/assets remain available for
rollback. The clean release worktree is retained for reproducible inspection.

### C. Complete one document-search consumer rollout

**General document search is delivered; the extra rollout obligation is retired.**
The product searches indexed Markdown in registered projects. The 0.26.92 native
connection/helper fixes are delivered. A test sample's ignored documents do not
make the feature incomplete. No repo-specific helper, changed ignore rules, 3/3
sample target or unspecified external integration is required. A future actual
consumer need can be selected on its own merits. Preserve source-pointer/freshness
and explicit unavailable contracts already shipped.

### D. Commission the Linux P3 and qualify optional GPU acceleration

**Requested deployment work; CPU installation and acceptance selected October 23.**
This is not a necessary Mac product repair and no longer waits for C. The user
requested this milestone on October 19. The supplied MPN 30J5005MUS specifies no discrete GPU and
a 330 W adapter; actual open-box contents need inspection. Plan for an optional
add-in NVIDIA card rather than assuming an original card was removed.
The detailed phases, contracts and acceptance gates are in
[Linux GPU Support and P3 Ultra G2 Commissioning](../linux-gpu-p3-design.md).

1. Confirm actual machine/OS/RAM/storage/GPU configuration and validate the shipped
   Linux CPU path in temporary stores. Freeze representative workload baselines
   for indexing, query latency, freshness and resources; separate inference from
   storage/native-query cost.
2. If no NVIDIA GPU is installed, retain CPU service. Confirm exact upgrade
   constraints and demonstrate a useful acceleration target before recommending
   hardware. Buying a card requires a separate user decision. An available test
   GPU may qualify software but cannot establish final P3 acceptance.
   October 19 hardware research, following the user's maximum-capability preference,
   recommends RTX PRO 4000 Blackwell **SFF Edition** 24 GB and single x16 riser
   **5C51D95675** if absent. Lenovo's updated power matrix supports one with the
   65 W 285 and 330 W adapter. Tustin advertised $2,999.99; the researched riser
   was $59.99. Verify actual open-box mounting/adapter before ordering. See the
   supporting design for priced alternatives and stale-listing corrections.
3. Spike native ONNX Runtime CUDA on Linux x64 with the exact Granite/ColBERT
   graphs. Qualify driver/runtime assets and actual operator placement. Registering
   CUDA alone is not evidence of GPU execution or speedup. Record proceed/defer.
4. Implement explicit provider selection, compatibility-qualified CPU fallback,
   a single shared GPU owner, bounded queue/host/VRAM use, fair query/indexing
   service, cancellation and crash recovery. Preserve CPU/MLX preferences and
   model-generation correctness. GPU inference remains optional.
5. Run fixed correctness, failure, packed-consumer and real-device performance
   acceptance. Target at least 2x accelerated-model throughput and 1.5x end-to-end
   indexing versus the same P3 CPU baseline, with interactive p95 within 10% of
   baseline under indexing. Freeze absolute resource budgets before integration.
   Unmet gates require an explicit scope/defer decision, not a passing label.
6. Deliver one accepted artifact through the selected release process, install on
   the P3 and verify actual backend/status and rollback. Hardware absence leaves
   CUDA deferred/awaiting; CPU commissioning can close separately.

**Completion:** Linux CPU commissioning has accepted installed evidence; any GPU
support claimed as delivered has real NVIDIA execution, qualified model/index
compatibility, bounded resource/failure behavior and accepted P3 performance.
Planning, mocks or another host's speedup do not close P3 GPU delivery. The current
Mac's settings/host containment stay unchanged; no GPU or model startup is part of
this planning task.

## Improvement implementation brief — October 19 agent review

The user approved three parallel source/design reviews: graph evidence and
identity, composed context, and independent evaluation. All three completed;
root reconciled their findings below. This is a bounded implementation brief,
not another execution queue or approval to begin runtime implementation. The later
user instructions selected G1 for preparation and then three-agent implementation;
G1/G2 delivery and their later live activation are complete. The gaps below are
observations from the October 19 reviewed source, not a current unimplemented-task
list. C is now partial on 0.26.92; D follows C; C1/C2 remain separate candidates. Reviewed source:
`5e590adc07c1a5e993997977522794725027267e` (0.26.86). Pinned comparison sources and
license cautions are in the [related-project review](../2026-10-19-graphify-related-projects.md).
No source changes, tests, benchmarks, index writes or daemon/model operations
were performed during this review. Proposed gains remain unmeasured.

### Verified gaps and existing behavior

- `EXTRACTED` describes legacy indexed reference evidence, not binding resolution
  or necessarily call syntax. `instanceof T` and `ErrorCodes.VALUE` can enter the
  reference column (`src/lib/index/chunker.ts:923,949`), then receive a free-call
  label (`src/lib/graph/graph-builder.ts:643-652`). Mixed free/member references
  also lose occurrence distinctions; builtin suppression can drop a real inbound
  free call (`graph-builder.ts:165,644`). Source-chunk locations are not callsites.
- Definitions and paths use bare-name selection/identity. Same-file/family
  preference is a heuristic; a located candidate is not a resolved target
  (`graph-builder.ts:255,325,435`; `src/lib/graph/graph-traversal.ts:28,66`).
- Producer caps precede renderer omission counts. For example, trace takes 15
  callee spellings before MCP computes `omittedCallees`, so the latter can be zero
  despite upstream omissions (`graph-builder.ts:274`; `src/lib/output/mcp-results.ts:191`).
  A cap hit without a probe cannot establish an exact omitted count.
- Traversal checks the visited limit before consuming an entire neighbor batch,
  allowing overshoot (`graph-traversal.ts:34,73`). Its budget-10 test permits 50
  results (`tests/graph-traversal.test.ts:48`). Reporting a cap does not enforce it.
- CLI context already composes entry points, bodies, skeletons and related files;
  MCP has a separate composer that stops at the first oversized body. Their
  rerank settings differ today, and headings/footer escape some budget accounting
  (`src/commands/context.ts:227,287,334,438`; `src/commands/mcp.ts:3187,3211,3230`).
- Test discovery includes sibling/file candidates and reference/text fallbacks;
  it does not prove executed coverage (`src/lib/graph/impact.ts:138,235,247`).
  Existing graph/relevance gauges do not grade exact binding or all answer facts.

Free/member/type distinctions, seed weighting, density-aware budget packing,
bounded traversal primitives and structured trace output already exist. Improve
their contracts and demonstrated gaps rather than recreating these features.

### Recommended implementation sequence

1. **G1 — Trace evidence and coverage contract.** Add optional, versioned evidence
   and coverage metadata through `graph-builder.ts`, daemon trace types/handler,
   `mcp-results.ts` and affected trace presentation. Preserve existing public fields
   and ranking. Separate indexed spelling, source chunk, candidate definition and
   actual selection basis; report binding as unestablished. Callsite and generation
   are unavailable unless actually supplied. Preserve ambiguity and distinguish
   unknown omissions from exact renderer counts/lower bounds. Legacy omission
   fields do not establish producer completeness; old-daemon metadata absence is
   unknown. Safe bounded N+1 probes can establish cap hits without full counting.
   This patch has no store schema/reindex migration or new binding resolver.
2. **G2 — Enforce graph work bounds.** Before adding context graph expansion,
   enforce node/queue/expansion limits while consuming batches and propagate
   partial reasons. Define visited, examined-edge, fetched-row and query budgets
   separately; a returned-node limit alone is not a memory/work ceiling. Distinguish
   exhausted search from hop/node/deadline-limited results. Exact scoped endpoint
   and occurrence-level identity need a separate producer design; G1 does not
   repair binding or authorize an end-to-end identity rewrite.
3. **C1 — Shared context composer, fixed retrieval.** Extract a request-local pure
   composer/rendering helper used by CLI and MCP. Adapters retain their existing
   search options, ordered candidates, containment and path-mode no-search behavior.
   Deduplicate exact source spans, preserve homonyms/excerpts, and choose one
   body/signature/pointer representation per card. Skip oversized upgrades so
   smaller useful candidates can fit; keep `atLeastOne:false`. Budget the complete
   result, including labels, headings, footer and any structured payload. Declare
   the existing `ceil(chars/4)` estimate rather than claiming an exact token cap.
   Do not duplicate bodies across MCP text/structured fields; specify transport
   framing exclusions. Define tiny/nonfinite budgets and a minimal-envelope failure.
   Relationships/tests/rationale initially say `not_requested`; no new graph walk,
   test scan, document query, ranking change or hidden retrieval fanout belongs here.
4. **C2 — Evidence enrichment, conditional.** Add bounded paths only after producer
   contracts preserve scoped endpoints, edge evidence, ambiguity and hard limits.
   Preserve test-discovery method/target and sibling/text-fallback uncertainty.
   Rationale requires explicit source/link evidence and document status, not
   co-occurrence. Use section states `not_requested`, `complete`, `partial`,
   `unavailable`; complete means the requested bounded operation completed, not
   repository-wide coverage. Canonical symbol resolution and explicit document-link
   extraction remain later candidates with their own measured failure cases.

### G2 implementation and qualification — October 19

The user selected G2 after G1 delivery. One owner implemented and reviewed the
trace caller tree plus neighbor/path traversal bounds. Existing graph identities,
ranking and query scopes remain unchanged; context expansion and file-subgraph
aggregation are outside this patch. No new agents or model loads were started.

Each request shares an admission ledger: 500 visited spellings/queued nodes/
retained node occurrences/expansions for trace and neighbors, with the path
primitive retaining its intended 1,000-node ceilings. Separate ceilings cover
10,000 examined edges, 20,000 copied symbol items, 10,000 fetched rows and 1,500
queries, plus a shared 15-second deadline. The seed counts toward visited nodes;
queue counts include current-frontier siblings, and retained occurrences bound
duplicate/homonymous tree rows independently of unique spellings. Rows rejected
by language/policy still consume the row ledger. Native queries use the smaller
per-query window/remaining allowance and remaining deadline. Importer duplicate
scans and local-definition lookup now have bounded traversal windows.

Partial symbol columns are discarded before identity/evidence classification.
No skipped query is relabeled a checked callee absence. Work metadata separates
exhausted traversal, requested hop boundary, resource/query/deadline limits and
target discovery; older producer work coverage is unknown. The optional
`coverage.work` trace field survives CLI/MCP serialization, and neighbor/path IPC
responses include `work`. Existing multi-hop peek/search/LLM trace consumers retain
the notice. Unchecked neighbor locations no longer read as proven external names.
These are admitted-work ceilings, not native scan-byte/row-width or event-loop
scheduling guarantees. Binding resolution and canonical occurrence identity remain
separate work.

Source qualification: 239 targeted tests across 13 suites passed. After the final
row-admission/timeout refinements, the 60 affected tests across three suites pass;
source and test typechecks pass. Scoped Biome has no errors and the one existing
unrelated optional-chain warning. Native Arrow/store and IPC tests verify shared
row/query limits; fixtures cover wide fanout, duplicate-heavy trees, cycles, exact
caps, independent queue/edge/expansion bounds, deadline checks, path discovery and
legacy/partial output. Source commit: `d89f560`. Clean compiled 0.26.88 G2/native/
CLI/schema checks pass. Evidence: `/private/tmp/gmax-g2-release-0.26.88/`.

Release qualification passed for the clean 316-file 0.26.88 artifact. SHA-256:
`14f5a435a354976f8e16d5a5991e5f906bb30680bc0548436d20ef2d7a97bdb8`.
The first packed watcher run failed its retained-subscription assertion.
Watcher/store modules are byte-identical to 0.26.87; an instrumented diagnostic
passed the original daemon/standalone assertions. All 316 packed files match that
diagnostic build. The failed record is retained; the intermittent cause remains
unproven. Resumed consumer acceptance passed native runtime/session containment,
prune, bounded cleanup and actual G2/native/CLI/schema checks. JavaScript consumer
audit has zero findings; unchanged Python lock/native acceptance evidence is reused.
Source main and annotated tag v0.26.88 are pushed; the
[GitHub release is public](https://github.com/reowens/grepmax/releases/tag/v0.26.88).
npm publication completed after user browser/MFA verification. Registry metadata
and tarball visibility propagated separately; downloaded bytes match both accepted
SHA-256 and SHA-512 integrity, and latest is 0.26.88. The registry omits gitHead;
public source/checksum assets bind the artifact without claiming build provenance.

Both existing NVM Node 22.23.1 and Homebrew Node 26.8.1 installations report
0.26.88 and pass actual G2/native/CLI/schema fixtures. All 316 package files per
runtime match the downloaded registry archive. Existing Claude user/project scopes
are updated to 0.26.88; all 15 plugin files match. Settings/host-stop hashes and
both unrelated Depot file hashes are unchanged. Existing sessions were preserved.
The live daemon still responds ready on 0.26.86 under quarantine; live G1/G2
activation remains explicitly deferred. No marker was cleared and no forced
handover occurred. G2 publication and installed acceptance are complete; C1/C2
context work and C/D are not started by this closeout.

Private proof includes `source-verification.json`, `registry-metadata.json`,
`registry-dist-tags.json`, registry tarball, `installed-identity.json`, both
installed trace reports, watcher failure/diagnostic/resumed consumer logs and
`SOURCE-ARTIFACT.json`. The accepted 0.26.87 rollback archive remains available.

### Host stop review and live activation — October 19

The user questioned the reported quarantine and clarified that owned packages
should be exempt. Review confirmed two separate mechanisms: Hetchy Developer's
`critical-only` exemption forbids its automatic Gmax worker cuts/restores/restarts;
Gmax itself owns critical-pressure protection. The stop was Gmax's persistent
`~/.gmax/safety-stop.json`, written October 14 at 16:24:45 UTC after known critical
memory pressure. It was not a macOS Gatekeeper/XProtect package quarantine. The
build-only XProtect exemption has its own scope and was not changed here.

Fresh probes showed memory normal and kernel warning, permitted by the existing
`hostGuardPolicy: critical-only`. No explicit autostart-disabled marker or environment
stop was present. Under the user's clarification and after review, the exact old
stop bytes were archived in `~/.gmax/safety-history/`; fresh/concurrently changed
records would have aborted the operation. Config hashes remained unchanged.
Critical protection stays enabled and may latch again on a new critical reading;
this was recovery from a reviewed old stop, not a blanket safety bypass.

`gmax watch restart --json` gracefully stopped PID 48295 through IPC. A successor
was adopted at PID 33308 and confirmed ready on 0.26.88. Status reports one current
worker and configured two-worker threads; small GPU settings remain unchanged.
A live `graph.trace` of GraphBuilder returned G2 work metadata: hop-limited as
requested, 25 visited spellings, 44 retained nodes, 451 fetched rows and 18 queries,
all within their declared ceilings. Current pressure remains memory normal/kernel
warning, and no new safety stop is present. Existing client sessions were not
forcibly restarted. G1/G2 live activation is complete; earlier dated activation
deferrals above are superseded by this review.

Private operational evidence: `/private/tmp/gmax-host-resume-20261019/`, including
review/original stop, archive path, restart result, config hash, post-restart pressure,
ping/status, live trace and `verification.json`. The initial live-trace probe used
an invalid wire field and was rejected without work; it is retained separately.
The corrected target-field request passed. No new package release, source policy
change, global exemption change or manual reindex was required.

### G1 ready specification — selected for implementation preparation

**Outcome:** a trace consumer can distinguish indexed reference spellings and
candidate locations from binding-resolved calls, and can see where producer or
renderer limits prevent a complete enumeration. This is the first patch selected
by the user after the three-agent review. The subsequent instruction explicitly
authorizes implementation by three agents with separate file ownership. Root owns
integration and central verification; producer, transport/output and fixture/review
agents have completed. Three initial characterization fixtures passed on the unchanged
graph builder before producer edits. The dated source acceptance below was followed
by publication and installed delivery in 0.26.87, as recorded above.

**Scope:** `graph.trace` / `trace_calls` / CLI `trace`, including inbound/raw/agent
presentation. Preserve graph membership, order, existing query limits, confidence
and resolution fields, tool names, current line conventions and error behavior.
The new metadata has one-based public spans; conversion happens exactly once at
the serializer boundary. A source chunk is neither a canonical symbol identity nor
an exact callsite. Do not repair mixed-reference suppression, resolve aliases,
alter extraction/ranking, add traversals, enforce G2 limits, or migrate/reindex the
store in G1. Those defects remain recorded and must not be reported as fixed.

#### Contract and compatibility decisions

- Keep MCP `schemaVersion: 1`. Add optional `evidenceVersion: 1`, node edge evidence,
  center-selection evidence and top-level coverage. Supporting TypeScript types
  and aggregation helpers belong in a small `src/lib/graph/trace-evidence.ts` module;
  MCP validation mirrors the wire contract. Existing fields retain their meaning.
- An edge's evidence contains `referenceSpelling`, `referenceColumns`,
  `sourceChunk`, `targetCandidate`, `selectionBasis`, `callsite: null` and
  `bindingResolved: false`. Source/candidate locations are nullable chunk spans;
  missing end lines stay null. `referenceColumns` records the matching existing
  index columns, including simultaneous reference/member/type membership; it is
  not an occurrence count or a parser-proven reference kind. Unknown column
  evidence is null, not an empty array implying a checked absence.
- `selectionBasis` distinguishes `first_definition_match`, `same_file`,
  `same_language_family`, `first_candidate`, `caller_chunk_attribution`,
  `receiver_unresolved`, `no_candidate` and `unknown`. Center-selection evidence
  records the initial first-match choice separately. An inbound edge uses the
  caller chunk as source and the particular parent/center candidate as target;
  an outbound edge uses the center chunk as source and the selected callee as
  candidate. Thread this context through recursion instead of reconstructing it
  from a bare-name lookup in the renderer. Importers remain text-based candidates.
- Retain legacy `free/member/type` and `EXTRACTED/INFERRED` values for compatibility.
  Their schema descriptions and a single trace-level note explain that they do not
  prove a call occurrence or target binding. Do not synthesize exact callsites from
  `findCallSiteSnippet`: it reads the current working tree and is display evidence.
  Source/index generation remains unknown unless supplied by a real producer.
- Coverage has version 1, nullable `requestedDepth`, actual `effectiveDepth`,
  indexed-scope/depth semantics and fixed stage summaries. Capture a valid requested
  depth before adapter/daemon clamping using an optional wire field; missing legacy
  information stays null. Preserve existing depth normalization and limits.
- Stage names are `center_candidates`, `caller_rows`, `callee_spellings`,
  `callee_candidates`, `importer_files`, `caller_expansion`, `display_callees`,
  `display_importers` and `display_callers`. Each summary records its status
  (`complete`, `partial`, `unknown`), operation count, observed/retained counts,
  applicable limit, number of limited operations, reason codes and omitted count
  as `{ exact: number | null, lowerBound: number }`. Caller/candidate query-row
  observations are not unique symbols/files. `importer_files` observes/retains
  unique files because its stream stops at 100 unique files; optional `duplicateRows`
  separately counts duplicate stream rows. Spellings/display stages use their
  named units. Never add overlapping stage omissions into a total.
  Metadata remains constant-size per stage, not an unbounded per-query log.
- Existing query limits stay unchanged in this first patch. A 100-row caller query,
  25-candidate lookup, first-match center lookup or importer stream stopped at 100
  cannot prove unseen totals: mark the relevant coverage unknown. Under-limit
  exhaustion is complete only for that bounded indexed operation. A known omitted
  spelling/display slice is partial with an exact count. Filtered/suppressed rows
  are policy decisions and are counted separately from cap omissions. First-match
  candidate uncertainty must not be confused with caller enumeration completeness.
  N+1 probes are deferred; G1 adds no queries or wider query limits.
- Requested depth is the boundary of the operation, not repository-wide completeness.
  Record name-based visited pruning and the advisory expansion-stop reason when
  observed. G1 makes no hard work-bound or complete-path claim. Timeout, busy,
  cancellation and host refusals keep their existing error/fail-closed paths.
- `omittedCallees` and `omittedImporters` remain renderer-only legacy counters.
  New coverage is authoritative for producer truncation. An old daemon's absent
  metadata normalizes to unknown, never complete; it does not trigger a retry,
  local store opener, reindex or forced daemon restart. New-daemon/old-client use
  continues to work through optional additive properties.
- Human/MCP text gets one concise static-reference/coverage note. Compact trace
  keeps existing data columns and ordering and adds a reserved `# evidence` summary
  line; verify consumers/tests tolerate that prefix. Inbound display limits retain
  the existing dedupe/early-stop policy. If the remainder cannot be deduped without
  extra snippet reads, report unknown omissions rather than doing extra filesystem
  work just to count them. Raw mode retains self/repeated rows.
  Existing empty/not-found responses continue to satisfy the success schema.

#### File ownership and implementation order

1. **Characterize:** extend `tests/graph-builder.test.ts` with bounded mocks that
   respect selected columns and limits; capture current selected nodes/order and
   query count/limits before changing production code. Add a focused
   `tests/trace-evidence.test.ts` for aggregation and serialization invariants.
2. **Types and producers:** add `trace-evidence.ts`; attach optional edge metadata
   to `GraphNode` and optional coverage to trace results. Thread a request-local
   collector explicitly through `buildGraphMultiHop`, `buildGraph`, `getCallers`,
   `getImporters` and `expandCallers` only when trace requests it. Add existing
   `end_line`/reference columns to projections where necessary; no content reread
   or new query. Do not keep mutable collector state on a shared builder. Standalone
   helper/peek/dead/impact callers retain their existing behavior and signatures via
   optional internal parameters or delegating wrappers.
3. **Transport:** update `GraphTraceResult`, `runGraphTrace` and the `graph.trace`
   dispatch in `src/lib/daemon/graph-handler.ts`. Preserve metadata through daemon
   IPC and in-process fallback. Requested-depth propagation may touch CLI/MCP
   payload construction; it does not change admission, cancellation or store access.
4. **Output:** update `src/lib/output/mcp-results.ts` schema and trace serializer;
   share the concise note helper between `src/commands/trace.ts`, trace rendering
   in `src/lib/output/formatter.ts`, and `handleTraceCalls` in `src/commands/mcp.ts`.
   Normalize legacy metadata once and keep producer/display counters distinct.
5. **Verify and review:** extend `tests/graph-handler.test.ts`,
   `tests/ipc-graph-verbs.test.ts`, `tests/mcp-read-verbs.test.ts` and
   `tests/trace-command.test.ts` at their real boundaries. Reuse identifier-as-value
   and type/member extraction fixtures without changing chunker behavior. One
   independent reviewer checks binding claims, counter semantics, compatibility
   and accidental graph/query changes before integration. The native IPC fixture
   currently lacks the `./isolated-host-policy` import used by graph-handler tests;
   add that isolation before executing it. That isolation is now implemented and
   native fixture acceptance passed. Further agents require explicit assignment.

#### G1 acceptance and execution recipe

- TS/Python fixture controls: module homonyms, aliases, shadowing, same-name members,
  mixed reference columns, type-only/value references, repeated chunks and nested
  caller parents. They must retain current candidate behavior while every target
  stays binding-unestablished. Do not assert new resolution/recall improvements.
- Cap boundaries: caller rows 99/100/101; callee spellings 14/15/16; candidate rows
  24/25/26; importer files 99/100/101 plus duplicate rows; display importers 9/10/11.
  Exactly-at-cap and over-cap inputs with identical observed prefixes both remain
  unknown when enumeration was not exhausted. Callee spelling omissions remain
  exact. Test language filtering before/after the caller cap and suppression
  without relabeling those exclusions as unseen rows.
- Exercise requested/effective depths, recursion/name-visited suppression,
  advisory expansion stop, nested parent targets, inbound display truncation,
  raw self-edges and absent center. All fields must survive JSON/IPC and schema
  validation; local and daemon evidence must agree after line conversion.
- Test old-daemon/no-metadata success, unknown coverage and no fallback/retry;
  existing refused/busy/timeout paths must not become partial success. Compare
  old public fields and graph membership after stripping new metadata/summary.
- Run focused non-store suites first, with `pnpm exec vitest run --maxWorkers=2`
  and explicit files: graph-builder, trace-evidence, trace-command, mcp-read-verbs,
  and the touched extraction-control suites. Native graph-handler/IPC fixtures run
  separately on temporary stores with isolated host policy and at most one worker,
  only while host safety permits; never clear an operator stop to obtain a pass.
  The inspected setup mocks worker/resource behavior, and global setup calls
  `ensureGrammars`, which downloads missing grammars. Preparation confirmed Node
  v22.23.1, pnpm and node_modules are present, and all 17 declared grammar files
  are cached (including TS/TSX/Python). Recheck cache presence before tests; a
  missing cache is not permission to download/install as an incidental test step.
  No live index/model is needed. This is readiness evidence, not a passing test.
  G1 does not use the 30-task utility experiment as its acceptance gate.
- Then run `pnpm typecheck`, `pnpm run test:typecheck` and Biome checks on touched
  TypeScript files. Stop/rework on regression; repeat only affected checks after a
  fix. CI/release review selects required broader/publishing checks before shipping;
  planning or source fixtures alone do not establish installed delivery.
- **Ready-to-integrate:** focused checks pass, reviewer objections are resolved,
  no guessed binding/callsite claims, unknown/exact omission semantics are correct,
  old/new transports are compatible, and no new queries/schema migration occurred.
  **Delivered:** additionally accepted artifact publication/install and installed
  trace behavior are verified through the selected release process. Restore the
  accepted prior artifact on delivery failure; no data migration needs rollback.

#### G1 source acceptance — October 19, 21:18 UTC

The approved three-agent implementation is integrated in the working checkout on
base `5e590adc07c1a5e993997977522794725027267e`. Producer metadata, daemon transport,
MCP schema/serialization, CLI/human/agent/inbound notes and focused fixtures are
implemented. Independent review has no remaining blockers. Root corrected actual
candidate-retention counts, unknown advisory omissions and its limit/stop counters;
inbound rendering preserves its old early-stop/read boundary. Importer stages use
unique-file counts with separate duplicate rows. G2/context remain outside G1.

Central verification:

- Before producer edits, 3 legacy characterization tests passed with GraphBuilder
  hash `cbcdd24d799ff3b01f40b0dff5b98a2c7f907409`.
- Latest affected run: 119 tests passed across graph-builder, trace-evidence,
  trace-command and mcp-read-verbs. The first run exposed a missing cap value in
  text, an outdated wording assertion and an ESM spy issue; all were corrected.
- Extraction controls: 16 tests passed across identifier-as-value, type-position
  and member-call suites. Native temporary-store/IPC checks: 47 tests passed across
  graph-handler and ipc-graph-verbs, one worker with isolated host policy.
  These are **182 distinct targeted tests across nine suites**, not a full suite.
- Source `tsc --noEmit --incremental false` and test `tsc -p tsconfig.tests.json`
  pass. Test fixture inference errors were fixed before acceptance. Scoped Biome
  check passes with no errors and one unchanged optional-chain warning in the
  audit portion of graph-handler. `git diff --check` passes.
- The first `pnpm exec` unexpectedly refreshed existing dependencies and ran local
  install hooks before the baseline. No tracked manifest/lockfile changed. Further
  checks used direct installed binaries, with no repeated installation. All 17
  grammar caches were present. No models, live store operations or CI were run;
  the existing host safety stop was retained. Unrelated Depot file hashes match
  their pre-implementation values.

Verification summary and exact source/test hashes are recorded in
`/private/tmp/gmax-g1-evidence-20261019/verification.json`. This is source acceptance
of the then-uncommitted checkout changes; publication and installed acceptance were
completed subsequently below. Preserve this dated source record rather than
repeating unchanged tests. C/D and separate G2/context work remain undelivered.

### Acceptance and independent evaluation

- Contract fixtures: TS/Python homonyms, shadowing, aliases, unrelated same-name
  members, mixed free/member/type/value references, recursion/diamonds and split
  chunks. Assert zero guessed targets advertised as binding-resolved. Report
  precision, recall and abstention separately; suppressing all edges is not success.
- Exercise each cap at N-1/N/N+1, filtered/duplicate rows consuming caps, giant
  fanout, wide caller siblings and incomplete paths. Assert producer partial states,
  old-daemon unknown states, IPC/local parity and actual work ceilings separately.
- Composer fixtures: identical adapter search arguments/order; complete estimated
  output budget; body deduplication without merging homonyms; oversized first item;
  unreadable/stale spans, tiny budgets and path-mode no-search. A source-backed
  pointer must not be relabeled a complete definition or a fresh binding.
- Proposed consumer experiment: four pinned repositories, at least two languages,
  30 questions (10 development/20 held-out), balanced across flow, impact, tests,
  rationale and ambiguous/negative cases. Split by scenario/module, not paraphrase.
  Questions and essential facts/spans are **not yet frozen**. Seal held-out truth
  before implementation; inspected cases are development/control evidence.
- Compare against the competent current context/search plus normal follow-ups.
  Replay identical seeds and effective settings first, then paired end-to-end runs.
  Freeze consumer model/instructions and total output allowance. Count complete
  serialized output, external calls, internal store/read/graph operations, latency,
  memory and failures. Grade all essential facts and unsupported claims, not any
  overlapping search hit. Separate graph/test/rationale ablations from packaging.
- Proposed utility gate: at least 20% fewer consumer calls, no graded fact-coverage
  loss and no new unsupported relationship/coverage claims. Predeclare latency and
  resource ceilings before measurement; evaluator suggested p95 tool time <=1.25x
  baseline as a screening ceiling, not an accepted SLO. Publish paired samples and
  uncertainty. Budget breaches, undisclosed partial results and stale attribution
  reject a candidate. Host pressure/stale indexes invalidate samples; they do not
  authorize rebuilding or relaxing containment. No performance gate passed here.

Root owns scope selection, integration and release. Future implementation uses one
owner plus independent review, with tests appropriate to the actual change. Current
host limits, client settings, ranking and unrelated Depot edits remain preserved.

## Selected delivery — ranking correction, then optional Gemma

The user selected both next steps in order: deliver the qualified artifact-prior correction on current Granite Small, then integrate Gemma as an optional Mac model. The first release contains only the artifact-preference helper, Searcher application/diagnostics and regression tests, plus normal version files. Evaluation adapter changes, private evidence, existing delivery notes and unrelated Depot edits are preserved separately. A clean isolated checkout is used for release assembly and required checks. Use the established explicit local publication/install path, preserving host protection, settings and sessions. Review concrete owned source before publication; do not restore CI or alter credentials.

Ranking release source is isolated at `.claude/worktrees/ranking-artifact-release-20261021`, commit `4df16f3eda206f1c519bc7422be107640c1ad1c3`, version0.26.89. Exact accepted artifact is `/private/tmp/gmax-ranking-release-0.26.89/grepmax-0.26.89.tgz`, SHA256 `c3e44a9369ae9dfe19eebfa8e2b3726be54f63b1bc9c9023570a4ab5bb55cce3`,317files, with source/checksum binding, review and evaluation-equivalence evidence beside it. Required fresh audit patches are Vite8.3.4, legacy SDK fixture1.32.0, Pillow13.0.0 and certifi2026.10.19; no production MCPv2 dependency change. Independent parent-model reviewer cleared all findings after fixes for ambiguous manual/guide nouns, singular/plural test artifacts and an actual nonoverlapping per-file-cap fixture. All30 frozen preferences are unchanged and the executable Searcher matches the evaluated implementation, so no inference or holdout tuning was needed. Final production source passes2385tests/231files; Python base+4locked HTTP cases, both typechecks/build and packed native watcher/prune/bounded consumer gates pass. Existing Biome3warnings/2infos remain. Source/tag are pushed. After successful login and separate browser publication MFA, npm accepted the package for asynchronous processing. The registry subsequently served the exact reviewed SHA256/SHA512 bytes; the abbreviated install packument includes 0.26.89. A temporarily cached unqualified tarball URL returned 404, so installation used the downloaded, checksum-verified registry archive. Both existing Node 22.23.1 and 26.8.1 installations match all 317 package files and pass the actual packaged ranking fixture without model loads. Both existing Claude user/project scopes match all 15 plugin files at 0.26.89. Graceful version handover produced ready/active daemon 18639 on 0.26.89 with open operations and no rebuild pending; its mapped Lance native binary is from the NVM installation. Config, registry, safety-marker state and three client-settings hashes are unchanged; Small/GPU, two workers and critical-only protection remain. GitHub release v0.26.89 is public with sanitized source binding and checksum assets. Actions remains disabled. Registry/install/live evidence is beside the accepted archive; this first delivery is complete.

Qualification incident: an accidental critical-only environment override on the full source suite let `paused-daemon-startup` take its active branch and discover/kill the real daemon11317 and worker11773 through global process names. User was informed. Restored0.26.88 daemon64818 and Small embedding server65083 with normal/kernel-OK admission and unchanged settings/registry/safety markers; ordinary watcher catchup resumed. The candidate test now explicitly pins strict policy, hides pgrep through both execSync/execFileSync, denies spawn/fork and rejects non-self nonzero signals. Its3cases pass even with inherited critical-only. Production cross-home process discovery remains an existing risk: the optional Gemma path must not launch a secondary daemon; use explicit standalone/in-process paths or separately repair ownership before multi-daemon use. No model/index identity was switched by restoration.

The second delivery makes the evaluated text-only Gemma backend available as an explicit option with generation/model/preprocessing validation, a separate re-embedded index, and a tested return to Small. Production default changes and rewriting the existing Small index are not selected. Bound model work to the qualified Mac text-only path; no generative models or other-host execution. New delegated review work, if needed, uses the parent model and requires the applicable user authorization. Future model startup follows the repository hard-stop rule and any concrete current-session authorization.

### Optional Gemma delivered — October 21

Accepted source is `86042c97948cda0604a2c449a9c451423b6c4e83`, version
**0.26.90**, integrated/pushed on main with tag `v0.26.90`. The clean owned
checkout remains `.claude/worktrees/gemma-option-20261021`. The user completed
publication from their terminal after the expired browser token was abandoned;
npm accepted the request with HTTP202/exit0. Registry processing subsequently
completed and the downloaded official archive exactly matches the reviewed bytes.
Both existing Node installations and Claude plugin scopes are verified. Normal IPC
handover produced ready/active daemon10475 on0.26.90, operations open, no rebuild
pending. Small/GPU, two worker threads, critical-only protection, primary store
registration and client settings are preserved. Small's8100 backend health names
the expected Granite model; Gemma port18100 is closed. The
[GitHub release](https://github.com/reowens/grepmax/releases/tag/v0.26.90) is public
with sanitized source/artifact binding and checksums. GitHub Actions stays disabled.

The candidate adds a text-only BF16 Mac tier, shared checkpoint/tokenizer/prompt/
runtime contract, preserved Granite v1 identities, strict model/dimension/L2
validation and no incompatible ONNX fallback. All eleven artifact files and the
exact directory inventory are bound; extra weights, tokenizer overrides, dense
heads, symlinks and other unpinned loader inputs are rejected before framework
imports. It verifies 413 BF16 text tensors. Both languages compute contract
`9f0d2213d3c8e47fd491984c1312f36293e1e443c0b7021e9c7b1d880603a95f`.
The earlier five-file candidate92b1114/archive82d3328 remains superseded evidence.

Explicit `GMAX_GEMMA_PROFILE=1`, separate `GMAX_HOME`, port and re-embedded index
are required. The pinned model cannot be aliased into another tier. Profile
startup is disabled before discovery/IPC/spawn/listeners even with incomplete
configuration; explicit quarantine and machine stops still block work/mutations.
Dense inputs receive the qualified title/query prompts; ColBERT input is unchanged
and content-only vector reuse is declined. Separate Python project/lock preserves
Granite's environment. Packaged instructions specify `MLX_EMBED_MODEL` and rollback
in `mlx-embed-server/gemma/README.md`. No secondary daemon, generative model, other
host, default switch or rewrite of the primary Small index is selected.

Independent review used one explicitly authorized agent inheriting the parent
model. Initial changes requested: unpinned loader inputs, omitted model export,
inadequate independent deadline/descendant cleanup, and a final ping routed to
an isolated home. These were corrected before model startup. The supervisor owns
model/controller sessions directly; it retains child identities until cleanup,
checks budgets independently of Node/native work, stops the model first, reserves
30 seconds for cleanup and has bounded fallback signaling when probes fail.
Model-free normal/count-breach/probe-failure/exited-leader tests passed. Source
and exact harness approval is recorded in
`/private/tmp/gmax-gemma-option-review-20261021-v2.md`.

Qualification:2,408 source tests/236 files before review fixes;30 focused cases
pass after fixes, both typechecks/build pass and formatting remains accepted.
Both locked Python environments pass50 cases with8 optional skips; all eleven
qualified artifact digests validate without model imports. JS audit and registry
Python audits (69 Granite/15 maintenance/58 Gemma packages) are clean; Git pins
remain outside registry audit. Qualified unchanged native assets were reused.
Packed consumer/document/native watcher/prune/bounded gates pass. Synthetic
packaged CLI config/add/index/code/docs/contract-refusal/return-to-Small acceptance
passes; all30 frozen intent routes match without holdout inference or retuning.
All324 consumer files exactly match archive SHA256
`722e5ebe0cc38a5ca5acde9d6be57c80f41c2bc7831b3788cb4e87928e5d8fd5`.
Private binding/check evidence is `/private/tmp/gmax-gemma-candidate-20261021/`.

The user approved a new ten-minute real-backend integration window, separate from
the completed benchmark, ending **06:32:20.470952 UTC**. First attempt loaded and
encoded successfully but failed temporary FTS initialization (9.78 seconds);
its failure is retained. After reviewer-approved fixture/cleanup corrections,
the retry passed in3.50 seconds at06:24:44UTC, inside the same original window.
It used the actual packaged model backend, WorkerOrchestrator,768d VectorDB and
Searcher:3 synthetic files/6 chunks,2 queries and contract-mismatch409 rejection.
FTS was initialized via the packaged SDK only in the exclusively owned tiny
fixture, then adopted. This is model/worker/Searcher acceptance, not proof that
the contained CLI creates FTS indexes or a ten-minute soak.

Peak sampled candidate footprint was0.966GiB; coincident candidate/controller/
supervisor/launcher accounting plus64MiB probe reserve peaked at1.118GiB. Two-second
sampling does not establish an unsampled maximum or OS-enforced cap. Observed swap
growth was zero and all host/disk samples passed the retained6GiB model/2GiB
controller/8.5GiB combined/512MiB growth/20GiB free/16MiB evidence limits. Approved
swap baseline remains3,914,460,037.12 bytes. Owned model/controller descendants were
stopped/reaped and port18100 is no longer listening. Protected primary hashes,
client settings and ready Small daemon18639/live0.26.89 are unchanged.

Passing result:
`/private/tmp/gmax-gemma-candidate-20261021/runtime-integration-1792563880970835000/result.json`.
The failed first result remains in sibling runtime-integration-1792563740470952000.
Root's private evaluation seams were reapplied after integration; other existing
edits were preserved byte-for-byte. A local test mock was adapted to the unpublished
queryFeatures seam;30 local integration/evaluation cases and the test typecheck
pass. That mock adjustment and private seams are not in the accepted release.
Final installation checks verify all324 package files in Node22.23.1 and26.8.1,
all15 plugin files in each existing Claude user/project scope, and actual packaged
ranking behavior in both runtimes. Both also pass installed LMDB read/write,
numkong arithmetic, ONNX import, watcher event and native Lance fixture checks
without model loads. npm script restrictions were retained; no broad script
allowance was added. The serving daemon maps the expected NVM Lance binary.
Private `final-proof.json` and `installed-live.json` beside the archive bind this
acceptance. This optional-model delivery is complete; broader delivery remains open.

## Completed follow-up — trace audit, focused ranking fix and independent holdout

Steps 1–3 are complete. Saved traces identified unconditional test/docs priors conflicting with explicit artifact requests. The focused candidate waives only the matching prior; default priors, candidate retrieval, automatic ColBERT gate, other structural weights and file caps remain unchanged. Synthetic checks and the accepted thirty-question source-only holdout support the correction. Two overlapping topics were replaced before measurement; final review checks both the old holdout and all forty exposed development cases. Complete answer-span coverage in one exact-file chunk is primary; legacy overlap is secondary.

The first admission refusal and original manifests remain preserved in `mac-02`. The user approved a fresh swap baseline in `mac-03`, retaining every other limit and the original deadline. All four paired passes completed in 2.37 minutes: Small baseline/fixed strict Recall@10 is 70.0%/76.7%, MRR 0.281/0.326; Gemma 70.0%/83.3%, MRR 0.289/0.335. Neither fix comparison loses any top-ten hit or MRR. Ordinary code/config question ranks are unchanged. Both repetitions have identical ranks, query vectors and ColBERT features; the sample remains 30 unique questions.

Gemma fixed gains 6.67 Recall points over Small fixed (95% paired query interval [0,16.67]) and 0.00899 MRR ([-0.07312,0.09381]), meeting the fresh gain of at least five points with no MRR loss quality gate. This is a point-estimate pass with uncertainty, fewer first-place answers than Small, and no new Standard comparison. It does not select a migration or release. Peak sampled combined memory 1.70 GiB, zero swap growth and 11.12 GiB total experiment disk stayed within ceilings. All owned model children exited and protected live state matches preflight.

All 83 distinct focused tests and both typechecks passed before measurement; targeted checks pass after the disk-accounting adjustment and report-label corrections. Original reports remain; corrected reports change only the secondary scorer heading and MRR subtotal label, with all numerical outcomes identical. The [evaluation report](../embeddinggemma2-evaluation.md) links the accepted labels, amendment, frozen manifest, raw rankings/query caches, corrected reports and final verification in `embeddinggemma2-ranking-20261021-mac-03`. The candidate ranking fix is ready for separate delivery selection. Deployed Granite Small, live runtime/index, existing delivery handoff and unrelated Depot edits remain unchanged. Future subagents use the parent model per the user's updated instruction.

## Completed Mac evaluation — EmbeddingGemma 2

The user selected the concrete text-only BF16 MLX execution on this Mac. All six
frozen paired passes completed: 12,717 chunks, 30 fresh single-author questions,
six separate probes, Granite Small / Standard / Gemma, two passes each. Original
manifests and labels are unchanged. The [evaluation report](../embeddinggemma2-evaluation.md)
and [final execution manifest](../measurements/embeddinggemma2-eval-20261021-mac-01/execution-manifest-v4.json)
retain methodology, provenance, raw rankings, diagnostics and resource records.

**Recommendation: retain deployed Granite Small.** Dense Recall@10 was
50.0% / 46.7% / 66.7% for Small / Standard / Gemma; full-gmax Recall@10 was
66.7% / 70.0% / 70.0%. Gemma full MRR improved to 0.398 versus 0.315 / 0.282,
but full recall gains of +3.33 points / zero failed the frozen +5-point requirement
over both comparators. Query-bootstrap full-recall intervals were [-10,+16.7]
points versus Small and [-10,+10] versus Standard. Repeats had identical target
ranks and are not 60 independent questions. No repository had two net lost hits;
individual regressions and partial-span scorer caveats remain in the loss review.

The pinned text-only MLX conversion passed the 16-input CPU/FP32 reference check:
identical effective tokens/truncation, minimum cosine 0.9996898 and maximum
component error 0.00285292. Batch 1/8/16 memory gates and Granite old/new-stack
parity passed. Actual private VectorDB/Searcher preserved FTS and the effective
ColBERT gate. Shared feature/rerank extraction and narrow dependency/cache-root
seams were tested; no alternate hand-copied search pipeline was substituted.

Peak sampled candidate footprints were 1.58 / 1.77 / 2.27 GiB; maximum coincident
candidate+runner footprint was 3.25 GiB. Gemma loaded footprint was 1.11 GiB.
The 47.8-minute run and 11.08-GiB experiment stayed within the retained ceilings.
All observed host samples passed, every paired query sample was valid, and all
owned model children exited. Sampling is not an OS-enforced cap; framework import
and load are combined, qualification lacks RSS, and launcher/tool memory is not
part of the reported two-process sum. Full p95 times were 333 / 260 / 420 ms;
Gemma exceeded the agent-selected 1.25 tail-latency ratios. Model-specific stacks,
monitoring overhead and warmed caches limit deployment-speed interpretations.

The current full pipeline sometimes demoted a dense rank-1 answer or removed it
by per-file cap. These are recorded diagnostic outcomes, not permission to tune
against this holdout. Keep the frozen result and source-adjudication limitations.
A later selected task could investigate new development examples and obtain a
broader independently judged holdout. Model promotion, another host, quantization,
longer context, remote inference and index migration remain unselected. C1/context
and C/D keep their separate scope and order. The pending delivery handoff, live
config/service/host protection and unrelated Depot collector edits are preserved.

## Usage statistics audit — October 21

The user requested an audit of CPU time, memory and disk statistics for debugging
over time. This is an assessment and proposed follow-on, not authorization to add
telemetry or change runtime settings as part of the Gemma release.

Existing collection and defaults:

- The daemon already logs a structured resource snapshot every five minutes,
  alongside its footprint/recycle probe, and on selected pause/recycle events.
  It includes physical footprint, RSS, JS heap/external/array-buffer memory,
  Lance cache, workers, queue, active operations and maintenance state.
  `gmax status --json` returns the last cached snapshot, not a historical series.
  The observed live daemon snapshot showed 413 MiB physical footprint versus
  3,208 MiB RSS; these are different measurements and must remain labeled.
- Worker task results/heartbeats report RSS for pool recycling. Selected debug
  paths report task wall time. MLX debug logging can report embedding wall time
  and Metal active/cache allocations. `GMAX_DEBUG`/`GMAX_VERBOSE` are off by default.
- Query logging is off by default and currently off. The CLI toggle is
  `gmax config --query-log on`; entries include elapsed time and may contain query,
  symbol and project text. It is not a process-resource monitor.
- The selected critical-only host policy deliberately omits aggregate process,
  free-memory and swap admission scans. Its null fields are expected. Changing
  that admission policy is not required to improve observability.
- Maintenance receipts record operation-specific elapsed time and read/write/
  reclaimed bytes. CPU user/system time, peak RSS and block-I/O counts exist in
  specialized test/soak wrappers, not routine production collection.
- Runtime logs generally rotate at 5 MiB with one previous file; rotation timing
  differs by producer. There is no unified age-based resource-history retention,
  production CPU-time series, continuous per-role memory series, or ongoing disk
  allocation/growth history for indexes, models, caches, logs and temporary files.

Original recommendations, later implemented in the isolated resource-history
candidate and now deferred pending performance acceptance:

1. A bounded, local resource-history stream, separate from raw query logging.
   Record process role/start identity, package/model profile, cumulative and
   delta user/system CPU time, labeled memory counters, queue/work/error counts
   and operation durations. Each worker/backend must report its own usage so
   short-lived children and Python work are not mistaken for daemon CPU time.
   Define CPU percentages explicitly; retain missing/platform-specific fields
   as unknown rather than substitute RSS for physical footprint or block counts
   for byte counts. Do not sum shared/unified memory into a misleading total.
2. Account for disk growth by category, distinguishing logical from allocated
   bytes. Prefer operation receipts and cached accounting, with bounded periodic
   inventory off the request path. Correlate growth, latency, fallback, recycle
   and restart events using run/operation identifiers. Avoid recursive disk scans
   for each request or status call.
3. Start with inexpensive counters around a 60-second cadence and retain the
   existing five-minute physical-footprint probe. Offer a finite diagnostic mode
   with faster samples, automatic stop and a size ceiling. Establish collector
   overhead before enabling new collection by default; it must not warm models,
   start daemons, trigger indexing or alter host admission.
4. Bound retention by age and bytes, with rollups and an explicit redacted export.
   Suggested design targets are 7–14 days and 50–100 MiB, subject to measured
   overhead. Omit raw query/content/path text from resource metrics by default;
   keep the existing query log a separate opt-in. No remote telemetry selected.

The most useful first implementation is CPU time plus per-role memory and disk
growth history correlated with work/restarts. Enabling verbose logs alone does
not provide it. Audit evidence is private at
`/private/tmp/gmax-observability-status-20261021.json`; no settings were changed.

## Resource history implementation plan — October 21

**Retained specification, not current execution.** The user subsequently authorized
implementation and review, then explicitly deferred the unresolved performance
item. Product source `477779b` is approved; isolated checkpoint `479eb23` and frozen
0.26.91 package are preserved. Overhead acceptance failed and no history release
was cleared. This collector is not included in delivered 0.26.92. The default-off
contract below stands if this work is reopened. Parent-model review and a valid
final qualification are still required; documentation reconciliation starts no
collector, model, experiment, reviewer or publication.

**Outcome:** explain which Gmax process used CPU/memory, which disk category grew,
and what work/restarts coincided with the change, over a bounded local history.
Keep resource statistics separate from query logging, ranking diagnostics and
host admission. This first version is a CLI/local-file feature, not a dashboard,
remote exporter, scheduled observer, model comparison or change to host policy.

### Defaults and controls

- Propose `resourceStats: "on" | "off"` in GlobalConfig, default **off** in
  development and release. An absent setting on upgrade stays off without
  rewriting config. Passing the overhead gate never enables history implicitly;
  it qualifies the feature for users who choose it. Invalid settings report a
  collection error and disable the new collector. Existing five-minute memory
  snapshots and worker recycling counters continue unchanged. Off adds no new
  periodic counters, disk walks, history files or collector timers. Add
  `gmax config --resource-stats on|off`; it changes no model/index identity and
  needs no daemon restart. `GMAX_RESOURCE_STATS=off` is a hard disable for the run,
  including diagnostic capture.
  Do not reinterpret `queryLog`, debug flags or critical-only policy as consent
  to different behavior.
- When history is explicitly enabled: cheap counters every **60 seconds**, existing daemon physical
  footprint every **five minutes**, plus bounded operation/lifecycle events.
  Reuse existing footprint/health results. No default process-table/cohort scan
  or extra worker/backend footprint probes. Never keep an idle worker/model
  alive just to collect a sample.
- Private local storage: `GMAX_HOME/resources/v1/`, directory mode 0700/file mode 0600;
  rotating append-only JSONL with a versioned schema. Retain at most **14 days
  or 100 MiB total**, whichever limit removes data first. The limit includes
  active/rotated files, disk-inventory metadata and captures. Use 5 MiB segments;
  age/byte pruning runs only when the existing writer is active, not in a new
  background service. Expired records are omitted from ordinary reads/exports;
  old files left while collection is off are pruned when the writer resumes or
  explicitly cleared. Report the actual covered interval when the byte ceiling
  shortens retention. Disabling collection preserves stored files for explicit
  inspection/clear; clearing removes only owned history files.
- Diagnostic mode is explicit: **five-second samples for ten minutes**, maximum
  requested duration 30 minutes, maximum capture 25 MiB inside the 100 MiB global cap.
  One capture per home; it returns an ID/deadline immediately, can be stopped,
  and stops automatically on deadline, size/resource limits, collector exit or
  user off. The capture command explicitly enables temporary collection even if
  ongoing history is off, without changing that preference. It returns to the
  previous off/on history mode when it ends. Issuing config off during capture
  cancels it even if the saved setting was already off. Faster self counters and
  owned-backend reports are opt-in; disk walks
  retain the same global budget and physical footprint keeps its five-minute
  cadence. Persist completion/aborted state so a restart does not silently resume
  or extend it. A diagnostic run ending returns to the baseline cadence.
- No raw queries, source text, symbol names, paths, environment values, hostnames
  or credentials in resource records. Use random run/operation IDs and per-home
  keyed project/store identifiers; never export the local key. File categories
  and bounded outcome codes replace paths/free-form error messages. Existing
  query logging remains separately opt-in. No network telemetry or automatic
  export is added.

### Measurements and their limits

Each record carries schema/type, UTC time, process-relative monotonic time,
sequence, run/process-start identity, role, package version, model/generation
profile and a source/sample-quality indicator. PID alone cannot identify a
process; a restart starts a new counter series. Each measurement has units,
sample time/age and known/stale/partial/unsupported/error state. Missing values
stay null with a reason, not zero. Wall-clock changes cannot create negative
CPU rates or reset capture deadlines.

1. **CPU:** self user/system cumulative CPU time and interval deltas for the
   daemon, live workers and owned Python embedding backend. Canonical unit is
   microseconds; CPU percent uses elapsed monotonic time and 100%=one core,
   allowing values above100%. Node/Python adapters validate their source units
   with model-free capability cases. Include thread CPU within each process,
   never recursively count child CPU again in the parent total. Capture a final
   report on graceful exit where possible; crashes/native stalls retain a last
   sample and an explicit unmeasured tail. Interval CPU during concurrent work
   is process-wide, not exact per-query CPU attribution.
2. **Memory:** labeled RSS, JS heap/external/ArrayBuffer, cached Lance bytes,
   existing daemon physical footprint, and owned-backend MLX active/cache/peak
   allocation counters where supported. Preserve each metric's scope and age.
   RSS, footprint and MLX allocations are distinct; do not sum them into
   supposedly unique physical memory on Apple unified memory. Report sampled
   maxima separately from any OS/framework lifetime peak. Default worker
   physical footprint remains unsupported rather than substituting RSS.
3. **Work:** queue length/wait time, active work, files/chunks/batches, successes,
   failures, cancellation/timeouts, retries, cache reuse/fallback, bounded stage
   wall times and lifecycle/recycle/shutdown reasons. Carry operation/request
   IDs through the existing daemon/worker/backend boundary. Record operation
   start/end and bounded minute summaries; coalesce repeated events instead of
   one unbounded record per token/chunk. Latency summaries include count and
   sample coverage; percentile aggregation must not average percentiles.
4. **Disk:** logical size and allocated-block estimates for indexes, metadata,
   model caches, logs, temporary/maintenance files and resource history itself;
   include completed inventory time/range/coverage and category growth between
   comparable inventories. Free-space readings and known maintenance receipt
   read/write/reclaimed bytes are separate fields. APFS compression/clones and
   hard links limit interpretation; allocated estimates are not a promise of
   uniquely reclaimable bytes. OS per-PID I/O byte attribution is outside this
   first version unless a separately validated source already exists. Node
   filesystem operation/block counts must never be relabeled as byte counts.

### Collection and ownership

- The existing daemon owns one bounded history writer for its home. Extend
  `resource-snapshot.ts`, daemon heartbeat/lifecycle and the worker IPC envelope
  with additive, optional resource data. Keep legacy `daemon.resources` output
  compatible; add a separate versioned history/capability summary. Mixed-version
  workers/backends report unsupported fields rather than fail ordinary work.
- Workers report self counters with existing result/progress messages, on a
  coalesced 60-second timer while already alive, and on orderly exit. Telemetry
  packets are distinct from task progress: they cannot reset task hard deadlines,
  idle-worker reap clocks or trigger scaling/initialization. A worker blocked in
  native code may miss reports; the parent records stale data and never waits
  indefinitely or substitutes a broad process sweep.
- Add an explicit cheap resource response to the already-owned MLX server,
  separate from model loading and its activity/idle timer. Bind samples to the
  manager's owner/start identity; model ID or port alone is insufficient. A
  missing/mismatched owner, old server or unavailable endpoint produces unknown
  data and no discovery/kill/restart. Metal allocation reads stay on the existing
  safe event-loop path without model evaluation/synchronization or new threads.
  Short owned maintenance helpers report available terminal counters/receipts;
  abrupt exit is partial. Do not instrument or start generative servers.
- CLI/MCP work using an existing daemon is correlated through additive request
  metadata. Direct in-process CLI/MCP work reports its own task-bound counters;
  idle thin MCP clients get no new periodic timer or collector process. All
  profile/home records remain separate. For standalone Gemma/external-store
  processes, use bounded per-run spool files with the same schema/limits and
  an atomic per-home byte reservation/retention protocol. No secondary daemon
  or unlocked competing append/prune writers. Acquire the short local writer
  lease or skip with an explicit dropped-record counter; readers never contend
  with store leases.
- Bound writer state to 2 MiB queued data and 16 KiB per record; bound open files
  and directory state. Writes/flushes are batched and asynchronous. Track dropped
  samples, overflow, write errors and coverage gaps. ENOSPC, permissions, a corrupt
  trailing record, a full queue or collector failure cannot fail indexing/search,
  extend task deadlines or cause unbounded retry. Respect existing fresh disk and
  quarantine policies; no new collection writes while mutation is denied. Cached
  history remains readable while paused/offline. Explicitly refuse symlink/path
  escapes and delete only owned resource files during retention/clear.
- Disk collection is incremental and off the request path: one inventory across
  all categories, at most 2000 entries or 100 ms of scheduling/work per minute,
  at most two outstanding filesystem operations/handles and2 MiB traversal state.
  Use directory iteration, not recursive `du`, and skip unmounted/external roots
  by default. An already registered local secondary root requires explicit
  diagnostic inclusion. Do not follow symlinks; bound inode-deduplication state
  and mark overflow/incomplete traversal. Target a completed inventory per hour
  when the tree fits the budget; otherwise expose partial coverage rather than
  publish an exact-looking total. Inventory is not an atomic filesystem snapshot.
  A filesystem call cannot always be cancelled: expire its result, schedule no
  overlapping replacement and report it stalled; a timeout is not proof the OS
  operation stopped. Status/search never wait for inventory.

### CLI contract

Proposed commands, to implement with help/JSON contracts:

```
gmax resources                         # cached latest values, age and coverage
gmax resources --since 24h --json       # bounded historical summary by role/category
gmax resources capture --duration 10m   # returns capture ID and deadline
gmax resources capture stop <id>
gmax resources export --since 24h --output ./gmax-resources.jsonl
gmax resources clear --before 7d        # explicit owned-history deletion
gmax config --resource-stats on         # opt in to ongoing local history
gmax config --resource-stats off
```

`resources`, `status` and export read cached/local history without model/daemon
startup, disk inventory or host scans. Query/export streams are bounded by the
retention ceiling; default export output limit25 MiB, explicit truncation/coverage
metadata, sanitized IDs and no key/raw path data. Capture uses the existing
permission-restricted local socket only if the selected home has an eligible collector. Otherwise
it reports unavailable; it must not boot one. Unknown CLI options/invalid durations
fail before any mutation. Capture may temporarily override the saved history-off
preference; environment hard-disable/quarantine still refuses it. Stop/off cancels
capture without clearing safety state or enabling ongoing history. The history
command reports last known writer health, dropped records and data age even if
the daemon has exited. First-version capture targets the primary daemon home;
standalone profiles retain baseline/task-bound records but report capture
unavailable rather than create another service. No MCP tool or web dashboard is
required for this version.

### Implementation boundaries

Keep the change in an isolated checkout from accepted HEAD so existing evaluation
seams and unrelated Depot edits cannot enter the release. Expected touch points:

- New `src/lib/resources/` modules for schema, self counters, bounded writer/
  reader, capture state and incremental disk inventory; extend rather than
  replace `src/lib/utils/resource-snapshot.ts`.
- `daemon.ts`, `ipc-handler.ts`, `mlx-server-manager.ts` and
  `operation-coordinator.ts` for lifecycle, cached summaries, validated capture
  controls and work IDs. Instrument the existing CLI/MCP request boundaries for
  context, without another MCP tool or collection-driven autostart.
- Worker `process-child.ts`/`pool.ts` and optional metadata through worker/MLX
  client boundaries; preserve response compatibility and task semantics.
- `mlx-embed-server/server.py` plus a stdlib-only resource adapter testable
  without loading a model; inject optional Metal counters only once the normal
  backend already owns a loaded runtime. Consume existing maintenance receipts;
  unavailable native-helper CPU/I/O remains explicitly partial. Do not add a
  native instrumentation dependency merely to make a field non-null.
- New `src/commands/resources.ts`, command registration, `commands/config.ts`,
  `index-config.ts` and additive `commands/status.ts` fields. New behavior tests
  use isolated homes/tiny owned children and reject foreign process signals/IPC.
- Packaged documentation explains units/defaults/caps and installed CLI behavior.
  Preserve the existing debug/query logs and safety policies.

### Ordered work and acceptance

1. **Contract/writer first.** Define canonical units, quality states, process and
   operation identities, privacy fields and configuration precedence. Implement
   bounded JSONL writer/readers, reservation/rotation/retention, monotonic capture
   lifecycle and cached status. Use fake clocks/temp homes for clock rollback,
   restart/PID reuse, mixed versions, truncation, corruption, concurrent writers,
   cap exhaustion, permission/ENOSPC and symlink cases. Assert disabled/inspection
   paths create no collector/files/processes and cannot touch the primary store.
   Test absent config on upgrade, explicit enable/disable, capture while history
   is off, unchanged saved preference, return to the prior mode, hard-disable
   precedence and config off cancelling an already-off preference's capture.
2. **Counters and work correlation.** Wire Node daemon/workers, owned Python MLX
   and bounded helper completion, plus direct CLI/MCP task-bound reporting.
   Use model-free ASGI and tiny child fixtures, not model loads. Test CPU units,
   monotonic deltas/deduplication, missing exits/stale reports, worker idle reaping,
   unchanged progress/hard deadlines, backend owner mismatch, unchanged model idle
   timeout and capture autostop after blocked/timed-out reporters. Record actual
   partial coverage, not invented complete cohort totals.
3. **Disk and CLI.** Add incremental category inventory and receipt accounting,
   then the commands above. Test changing trees, sparse/hard-linked files,
   unsupported allocation fields, deep/huge directories, slow/missing/external
   roots and cancelled work under global budgets. Verify bounded readers,
   sanitized exports, complete/incomplete growth comparisons and offline reads.
   Do not run a manual production prune/rebuild or inventory every user directory.
4. **Overhead gate before release.** Compare collection off/on using the same
   model-free idle and synthetic indexing/search workload, three paired runs of
   each, two minutes per mode per pair (24 minutes measured, 30 minutes total
   wall budget including setup). Synthetic embeddings and temporary-store
   requests exercise actual collector/queue/store paths without model loading;
   this qualifies collector overhead, not production model latency. Compare the
   actual collector plus application costs, not serialization alone. Target baseline
   incremental CPU <= 0.5% of one core, active-work p95 latency regression <= 3%,
   and collector-owned retained state <= 16 MiB (queue <= 2 MiB). Report heap/RSS and
   available physical-footprint deltas with attribution limits. Five-second
   diagnostic capture targets <= 1% incremental core CPU under the same fixture;
   it must honor duration/byte limits during a separate <= 10-minute model-free
   case. At two 100 MiB/25 MiB boundary fixtures, assert storage never exceeds the
   reserved cap, including rotation/temp/spool files. Measurements with excessive
   noise or incomplete accounting do not pass; fix the collector/reduce optional
   work or leave the feature unreleased and report the unresolved gate. The
   qualified feature still defaults off. Do not silently relax
   budgets or repeat unbounded observations.
5. **Review and deliver.** One owner plus independent parent-model review of the
   exact final candidate; request a reviewer only under applicable authorization.
   Run changed-code tests/typechecks and required local release/package/security
   checks. Verify Mac behavior and Linux adapters through model-free fixtures;
   unsupported physical-memory counters stay explicit, and untested OS behavior
   is not claimed accepted. Then publish/install one accepted archive through
   the established local path, preserve both Node installations/existing client
   scopes/Small default/index identity/two-worker/critical-only settings, and
   verify an additive live sample/config off/on plus installed offline export.
   No new Gemma/summarizer load or host-policy change is needed. GitHub Actions
   remains disabled. For npm MFA, give a fresh link immediately or the exact
   terminal command; do not use the agent's embedded browser or repeat an expired
   link. Include schema, defaults, bounds, units, privacy and failure coverage in
   packaged documentation and the final source/artifact proof.

**Completion:** exact source/package is accepted and delivered; baseline data
and finite capture can explain a synthetic CPU/memory/disk-growth episode across
worker restart without double-counting or exposing text/paths. Coverage, overhead,
retention and unavailable fields are visible. Any unmet gate remains explicit;
passing source tests alone is not historical-runtime acceptance. Implementation,
review delegation, measurements and release are future execution steps, not work
performed by this planning turn.

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
| Relevance research | The bounded Mac EmbeddingGemma comparison is selected above. PPR/k-hop candidate recovery, graph-distance reranking, static expansion, generated hypotheses, semantic cache, seeded/hot-cold indexing and Merkle/chunk invalidation remain unselected and gated by archived evidence/fixture thresholds. Local model startup still follows the repository's explicit in-the-moment authorization rule; this planning turn loads none. |
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

- **2026-10-24T00:20:53Z** Status: in-session → paused — Mac baseline step 1 remains partial: isolated installed Granite Metal/ColBERT CPU profiling passed in 1 test invocation; one native recovery operation refused a protected historical orphan receipt after later table writes. Receipt/config/registry retained and bounded read-only service restored. Native source/artifacts unchanged.
- **2026-10-24T00:15:46Z** Started (active → in-session).
- **2026-10-24T00:15:45Z** Status: paused → active.
- **2026-10-23T08:09:03Z** Status: in-session → paused — P3 CPU installation and bounded acceptance complete on existing user 0.26.96; normal Small/CPU/one-worker account and models prepared, no real projects added, all test processes stopped. Resource statistics stays on hold; GPU work remains optional; queued hint trim preserved.
- **2026-10-23T07:54:44Z** Started (active → in-session).
- **2026-10-23T07:54:44Z** Status: paused → active — User selected P3 CPU installation and bounded acceptance. Resource-statistics work stays on hold; other queued work is preserved.
- **2026-10-22T07:46:47Z** Status: in-session → paused — MCP context fix0.26.94 delivered: review/tests/archive/registry/provenance/three installations/two plugin scopes/live handover accepted. Reviewed CI timeout fixa8b3617 passes verification-only recovery39734613010. Resource statistics remains on hold; P3 machine/access readiness is verified; Linux installation is not yet selected.
- **2026-10-22T06:04:49Z** Started (active → in-session).
- **2026-10-22T06:04:49Z** Status: paused → active — User selected narrow MCP context packing repair. Only that item resumes; resource statistics remains explicitly on hold.
- **2026-10-22T05:58:26Z** Status: partial → paused — User put resource statistics on hold. Preserve approved0d5282c and all timing/regression evidence; no further investigation or release. Linux deployment separately awaits machine/access; other enhancements optional.
- **2026-10-22T05:55:47Z** Status: in-session → partial — Reduced sampler0d5282c source-approved; exact smoke and six-case diagnostic complete. Functional cadence/capture pass; off/off p95 varies40.7%, overhead remains unqualified. Original regression open; no release/integration selected.
- **2026-10-22T05:06:11Z** Started (active → in-session).
- **2026-10-22T05:06:11Z** Status: partial → active — User agreed to a smaller first resource-history version: reuse reviewed pieces, periodic CPU/memory sampling, bounded local history and timed capture; omit detailed operation tracking and measure overhead in isolation.
- **2026-10-22T03:50:54Z** Status: in-session → partial — 0.26.93 ownership repair published, byte/provenance verified and installed; trusted publishing and verification-only run 39718868523 pass. Repair closed. Resource history stays open/deferred; Linux pending actual machine/access.
- **2026-10-22T02:58:58Z** Started (active → in-session).
- **2026-10-22T02:58:58Z** Status: awaiting → active — Repairing the disabled trusted-publication path after the user rejected the stalled manual publishing flow; release-only, no push/PR CI.
- **2026-10-22T01:55:44Z** Status: in-session → awaiting — Reviewed0.26.93 installed and serving; both native/plugin/runtime acceptance gates pass. Publicnpm publication alone waits for user authentication; no active publication request.
- **2026-10-22T01:51:26Z** Started (active → in-session).
- **2026-10-22T01:51:26Z** Status: awaiting → active — Public publication waits for npm authentication; proceeding with the already reviewed local installation and live verification.
- **2026-10-22T01:39:23Z** Status: in-session → awaiting — Exact source approved and all archive gates passed; npm publication waiting for browser MFA. Registry verification, installation and live handover remain.
- **2026-10-22T00:53:50Z** Started (active → in-session).
- **2026-10-22T00:52:08Z** Status: in-session → active — User requested process-ownership repair plan. Chosen minimal removal of unsafe global startup kills, registry-only takeover and raw-PID restart fallback; preserve home-specific cooperative shutdown, bounded exit/refusal, concurrent-successor adoption and owned-child cleanup. Exact file/test/failure/release contract saved. Planning only; no implementation, agent, model or service started.
- **2026-10-22T00:50:00Z** Started (active → in-session).
- **2026-10-21T23:59:24Z** Status: in-session → active — Necessity audit complete across194 doc records, live plan, historical suggestions/limitations, root docs and source markers. General document search delivered; invented helper/ignore/3-of-3 rollout withdrawn. Exact installed simulation confirms one current process-ownership bug with zero real signals. Resource statistics stay deferred; Linux is separately pending; all other enhancements optional. Six docs reconciled; validation clean; no product/runtime changes.
- **2026-10-21T23:55:03Z** Started (active → in-session).
- **2026-10-21T23:52:01Z** Status: in-session → active — User steered back to document search. Recorded concrete proposal: exact .gmaxignore rules, normal watcher coverage, bounded repository passage-search helper, three fact-bearing answer checks, and stale/deleted/unavailable acceptance. Linux-switch suggestion not selected. Planning only.
- **2026-10-21T23:50:55Z** Started (active → in-session).
- **2026-10-21T23:23:56Z** Status: in-session → active — Documentation reconciled against final 0.26.92 proof: release/install/auth closed; C partial with 1/3 coverage and exact next scope decision; D after C; resource history deferred; C1/C2 unselected. Old checkpoint directives explicitly historical. Both orientation docs agree; no runtime/index/config changes.
- **2026-10-21T23:21:16Z** Started (active → in-session).
- **2026-10-21T23:18:56Z** Status: in-session → active — Delivered0.26.92: reviewed source/tag, public registry archive SHA256 verified/latest, both Node roots324files/native checks, existing Claude scopes15files, ready active daemon71807 and fresh expected document pointer. Settings/unrelated/deferred resource evidence preserved. Coverage remains1/3; narrow two-doc coverage decision is next, resource performance stays deferred.
- **2026-10-21T23:09:56Z** Started (active → in-session).
- **2026-10-21T23:09:55Z** Status: awaiting → active — User reports publication MFA completed; resume owned publish and verify registry before installation.
- **2026-10-21T23:08:46Z** Status: in-session → awaiting — Manual login verified; owned exact-tarball publish remains alive awaiting user publication MFA. No registry acceptance or install claimed.
- **2026-10-21T23:08:22Z** Started (active → in-session).
- **2026-10-21T23:08:21Z** Status: awaiting → active — User completed manual npm login; verified reoiv. Exact reviewed 0.26.92 publication is running and awaiting its separate fresh publication MFA.
- **2026-10-21T22:40:05Z** Status: in-session → awaiting — Final document-readiness0.26.92 candidate3b2d52f is parent-model approved;2417tests/types/security and exact324-file consumer/native/prune/bounded gates pass. Ready tarball SHA2568a36930e7504bc6f104fd5f08522a3c4d04bca5ae807da8af76069a5cc539166. npm E401 requires fresh browser login; owned PTY95769 waits. No publication/install/startup yet; resource-history remains open/deferred.
- **2026-10-21T07:27:59Z** Started (active → in-session).
- **2026-10-21T07:26:51Z** Status: in-session → active — Revised resource-history plan after user questioned default-on: new history defaults off in development/release/upgrades; explicit on enables ongoing history. Timed capture may temporarily collect while history is off and restores prior mode without editing the preference; env hard-disable and quarantine still apply. Existing memory snapshots unchanged. Overhead gates qualify opt-in behavior before release, never enable it automatically. Planning only; validation clean, no runtime/config changes.
- **2026-10-21T07:25:32Z** Started (active → in-session).
- **2026-10-21T07:24:04Z** Status: in-session → active — Resource-history planning complete at user request: schema/CPU/per-role memory/disk/work contracts,60s baseline and existing5min footprint,14day/100MiB retention, finite5s diagnostic capture, privacy/ownership/failure limits, CLI and five ordered execution gates. Default-on requires measured overhead acceptance. First future implementation unit is contract/writer/readers/capture lifecycle in isolated checkout. Documentation validation clean; no implementation/model/process/config change or agent delegation in this planning turn. C1/C/D separate.
- **2026-10-21T07:13:54Z** Started (active → in-session).
- **2026-10-21T07:06:41Z** Status: in-session → active — Optional Gemma0.26.90 delivered at86042c9: parent-model review, bounded real-model integration and exact registry archive accepted; both Node roots/all324 files and both Claude scopes/all15 files verified; native/ranking checks pass. Ready active daemon10475 serves Small/GPU with2 worker threads, critical-only protection and settings preserved; Gemma stopped. Resource-statistics audit/recommendations complete; telemetry implementation remains unselected. C1/C/D separate.
- **2026-10-21T06:01:08Z** Started (active → in-session).
- **2026-10-21T06:01:08Z** Status: awaiting → active — User authorized one parent-model reviewer and the new ten-minute bounded Gemma integration test. Review exact candidate first, then execute after findings are resolved. Also audit existing CPU/memory/disk observability and recommend historical debugging statistics; no telemetry change selected yet.
- **2026-10-21T05:59:35Z** Status: in-session → awaiting — Ranking 0.26.89 is published, registry-byte-verified, installed in both Node roots/plugin scopes and active on ready daemon18639 with Small/settings/protection preserved. Optional Gemma candidate92b1114/0.26.90 is isolated, unmerged/unpublished;2408 source tests, both typechecks, audits/build/native/packed-consumer and synthetic profile acceptance pass. Await authorization for a parent-model reviewer and a new ten-minute bounded real-backend integration test; no Gemma model loaded for this candidate. Existing evaluation/Depot work preserved.
- **2026-10-21T04:48:37Z** Started (active → in-session).
- **2026-10-21T04:41:38Z** Status: in-session → active — Selected steps1-3 complete: trace audit, focused artifact-prior correction and four paired passes on30 independently reviewed fresh questions. Strict Recall@10 Small70.0→76.7%, Gemma70.0→83.3%; both MRRs improve, no lost hits. Fresh correction and Gemma-vs-Small point-estimate gates pass with uncertainty. User-approved swap baseline only; original ceilings/deadline retained. Peak combined1.70GiB, zero swap growth; all owned models exited, live hashes/ports unchanged.83 distinct focused tests plus targeted follow-up checks/typechecks pass; report-label corrections preserve all numerical results. No release/promotion selected; broader delivery remains open.
- **2026-10-21T04:33:43Z** Started (active → in-session).
- **2026-10-21T04:33:43Z** Status: awaiting → active — User approved a fresh swap baseline for the prepared query-only Small/Gemma comparison; retain all other limits and original deadline.
- **2026-10-21T04:26:15Z** Status: in-session → awaiting — Selected ranking follow-up: trace audit and focused artifact-prior candidate complete; 83 focused tests, both typechecks and scoped checks pass. Final30 source-only questions accepted by independent Opus review against old holdout and all40 development cases; execution-manifest-v2 frozen. Fresh Small/Gemma comparison refused before any model load because host swap exceeded original512MiB growth guard. No budget reset, fresh results, release, live config/service/index changes. Await host admission or explicit budget amendment; original deadline retained.
- **2026-10-21T04:06:08Z** Started (active → in-session).
- **2026-10-21T04:02:02Z** Status: in-session → active — Authorized Mac MLX evaluation completed: six paired passes over 12,717 frozen chunks, 30 unique questions and 6 separate probes. Gemma passed 16-input FP32 parity and memory qualification; full Recall@10 70.0% versus Small 66.7% / Standard 70.0% misses +5pp replacement gate, so retain deployed Granite Small. Gemma peak sampled candidate footprint 2.27 GiB; coincident candidate+runner 3.25 GiB. All 360 dense/full samples valid, repeats identical, 47.8 min / 11.08 GiB. Report and execution-manifest-v4 preserve raw evidence and ranking-loss caveats. 130 focused TS and 10 Python tests plus both typechecks pass. Protected live files/port owners and frozen inputs unchanged; owned model processes stopped. Existing delivery handoff and Depot edits preserved; no promotion or further host work.
- **2026-10-21T03:01:38Z** Started (active → in-session).
- **2026-10-21T02:58:56Z** Status: in-session → active — Mac-only text-only MLX BF16 evaluation replanned at user request. Existing specification and sole plan now reference mlx-execution-plan-v2.json: pinned conversion/runtime, byte-preserving text artifact, supervised import/load/idle/batch 1/8/16 memory, 16-input FP32 reference parity, Granite runtime controls and actual full-gmax qualification before paired GPU measurements. Original frozen artifacts and protected live files unchanged; 30 questions/6 probes retained. Runlist check: 0 errors/warnings. Planning only; no model load, tensor download, dependency install or runtime implementation. Empty interrupted reference venv disclosed; separate delivery handoff and Depot edits preserved.
- **2026-10-21T02:49:33Z** Started (active → in-session).
- **2026-10-21T02:49:32Z** Status: awaiting → active — User selected planning for text-only MLX BF16 on this Mac after pausing the CPU-first execution. Reconcile the supporting evaluation specification and preserve the frozen corpus/labels; no inference or production changes in this planning turn.
- **2026-10-21T02:36:40Z** Status: in-session → awaiting — Mac-only EmbeddingGemma Phase 1 inputs prepared in docs/measurements/embeddinggemma2-eval-20261021-mac-01/manifest.json: 734 committed source/policy files, 12,717 frozen chunks, 30 fresh source-adjudicated questions and 6 separate probes. Source/fixture/chunk validation and runlist check pass. Labels are single-author; no candidate scores, dependency installation or model execution. Live config, safety-marker existence and port ownership match preflight. Await explicit in-the-moment approval for the proposed text-only CPU/FP32 loads under the 6 GiB candidate-process and 8.5 GiB experiment ceilings before completing Phase 1 admission and implementing the bounded adapters. Existing delivery scope, separate pending handoff and unrelated Depot edits preserved.
- **2026-10-21T02:17:20Z** Started (active → in-session).
- **2026-10-19T22:37:00Z** Status: in-session → active — User clarified package exemption. Reviewed and archived the October 14 Gmax stop under current noncritical pressure; normal IPC handover now serves 0.26.88. Live G2 trace metadata verified within all limits. Critical-only/two-worker/small-GPU settings unchanged; C1 and C/D remain separate.
- **2026-10-19T22:34:15Z** Started (active → in-session).
- **2026-10-19T22:24:42Z** Status: in-session → active — G2 0.26.88 published, registry-byte-verified and installed in both runtimes/plugin scopes; 239 targeted source tests, typechecks and real installed G2 checks accepted. One intermittent watcher failure retained alongside diagnostic pass of original assertions. Live activation deferred by preserved host quarantine; C/D/context remain separate.
- **2026-10-19T21:54:24Z** Started (active → in-session).
- **2026-10-19T21:51:43Z** Status: in-session → active — 0.26.87 published, registry-byte-verified and installed in both runtimes/plugin scopes; actual installed trace checks pass. Live daemon activation deferred by preserved host quarantine. Current release review complete; C/D and separately selected follow-on work remain open.
- **2026-10-19T21:21:23Z** Started (active → in-session).
- **2026-10-19T21:19:31Z** Status: in-session → active — G1 implemented with three approved agents and source-qualified after root integration: 182 distinct targeted tests, source/test typechecks, independent review and scoped lint/format acceptance; one existing lint warning. Source evidence hashed; publication/install pending CI/release review. No live runtime/index/model/CI changes.
- **2026-10-19T21:10:26Z** Started (active → in-session).
- **2026-10-19T21:08:58Z** Status: in-session → active — G1 trace evidence/coverage planning and implementation preparation complete: contract, compatibility, file ownership, work order, fixture boundaries and readiness preflight saved. No runtime source implementation or tests run; resume handoff updated to the selected G1 work.
- **2026-10-19T21:04:59Z** Started (active → in-session).
- **2026-10-19T20:58:17Z** Status: in-session → active — Approved three-agent gmax improvement review complete and reconciled: trace-first evidence/coverage contract, separate hard-bound prerequisite, shared CLI/MCP context composer, and independent acceptance protocol recorded. Source/design review only; no implementation, tests, benchmark, index or runtime change. CI/release review remains next.
- **2026-10-19T20:54:49Z** Started (active → in-session).
- **2026-10-19T20:25:18Z** Status: in-session → active — Maximum-capability GPU research complete: recommend RTX PRO 4000 Blackwell SFF 24 GB with single x16 riser 5C51D95675, subject to arrival inspection. Lenovo power/installation diagrams and current retail alternatives checked. No purchase or runtime change.
- **2026-10-19T20:25:17Z** Started (active → in-session).
- **2026-10-19T20:18:46Z** Status: in-session → active — Exact incoming MPN identified as 30J5005MUS from eBay item 117469699031. Model-specific Lenovo PSREF specifies no discrete GPU and a 330 W adapter; update D for optional add-in upgrade, with actual open-box contents/riser unverified. No purchase or runtime change.
- **2026-10-19T20:18:45Z** Started (active → in-session).
- **2026-10-19T20:14:50Z** Status: in-session → active — October 19 planning complete: add D after C for Linux CPU commissioning, hardware decision and conditional CUDA support. Incoming GPU/VRAM are unknown and may be absent. No implementation, purchase, model load or CI change performed.
- **2026-10-19T20:13:02Z** Started (active → in-session).
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


## Resource history execution and hardening — October 21

**Historical evidence; current disposition is open/deferred.** All version, daemon
and pending-step statements in this section describe their checkpoint. They do not
replace the current 0.26.92 baseline or authorize another performance run.

The user's **go** selected implementation with the off-by-default decision above.
Code is isolated from root evaluation/Depot edits in
`.claude/worktrees/resource-history-20261021`. Frozen candidate `2f926df`, proposed
version0.26.91, adds private bounded history, Node self/worker and owned Python
counters, stage rollups, disk categories, status/capture/export/clear and packaged
`RESOURCE-STATS.md`. No dependency/model/index identity or host policy changed.
Thin-client self CPU, full cache/retry/fallback counters, external inventory
inclusion and helper CPU/OS I/O remain explicitly unsupported in this first
increment; direct CLI/MCP pools are task-bound and shared MCP CPU is not attributed
once per home.

The user authorized a parent-model reviewer. Review1 of immutable `3aac787`
found four blockers: settled failed reservation cleanup, capture terminal/state
quota bypass, disabled-gap CPU attribution, and invalid-preference capture
shutdown. Corrections are in `687d5ac`, `fb02959`, `4bd4065` and `9749d1e`;
regressions cover reservation write/sync ENOSPC and subsequent normal write/clear,
self/worker off/on and consecutive captures, malformed/invalid settings, and
caller environment hard-disable before capture IPC. Review1 does not approve the
later source. A separate round2 reviews exact `2f926df`, using the same parent
provider/model/high reasoning/default service tier, with no further delegation.
Private reports: `/private/tmp/gmax-resource-review-v1-20261021.md` and the pending
v2 report.

The real Mac boundary case exposed APFS allocation ahead of logical EOF: the
first physical capture exceeded25MiB despite its record counter staying within
budget. It is retained as failed evidence. The corrected writer reserves up to
16MiB of allocation headroom per write; captures account for8MiB of allocation/
metadata headroom (about17MiB of tagged records) plus reserved terminal space.
Physical qualification observes owned file allocation after every fsync, including
live reservation files. Final observed capture peak19,148,800bytes <26,214,400;
global peak97,787,904bytes <104,857,600, with terminal capture state persisted.
This is measured Mac acceptance, not a claim about arbitrary filesystem allocation
behavior. The schema distinguishes logical disk bytes from allocation estimates.

Validation so far:242 source test files/2449 tests pass;41 dedicated resource tests
pass; source/test typechecks, build and format gate pass (warnings/info retained);
JS registry and all three Python lock audits have no affected registry packages.
Stdlib Python tests pass and six real locked-environment ASGI compatibility cases
pass without lifespan/model loading. Existing exact-package consumer checks
passed under the already selected critical-only policy, after a first isolated
HOME fixture defaulted to strict and encountered18 pre-existing MCP clients;
no client was killed/restarted or host setting changed. The latest exact consumer
now also runs a guarded real CLI/IPC resource contract with no subprocess/foreign
IPC permission. That exact rerun is pending.

The first timing batch was started before source was frozen; concurrent physical
boundary tests caused about-45% p95 variation and further source fixes changed
the candidate. It is **invalid, not acceptance**, and was stopped before its
original30-minute deadline. No performance threshold was relaxed. One fresh,
clean, finite30-minute comparison will run only against frozen source, with
24minutes baseline measurements plus a separate literal30-second diagnostic
case and its matched off case. It remains model-free; no production model
latency or physical-footprint acceptance is inferred. Report whole-fixture
post-GC heap/RSS separately from collector attribution limits. A noisy/failed
final gate leaves the feature unreleased rather than trigger unbounded retries.

Primary verification at09:08UTC: daemon10475 remains ready/active0.26.90; protected
config/store/client-setting hashes match. Source/runtime binding, live baseline
and interrupted-comparison evidence are in
`/private/tmp/gmax-resource-candidate-20261021/` and
`/private/tmp/gmax-resource-overhead-v2-20261021/`. Neither new model loading nor
production history enablement, service replacement or publication has occurred.


### Asynchronous interval follow-up

Round2 of exact `2f926df` found a remaining P2: an old backend poll could settle
after stop/restart and seed a new capture's baseline/work. Its original four
reported cases were otherwise corrected; it did **not** approve source. Report:
`/private/tmp/gmax-resource-review-v2-20261021.md`. The supposedly clean comparison
was stopped before its original deadline when that source blocker arrived; its
partial data are not acceptance. All owned groups/homes were removed. No new
comparison starts before source review approval, avoiding further source changes
mid-measurement.

`418f220` fences backend/inventory/postflush results by collection generation,
as well as delayed project-identity appends. The daemon rechecks after identity
lookup before constructing a walk. Explicit worker grant IDs fence stale CPU
frames; dispatch/work context carries the grant through Node and optional MLX
request/Python work metadata, so a fresh poll cannot relabel earlier queued work.
Old completed task/tracked-work events are excluded; interval baselines and
initial backend loss are re-primed. No overlapping replacement starts while an old
collection flight settles. Unknown first-interval CPU is now null/unknown rather
than0. The managed-memory qualification proxy now includes positive paired
parent/owned-worker post-GC heap and external-memory increases; RSS remains
separately reported with no universal physical-memory claim.

Validation at09:53UTC:2456tests/242files,48dedicated resource tests, source/test
types, build and format gate pass;55stdlib Python tests (14capability skips) and
6locked real ASGI cases pass without model/lifespan loading. Exact consumer and
physical-boundary reruns are underway. Independent parent-model round3 reviews
immutable418f220 and all prior findings/responses. No new model, daemon, host
setting or production history change has occurred. Old rejected2f926df archive
is quarantined in `/private/tmp/gmax-resource-candidate-20261021/rejected-2f926df/`;
it must never be published. Final artifact/review/performance evidence is still
required for the corrected candidate.


### Owner lifetime and rollup follow-up

Round3 rejected exact `418f220` with four P2 blockers, reported in
`/private/tmp/gmax-resource-review-v3-20261021.md`: off/on could replace an inventory
whose actual filesystem work survived the wrapper timeout; quarantine/storage
pauses did not consistently revoke the grant; completed baseline bins could be
relabeled into capture; and overdue capture work mutated bins before expiry.
No performance run was started against this rejected candidate.

Corrections retain a disk owner across off/on until actual calls and handle closes
settle, revoke grants at active-to-inactive boundaries including quarantine/storage,
flush old work before capture/pause, and expire capture before any work mutation.
Capture initialization is inactive until state admission settles. Pending project
identity details are additionally limited to32 across minute boundaries, while
aggregate counts retain sampled work. Controlled tests cover pending lstat/opendir/
read/close, admission recovery and old replies/worker work, storage pauses,
pre-capture sampled/delayed-identity work, refresh-observed off/on and direct/worker/
tracked late completion with ongoing history both off and on. The new exact source
requires another independent parent-model review before expensive qualification.

Exact418f220 consumer passed under existing critical-only policy. Physical capture
peak19,505,152bytes and global peak98,144,256bytes passed their25/100MiB ceilings;
these do not transfer source approval or qualify a later archive. Live .90 remains
unchanged and new collection remains off. Root evaluation/Depot edits are preserved.


Corrected candidate `e6369f83e25f26141ac5478309acb4df21021c3f` is clean/frozen.
All2468tests/242files, source/test types, build/format and diff checks pass.
Independent parent-model round4 is running (codex/gpt-6.1-sol/high/default), with
the original brief, all three reports/responses and unresolved gates included.
Latest exact consumer and physical-boundary cases are running; no timing run has
started. The418f220 archive is quarantined under `rejected-418f220/` beside the
older rejected2f926df archive. Neither rejected artifact may be published.


On exact `e6369f8`, the physical fixture passed capture peak19,603,456bytes
(accounted26,197,951 incl8MiB headroom) and global peak98,242,560bytes, including
observed live reservation files and persisted terminal state. Current audits:
JS no known vulnerabilities; Python registry locks69/15/58packages,0affected
(with local/pinnedGit exclusions explicit);55stdlib tests pass,14capabilityskips.
Protected config/store/client settings and unrelated root edits retain saved
hashes. Private334-file archive SHA256
`1a57045f9459de0c3d97654738fccca2d843ca3ea94ebc9223b33aeedf444c4b`
is bound to this candidate but is not publishable pending source/performance gates.


Exact-source packed consumer completed successfully: isolated consumer audit,
document contract, resource realCLI/IPC/capture/export/hardoff contract, native
watcher/recovery, Session/native containment, locked prune and bounded cleanup
with Node readers/29-field preservation all pass. Source review4 remains pending;
no expensive comparison starts without approval. All package fixtures cleaned up.


### Shared writer ownership follow-up

Round4 withheld approval for exact `e6369f8`, confirming the prior four fixes but
reproducing a new P2: onCompromised only recorded an error, so a writer paused
before marker creation could resume its stale quota admission alongside a
successor. Default-limit reproduction reached257files against256; a48KiB scaled
case exceeded logical and occupied limits. Report:
`/private/tmp/gmax-resource-review-v4-20261021.md`. No timing was started.

The correction revokes the lease locally and checks ownership plus host admission
before mutations and after relevant awaits. A late-created marker settles/closes
and is safely removed without starting its target. Already submitted target work
keeps its durable reservation until actual I/O/descriptor closure settles. Fresh
retries reacquire ownership and recalculate capacity. Controlled regressions cover
both reported overlap cases with peak checks and eight marker/target await stages,
including retained reservations during stalled submitted I/O. Source and release
gates do not transfer from the rejected candidate.


Corrected `3514468fcb56c8d3afaf6c821415420db3e3981b` is clean/frozen;2478tests/
243files,24store/lease tests, both typechecks/build/format/diff checks pass.
Independent parent-model round5 (codex/gpt-6.1-sol/high/default) is running with
original brief/all prior findings/responses/unresolved gates. New exact consumer,
physical bounds and archive preparation are running; no timing starts until source
approval. Rejected e6369f8 artifact/evidence is quarantined under its named private
subdirectory, alongside earlier rejected artifacts. Live .90 stays unchanged/off.


### Non-expiring admission guard

Owner reproduced a wider pre-marker case on3514468: two compromised writers with
submitted but unresolved marker opens plus a successor reached257files against256
even after post-await lease checks prevented their target writes. Private bounded
reproducer: `/private/tmp/gmax-resource-multiple-lease-repro.cjs`. Round5 was
cancelled immediately for this known source blocker; no approval is inferred.
No overhead run started. The current3514468 package/physical results remain rejected
evidence, not acceptance of the upcoming correction.

The correction adds a kernel-backed SQLite transaction guard before the existing
lease. Hold it across all actual marker/target I/O and lease release; a soft lease
expiry cannot let another writer reach pre-marker admission. Built-in DatabaseSync
uses busy_timeout=0, journal_mode=MEMORY, BEGIN IMMEDIATE, then ROLLBACK/close;
no data is committed and no helper process/dependency is introduced. One private
empty writer-lock.sqlite inode is counted in256files, protected from clear/prune,
and refused if linked/nonempty or unexpected journal/WAL sidecars exist. JSONL data
writes remain asynchronous; only built-in connection/lock operations are synchronous
and do not wait for a competing writer. No collector service/thread/timer is added.
Node22.13+ provides this capability;22.12 needs --experimental-sqlite. Missing builtin
support reports resource_lock_unsupported without a lease-only fallback; off/read-only
paths do not import it. Node's experimental warning is retained and documented.
References: https://nodejs.org/download/release/v22.13.0/docs/api/sqlite.html and
https://www.sqlite.org/lockingv3.html .

Controlled regressions now prove repeated successors cannot submit invisible marker
opens while the revoked owner holds OS work, both default-file and48KiB cases;
all mutation-stage fencing remains. Real owned subprocess cases verify cross-process
exclusion after same-process losing connections close, and release on owner exit
without explicit database close. Guard inode survives clear; linked guard/sidecars
are refused. New source/package/physical and clean finite overhead gates are required.


Round5 terminal state is interrupted, no approval/report acceptance. Its partial
review independently reproduced both pending-marker and pending-target versions
with two compromised writers plus a successor (257files); old writes rejected
lease_lost only after the excess files already existed. The kernel guard directly
addresses both, retaining admission through target and marker settlement. Every
eight-stage compromise regression now also checks three successor attempts fail
ELOCKED before they can acquire the soft lease or mutate files. The guard is
initially created0600 using exclusive synchronous create/close before SQLite opens;
existing contenders obtain no fs descriptor on that inode. Connection/lock work
is synchronous/non-waiting; batched resource data remains asynchronous.


Frozen `477779b6332b17e4f08fb2b257cddf2f49623762` is clean;2482tests/243files,
28store/lease tests, both typechecks/build/format/diff checks pass. Round6
independent parent-model review (codex/gpt-6.1-sol/high/default) is running with
the original brief, all reports/findings/responses, interrupted round5 findings
and remaining gates. Exact packed consumer/physical cases/archive preparation
are underway. No new comparison starts before source approval. Live .90 remains
unchanged, new history stays off; no model or service startup has occurred.


On exact477779b physical qualification passed: capture occupied peak19,329,024bytes
(accounted26,197,707 incl headroom), global peak97,968,128bytes, live reservations
observed and terminal state persisted. Node26.8.1 also passed guarded private-home
capture start/stop/read/restores-off with empty0600 guard; Node22.23.1 source/focused
cases pass above. The334-file archive SHA256 is
`77917b980049e922d4cd0619c5c0e3e8be5e2b13225ea44532cd4e3a75df89ee`;
source manifest/archive proof are private under gmax-resource-candidate-20261021.
Still not publishable: source review/packed consumer completion/clean finite overhead
pending. Protected live verification confirms ready .90 PID10475, config/store/client
hashes and unrelated root edits unchanged. No actual history preference enabled.


Exact477779b packed consumer completed: isolated dependency audit, document/resource
realCLI+IPC expiry/restoration/private-export/hardoff, native watcher recovery,
Session/native containment, locked prune and bounded cleanup with Node readers all
pass. Source manifest/archive hashes still match the frozen candidate. Source
review6 and one clean finite overhead comparison remain pending; no release or
production state change. All owned consumer fixtures cleaned up.


### Approved-source overhead qualification

Independent ROUND6 approved exact477779b with no concrete source blockers. Report:
`/private/tmp/gmax-resource-review-v6-20261021.md`. It independently passed71focused
JS tests,4stdlib Python tests and guard-through-soft-release/acquisition-failure
exclusion; source remained clean. Approval explicitly excludes package/performance/
publication/install acceptance. Owner accepts the bound exact-source archive,
consumer and physical evidence above for this Mac only.

One clean approved-source comparison launched2026-10-21T10:43:48UTC, with its
original absolute30-minute deadline retained in private
`/private/tmp/gmax-resource-overhead-approved-477779b-20261021/launch.json`.
No source/build/fixture changes, heavy test suites or concurrent qualification
runs will occur during measurement. The fixture remains model-free/private and
preserves primary settings. Thresholds,24measured baseline minutes and separate
30second diagnostic/off cases remain unchanged. No accepted numbers are inferred
until raw paired noise, confounding, memory and all gates are assessed. A final
noisy/failing result leaves it unreleased, without threshold relaxation/retries.


### Overhead gate failed — resource history remains unreleased

The approved-source comparison failed its first raw active pair: off p95
59.072584ms versus on101.007167ms, a+70.988232% difference against the agreed
+/-10% raw-pair noise ceiling. Each case completed479 samples. Aggregate self+owned
worker CPU was11.9722% vs13.1344% of one core (about29,996 vs32,923CPUus per cycle);
these values do not isolate telemetry cost or explain the much larger tail-latency
difference. Both cases had zero drops/writer errors. Cause remains unresolved;
this is **failed/noisy qualification, not accepted production-overhead evidence**.
The three completed idle pairs had provisional increments0.02042/0.01922/0.00897%
of one core; those do not rehabilitate the failed complete gate.

Stopped2026-10-21T11:02:30UTC, before the original11:13:48UTC deadline and before
further active pairs/diagnostic completion. No retry or threshold relaxation.
The explicitly owned controller38114 and current case group69730/synthetic worker
were stopped; targeted verification found no live owned fixture process, and the
remaining disposable home was removed. The complete raw cases, original deadline,
launch binding and failure/cleanup record are preserved at
`/private/tmp/gmax-resource-overhead-approved-477779b-20261021/`.

Frozen477779b source and334-file archive hashes still match. ROUND6 source approval,
correctness/security/package and tested-Mac physical evidence remain valid in their
own scopes. The archive proof is explicitly publishable:false;0.26.91 has not been
published/installed/tagged or handed over. Live0.26.90/Small and new-history-off
remain unchanged. Required next work is diagnosis of this timing discrepancy,
separating telemetry/IPC cost from synthetic CPU scheduling/thermal variation and
native insert tail latency, before selecting any new bounded qualification.
No further comparison or model run is authorized by reusing this finished window.
