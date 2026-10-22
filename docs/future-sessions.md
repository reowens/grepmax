---
type: doc
status: active
created: 2026-10-03T02:39:56Z
updated: 2026-10-22T03:51:24Z
audience: internal
summary: Process-ownership repair 56c7806 / 0.26.93 is public, byte/provenance verified and installed on this Mac; trusted-publishing restoration is complete. Document search delivered. Reduced resource sampler0d5282c fixes both round1 blockers and is under round2 review; original regression remains open. Linux pending machine/access.
---

# Future Sessions

Read the [necessity audit](plans/gmax-delivery.md#necessity-audit--october-21-2026)
in the sole delivery plan. The user explicitly rejected work added without a
reason. Do not turn research ideas, ignored files or test samples into milestones.

**General document search is delivered.** It searches indexed Markdown in
registered projects through `gmax mcp --existing-index-only`. Ignore rules affect
which files are indexed, not whether the feature exists. The proposed repo-specific
helper, two-file ignore change, 3/3 sample requirement and unspecified consumer
rollout are withdrawn. None was implemented. Linux no longer waits for this work.

**0.26.92 / `3b2d52f` delivery is complete:** public registry archive identity,
both Node roots/all 324 files, both Claude scopes/all 15 files, native checks and
installed readiness accepted. Small/GPU, two workers, critical-only policy and
settings are preserved. Optional Gemma remains stopped. Old daemon PID/readiness
statements are dated evidence, not a continuing liveness assertion.

## Process-ownership repair — delivered

Reviewed **56c7806 / 0.26.93** removes startup's global name-based termination and
raw-PID restart fallback. Same-home upgrades request socket shutdown and wait for
actual exit. Unknown owners and registry-only watcher takeover refuse; failed
startup preserves predecessor controls. Ownership is checked again after startup
waits at the resource admission boundaries.

Parent-model source review passed, as did **2,457 tests in 237 files**, types,
security and exact-archive consumer checks. The qualified v4 archive is installed
in both existing Node prefixes (324 files each) and both existing Claude scopes
(15 files each). Native and ownership checks pass in both runtimes. Cooperative
handover from PID19843 to PID71965 serves 0.26.93 ready/active/open. Nine settings
files, 26 unrelated root files, other plugins, Small/GPU, two worker threads,
critical-only policy and index/store identity are preserved. Optional Gemma stays
stopped. PID/readiness statements are dated evidence.

**Public npm latest is 0.26.93.** GitHub trusted publication succeeded in run
`39717358032` from approved publisher `911a267`; the complete hosted tar matches
the reviewed package, and the final registry archive matches its raw SHA256/SHA512.
Sigstore verification binds the artifact to the real GitHub workflow/main/source/run.
The GitHub release is public. Reports and durable source/hash records are in the
[publication repair](plans/gmax-delivery.md#trusted-publication-repair--october-22-utc).

The publication run's final registry check hit a cached404. Reviewed publisher
`52ea74e` fixes that cache handling and adds a verification-only dispatch.
[Recovery run39718868523](https://github.com/reowens/grepmax/actions/runs/39718868523)
passes all source/archive/build/registry/release gates with npm publication skipped.
The existing package's signed provenance still identifies its actual publication
commit/run. This repair is closed. Do not republish 0.26.93, request manual MFA,
reinstall the accepted package, repeat handover or run a model experiment.
Only the manually dispatched release workflow is active; no push/PR CI was restored.

## Remaining work

- **Resource statistics:** the user agreed to a thin recorder using existing
  counters/writer, with per-operation tracking removed. Isolated prototype
  `0d5282c` fixes both round1 blockers and passes168JS/3Python tests and
  types/build. Retained pools now save periodic worker samples and observe
  preferences; diagnostic latch/ledger persistence is private, with real primary
  containment still read-only. Parent-model round2 review is running. Historical
  smokes do not bind this source. After review, run exact-source `--smoke`, then
  `scripts/resource-sampling-measure.cjs --measure` using Node22.23.1 in
  `.claude/worktrees/resource-sampling-20261022`. This is not current0.26.93
  integration or a released collector. Preserve approved477779b, retained479eb23,
  frozen unreleased0.26.91 and failed/control evidence. The original+41.935ms p95
  regression stays unresolved; the new diagnostic cannot retroactively clear it.
- **Linux P3 deployment:** requested, pending the actual machine/access and user
  selection. CPU installation/baseline first. GPU purchase/CUDA are conditional.
  The [design](linux-gpu-p3-design.md) is reference material, not an active queue or
  a dependency on document rollout.

C1/C2 context/evidence work, broader graph/language/relevance features, Gemma default
promotion, automatic migration, release automation and watcher extraction are
optional. Historical watcher/kernel/native findings retain uncertainty; reopen on
a real current failure, not to keep a queue occupied. Depot/provider work belongs
to platform; preserve unrelated dirty evaluation/collector files. Pending older
handoffs must be reconciled against this audit, not used to revive completed work.

No product source, model, runtime, index, ignore or client settings changed during
the audit. Keep existing release/security checks for actual changes. Use parent-model
reviewers with inherited settings only when delegation is authorized. No manual
production prune/rebuild, large model startup or safety bypass is authorized here.
