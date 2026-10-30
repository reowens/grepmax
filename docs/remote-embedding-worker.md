# Private embedding worker boundary

`src/embedding-batch.ts` is a private entrypoint. Its `describe` operation reports
`embedding_containment_unavailable`; every other invocation refuses with exit75
before input-file reads or model imports. It accepts no source path, executable,
shell command, cache location or readiness assertion from a request.

`src/lib/workers/remote-embedding-executor.ts:executeRemoteEmbeddingBatch` accepts
the shared protocol plus a trusted in-process `PreparedRemoteEmbeddingRuntime`.
It validates the prepared identity, verifies artifacts before creating models,
and calls the existing Granite `runBatch` then ColBERT `load`/`runBatch` APIs with
formatted text. Dense normalization, tokenization and packed ColBERT math remain
owned by those existing models. The adapter must provide exactly those models;
an MLX dense-only implementation cannot replace this runtime.

The runtime is an internal injection point, not a wire capability or an activated
host backend. It must bind `artifactDigest` to the exact model/tokenizer files,
preprocessing and normalization contract and `runtimeDigest` to the prepared
runtime revision and dependencies. It must enforce a read-only cache, disable
downloads before any model import, and dispose only sessions owned by that job.
No production adapter supplying that proof exists in this source change.

The executor admits1 job at a time and validates the entire result before
returning it. Cancellation and deadline checks discard results after each awaited
operation. They do not cancel native ONNX calls: ownership is retained until the
call settles and owned-session disposal finishes. Factory or disposal failure leaves the
executor unavailable until its owned process exits. The transport must provide
the hard deadline, whole-child termination and terminal cleanup confirmation;
it must never kill a shared worker to implement this API.

The sibling Platform `scripts/lib/gmax-project.mjs` reserves `embed-batch` with
no execution lane. `scripts/gmax-worker.mjs` reports unavailable before frozen
source capture or dispatch, and `scripts/gmax-worker-task.mjs` refuses before
source decoding/materialization. Existing Mac and Windows task transport is not
embedding qualification. No arbitrary-source embedding command is admitted.

Activation requires a trusted fixed-task adapter enforcing2CPU, below-normal
priority,2GiB aggregate owned RSS,180s total deadline including transfer,8GiB native
available-memory floor and confirmed whole-job cleanup. Windows Job Object
commit-memory limits alone do not provide RSS enforcement or prove no pagefile
use. Mac has no qualified embedding containment route here. The Linux compiler
cap is compiler-only and cannot supply either capability. The prepared matching
ONNX models, exact tokenizer/runtime inventories and actual numeric/token parity
also remain unqualified. No models were loaded or downloaded.

The existing task lifecycle is one-shot. Sessions can be reused inside its
16-chunk batch, but each new job still pays cold-start costs; no persistent
service is introduced. P3 keeps all filesystem/store authority and defers an
unavailable route without local-inference fallback. The owning
[plan](plans/gmax-remote-background-embedding.md) records integration state.

Validation for this worker source consists only of source/diff inspection.
`tests/remote-embedding-executor.test.ts` and Platform's
`scripts/lib/gmax-embedding.test.mjs` are unexecuted fake-fixture source. There is
no test, typecheck, build, remote probe, runtime qualification or activation
receipt, and no fan or power benefit is claimed.
