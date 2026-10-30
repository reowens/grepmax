# Private embedding worker boundary

## Current stopping point and evidence

The [owning stopping point](plans/gmax-remote-background-embedding.md#remote-embedding-stopping-point)
and [saved continuation](future-sessions.md#saved-continuation) own current state.
Windows cache integrity/access passed and one matching dense+ColBERT result was
validated after reconciliation; the normal client returned a task-wait timeout.
All owned cleanup is confirmed. The later terminal/deadline fixes are source-only,
with no automatic retry, release or production activation queued.
Checked-in runtime evidence (private record)
and historical fake/compile coverage (private record)
separate those claims; private local paths are supplementary evidence, not public proof.

In the separate **Platform repository**, start at
`scripts/lib/gmax-embedding-worker.md`, section `Gmax stopping point and evidence ownership`.
It links the fixed bridge, native task/Job Object boundary, roster/admission,
compiler policy and P3 host procedure. Cross-repository paths here are qualified
by repository; no relative URL assumes both checkouts share one tree.

## Fixed input, cache and execution ownership

[Private entrypoint](../src/embedding-batch.ts) reads fixed bounded
`embedding-input.json` and atomically writes `embeddings.json`. It calls the
[executor](../src/lib/workers/remote-embedding-executor.ts) with the
[prepared ONNX factory](../src/lib/workers/remote-embedding/onnx-runtime.ts),
not a permanent refusal stub. Exact model/tokenizer/runtime inventory is verified;
offline flags precede lazy model imports, transformer cache writes are disabled,
and Granite/ColBERT use the explicit verified model root. Owned sessions are
disposed after native settlement. Source hashes do not themselves enforce cache
permissions; preparation must supply a read-only cache to the job account.

The Platform adapter alone supplies `GMAX_EMBED_MANIFEST`,
`GMAX_EMBED_MODELS_ROOT`, `GMAX_EMBED_RUNTIME_ROOT`,
`GMAX_EMBED_RUNTIME_COMMIT` and optional `GMAX_EMBED_DEPENDENCIES_ROOT`.
No request chooses executable instructions or cache paths. The contained hashed
pnpm dependency closure is verified before the loader, with declared aliases and
no escaping/unlisted targets. Metadata byte verification never calls inference.

The P3 sender uses its canonical Linux no-swap guard and the existing fixed
Platform bridge. This is not a Mac/Windows cgroup requirement. Windows has an
embedding-only native Job adapter with affinity/priority readback and kernel
commit limits plus sampled RSS/floor guards. Mac has an owned process-group
adapter with nice10, sampled RSS/floor/deadline and average2-core CPU-time
throttling, not affinity. Existing Mac roster lanes were not changed.

The [protocol](../src/lib/workers/remote-embedding/protocol.ts),
[client custody](../src/lib/workers/remote-embedding/client.ts) and
[fixed sender](../src/lib/workers/remote-embedding/fixed-transport.ts) define the
input/result fences and ownership lifecycle. Inner/outer job identity is persisted before dispatch. Cancellation awaits owned
stop and terminal cleanup evidence; unknown custody is retained without duplicate
submission or silent local-inference fallback. P3 keeps the only store writer.
The retained Windows records establish prepared assets/ACLs and one matching-model
result. Normal client/terminal completion and numerical parity remain unproved;
Mac route admission remains absent. These are distinct from missing stub source.
Models cold-load per one-shot job and are reused within that job; no permanent
model service was added. No fan, memory or speed improvement is claimed.

## Historical operation-local SSH source correction

Platform `6c64097eaf` clones Gmax workers through operationSshWorker and passes
nonmultiplexed options across policy/status/reservations/task stop/fetch/cleanup.
Shared defaults stay unchanged. Gmax `fd81c10` requires GMAX_SSH_LIFETIME from
the fixed bridge and adds canonical `scripts/remote-embedding-metadata.mjs` for
future authorized guarded reads, using the same options on policy and metadata.
At that source-commit point, no test/compile/runtime/guard invocation followed;
later actual SSH/preparation evidence is linked from the stopping point. Historical
failure remains immutable; the retained member was not identified as an SSH PID.

## Historical selected resume outcome

Corrected canonical SSH metadata passed with a normally empty cohort. The single
fixed dependency-preparation request then reached the180s deadline, with no
terminal preparation result. Local cohort drain/removal and later exact owned
Windows reservation/task-removal cleanup completed; partial cache effects remain
unknown. Inference0 and no model/runtime/manifest staging. Platform22cb207e7a
corrects per-phase remaining-time reuse as source only, without a rerun.
Actual outcome and limits (private record)
keep this deadline failure separate from the older retained-descendant event.

## Historical captured preparation continuation

One continuation reused the exact staged source and reached the native phase
within budget, but returned an uncertain scheduler/native result, not a cache
completion. Exact owned cleanup completed; model jobs0. Source-only follow-up
preserves bounded launcher error/state/exit evidence before removal. See the
continuation receipt (private record).
