---
type: doc
status: active
created: 2026-10-03T02:39:56Z
updated: 2026-10-23T06:57:01Z
audience: internal
summary: Gmax 0.26.96 is released on the Mac and tested on the P3 CPU. P3 uses Small/CPU/one worker with models ready. Resource statistics stays on hold; GPU work remains optional.
---

# Future Sessions

The accepted baseline is **0.26.96**. Read the
[delivery plan](plans/gmax-delivery.md) for the evidence and earlier decisions.
The user rejected work added without a demonstrated reason. Historical proposals
and old handoffs do not authorize new implementation or experiments.

## Delivered

- **P3 CPU setup:** `~/.local/bin/gmax` 0.26.96 is verified and tested on Ubuntu.
  Small/CPU/one worker is configured and the model cache is ready. Code/document
  search, full-text search, MCP, file changes, restart and shutdown pass in a
  separate test store. No real project was indexed and no test process remains.
- **0.26.96 follow-up:** queued watcher batches can be cancelled during close or
  pause, interrupted indexing retains pending status, and `gmax repair --fts`
  builds a missing full-text index. The Mac release/install/store acceptance is
  recorded in the delivery plan; P3 full-text creation and search also pass.
- **MCP context output:** `build_context` skips an oversized function and tries
  later bodies that fit, preserving relevance order and file/line references.
  Entry-point labels, separators and the footer count toward its approximate
  size limit. Existing MCP sessions need a normal restart to load updated server
  code; do not terminate other sessions.
- **Document search:** indexed Markdown in registered projects is searchable
  through `gmax mcp --existing-index-only`. Ignore rules control coverage. The
  proposed repo-specific helper, ignore changes, three-file pilot requirement
  and external-consumer rollout were withdrawn.
- **Startup safety:** the process-ownership repair delivered in 0.26.93 is
  retained. Another instance's processes cannot be treated as owned merely
  because their names match.
- **Trusted publishing and recovery:** the publication and verification-only
  recovery described below are complete. Only the manual release workflow is
  enabled; push/PR CI was not restored.

## Earlier 0.26.94 release and CI evidence

The reviewed product source and tag are `58faaac` / `v0.26.94`. The source suite
passed **2,461 tests in 237 files**; the parent-model reviewer independently
passed 101 focused tests. Types, build, security, exact-package regressions and
consumer/native checks passed.

The original [publication run](https://github.com/reowens/grepmax/actions/runs/39732926638)
published the approved package, then failed during registry verification: after
404 retries, a metadata read timed out before the overall deadline. This was a
verification failure after accepted publication. It was not a failed product
build or test suite.

Reviewed workflow fix `a8b3617` retries transient reads within the existing
480-second budget. Wrong bytes, version or URL still fail. Nine source tests and
18 independent offline scenarios passed. The full Python suite ran 59 tests,
with 13 optional-runtime skips.

[Verification-only recovery](https://github.com/reowens/grepmax/actions/runs/39734613010)
**passed with npm publication skipped**. The
[0.26.94 release](https://github.com/reowens/grepmax/releases/tag/v0.26.94) is public;
registry bytes and signed provenance match the approved artifact. Provenance
identifies the original publisher, not the recovery commit. Do not republish to
clear the historical red run.

All three existing Node prefixes (Homebrew 26.12.0, NVM 22.23.1 and NVM 22.23.4)
verify all 324 package files. Both existing plugin scopes verify all 15 files;
other plugin records are unchanged. Native checks passed in each runtime.
Cooperative handover accepted 0.26.94 as ready, active and open. PID/readiness
records are dated acceptance evidence, not a continuing liveness claim.

Gmax configuration, store identity, safety markers and 26 unrelated root files
were preserved. Two client settings files changed before local installation and
were left untouched; `settings-proof.json` records that boundary. Do not claim
all client settings matched the earlier snapshot or restore unrelated changes.
Proofs are in `/private/tmp/gmax-mcp-context-release-0.26.94-20261022`; the plan
retains source/archive identities and review references. Delivery and CI recovery
are closed. No reinstall, repeated handover or manual npm MFA is needed.

## Remaining work

- **Resource statistics is ON HOLD at the user's request.** No investigation,
  timing, integration or release without new direction. Preserve the isolated
  source-approved prototype `0d5282c`, its functional results, the inconclusive
  off/off comparison (40.7% p95 variation), and the original unresolved
  +41.935 ms regression. The collector is absent from installed 0.26.96.
- **P3 CPU setup is complete for the selected bounded test.** The normal account
  is ready for `~/.local/bin/gmax add .` from a real project. The fixed 79-file,
  14,114-line snapshot indexed in 170 seconds with one worker; current-version
  warm MCP queries had median 39 ms / p95 46 ms across 20 requests. These results
  do not claim large-repository capacity. Full evidence and limits are in the
  [P3 acceptance record](plans/gmax-delivery.md#p3-cpu-acceptance--october-23-2026).
  No extra benchmark is scheduled. GPU purchase/CUDA remains optional; only Intel
  integrated graphics was observed. The [Linux design](linux-gpu-p3-design.md)
  remains dated reference research, not current purchase advice.

Broader context composition, ranking/language features, model promotion,
automatic index migration and watcher extraction remain optional. The narrow
MCP packing fix does not select those projects. Historical watcher and memory
questions reopen on a concrete current failure.

Preserve the unrelated dirty embedding/ranking experiments and Depot usage edits.
Do not load a large model, reindex production data, change safety policy, or start
agents merely to investigate an old proposal. Use parent-model reviewers with
inherited settings when review is authorized.
