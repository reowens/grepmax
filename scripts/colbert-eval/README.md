# ColBERT backend evaluation

The fully warmed paired Mac run completed (`run-03` in the private measurement
root). Document batch16 MPS was 6.53–6.66× faster in both orders; batch1 queries
were 6.65–8.79× slower. The host remained active. Keep query encoding on ONNX;
the saved-output check confirms format/scorer operation, but MPS changed the
first result for 12/32 synthetic queries (91.875% mean top-five overlap). Next
compare correct answers on the frozen 30-question set before integration. See [MAC-SMOKE.md](MAC-SMOKE.md).

The original 17M model has run on this Mac through PyLate CPU/MPS and against
Gmax's deployed ONNX-int8 CPU encoder, using 64 frozen Gmax-tokenized inputs.
All three experiments completed within the resource limits and cleaned up their
owned processes. No installed model, index, service or setting changed.

Earlier fixed-order timings remain provisional: background activity was not
recorded, and warm-up/order/cache effects were uncontrolled. The paired run
warms every measured shape and reverses order, recording background snapshots.
Its batch16 document gain is consistent across the two passes, while query
batching is variable and batch1 is slower. This is a small synthetic comparison
on an active host, not a production throughput guarantee.
Raw FP32 CPU/MPS vector agreement passed; the ONNX comparison changes precision
and does not establish storage, ranking or cross-store compatibility.

The broader model order remains current17M, LateOn-Code-edge, then
LFM2.5-ColBERT through MLX/GGUF, with Granite fixed. Resource-history development
stays on hold. The local plan is `docs/plans/colbert-backend-evaluation.md`.

The original preparation protocol still accepts only `validate`; its mock loaders
remain inert. Real experiments use the separate explicit `mac-smoke.cjs` route.
Follow the repository [review and verification budget](../../AGENTS.md#review-and-verification-budget).
Preparation corrections do not automatically trigger reviews or repeat suites.

## Components

- `CONTRACT.md` defines the versioned wire format, file ownership and boundaries.
- `contract.cjs` validates Node requests/responses with bounded UTF-8 JSON lines.
- `freeze.cjs` freezes available fixture/source/cache provenance without models.
- `adapter.py` prepares pretokenized PyLate input and numeric contracts; its
  validation route does not import an inference framework.
- `runner.cjs` owns validation and explicitly selected Mac experiment children,
  limits, samples and cleanup.
- `saved-compat.cjs` replays released storage/scoring code on saved vectors only.
- `mac-smoke.cjs` / `mac-smoke.py` run the bounded Mac experiments;
  `onnx-smoke.cjs` supplies the installed ONNX arm.
- `upstream-mixedbread.json` pins source metadata and expected artifact hashes.

## Important model details

The pinned upstream model has 2 Dense layers, 256 to 512 then 512 to 48. The
ordered module/config/weight chain matters. The redundant nested `2_Dense` path
is not an additional module. Expected weight digests come from pinned upstream
LFS metadata during Wave1. The later Mac setup downloaded and verified all 12
original files, and actual loaded parameter values matched those checkpoints.
The existing ONNX tokenizer bytes match the upstream `tokenizer.json` Git blob,
but the separate `tokenizer_config.json` is not identical.

Upstream PyLate preparation specifies query length 48 with no query expansion.
Gmax prepares 32 tokens with attended mask expansion. For a backend-only test,
the adapter must preserve Gmax's already prepared token IDs and masks. Using
upstream defaults is a separately labeled preprocessing comparison, not the same
experiment. JS document rounding and per-document quantization also require
explicit compatibility checks.

`upstream-mixedbread.json` records metadata provenance and the projection digest
recipe. A matching digest string in a request is not proof that local weights,
the runtime or actual GPU execution are qualified. Wave 1 validation only checks
the request contract; later execution must verify local files and device use.

## Model-free checks

The tests use Node built-ins and Python stdlib, with synthetic tokens and child
processes. No package installation or model is required.

```sh
node --test scripts/colbert-eval/test-contract.cjs
node --test scripts/colbert-eval/test-integration.cjs
node --test scripts/colbert-eval/test-freeze.cjs scripts/colbert-eval/test-runner.cjs
python3 scripts/colbert-eval/test_adapter.py
```

The cross-language integration checks install an import guard that rejects
torch, PyLate, NumPy and Transformers during validation. They verify accepted
input order and rejection of malformed IDs, masks, model identity and inference
bypass attempts. Additional freezer/runner tests cover the owned components.

## Validation-only run

```sh
node scripts/colbert-eval/runner.cjs \
  --request scripts/colbert-eval/fixtures/synthetic-validate-request.json \
  --deadline-ms 30000
```

The example is synthetic, not an executable model contract. This checks the real
isolated Python validation route with built-in host readings and cleanup. A busy
host or unavailable safety reading produces a refusal, not a fallback. The JSON
result names the private run manifest, request/response hashes and ownership
evidence. Temporary homes live under the OS temporary directory; they are not an
OS filesystem or network sandbox. Only the fixed trusted adapter or owned
model-free test children can run. The CPU/RSS snapshots may miss a short child;
their manifest states this limit. No GPU memory measurement is claimed.

For fixture preparation, inspect the bounded options with:

```sh
node scripts/colbert-eval/freeze.cjs --help
```

The freezer verifies the existing reviewed sources, chunks and historical caches.
It emits exit 2 with `sourcePreparation:verified` and current-release preparation
blocked when current vectors/pools/runtime evidence is missing. Missing or
changed required source/answer evidence instead refuses with exit 1. An incomplete
manifest is useful preparation evidence, not a passing benchmark.

## Evidence boundaries

Retained Granite outputs and candidate lists must keep their original source,
model and scorer identities. They cannot be relabeled as a current released
baseline just because the questions are reused. Missing source, cache or runtime
evidence is recorded explicitly; preparation success is not permission to run a
model or a claim of evaluation readiness.

The 30 reviewed questions are an exposed regression set. Their source hashes and
complete answer spans are preserved. Repetitions are performance observations,
not additional independent questions. Private corpus bytes and detailed run
records stay in the ignored measurement directory; reusable code is separate.

## Wave 1 result

Owner integration passed 45 Node tests and 32 Python tests, plus a real
validation-only child run with host readings and verified cleanup. The frozen
bundle verifies 734 sources, 12,717 chunks and all 30 complete answer spans.
The accepted 0.26.96 archive was hashed from the existing local npm cache.

The private receipt is
`docs/measurements/colbert-backend-wave1-20261023/wave1-owner-receipt.json`.
The latest bundle is `bundle-v2/result-manifest.json` in that directory. It
correctly remains incomplete: current-release Granite document/query vectors,
exact rerank pools and model artifact identity still need separate preparation.
Runtime loading, actual device execution and real vector parity remain untested.
The preparation review history is retained in the local plan. It does not create
another approval gate. Next is the smallest real CPU/MPS comparison; full-pipeline
capture work is needed only for comparisons that actually consume those exports.

## Wave 2 corrections

The first independent review requested two corrections. Resource sampling now
continues after root exit while descendants hold the run open; post-root RSS
breaches and unavailable readings refuse and clean the owned group. Answer
coverage now requires exact complete source-span content, with source-span
hashes and matched UTF-8 byte offsets, as well as covering line coordinates.
Unrelated and truncated chunk content is refused even when cache hashes agree.
The private corrected evidence bundle is `bundle-v4/result-manifest.json` in the
measurement directory above. Its 30 spans pass the stronger content check.
The original bundle manifests retain the weaker coordinate-only evidence.

## Baseline-export and loader preparation

[BASELINE-EXPORT.md](BASELINE-EXPORT.md) describes the model-free capture API,
validator and packer. It preserves exact observed vectors, lexical ordering and
rerank payloads; valid packed material remains explicitly unqualified. Released
Searcher loading is disabled. Its rerank call does not carry chunk IDs, so a
reviewed observation hook must expose those IDs and internal scoring details
before a complete real baseline can be captured.

[RUNTIME-LOADER.md](RUNTIME-LOADER.md) describes the proposed source-pinned
PyLate/Torch constructor and forward wiring, exercised only with in-memory fake
artifacts and runtime providers. `runtime-lock.json` is an API proposal, not a
resolved dependency environment. Real loading always refuses. Actual local-file
verification, artifact/tensor values, device execution and vector parity remain
unqualified. Neither addition changes the validation-only runner or adapter.

Additional model-free checks:

```sh
node --test scripts/colbert-eval/test-baseline-export.cjs
python3 -B scripts/colbert-eval/test_runtime_loader.py
```
