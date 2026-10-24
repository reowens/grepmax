# ColBERT evaluation Wave 1 contract

Wave 1 prepares source and frozen evidence only. It does not download weights,
install a runtime, load a model, run inference, touch a production store, or
contact P3. All fixtures are model-free. Agents own distinct files in this shared
checkout; the parent owns integration and this contract. Do not commit another
agent's files or the unrelated pre-existing changes.

## Files and owners

- Parent: `contract.cjs`, `test-contract.cjs`, `upstream-mixedbread.json`, `README.md`, integration checks and
  `docs/plans/colbert-backend-evaluation.md`.
- Fixtures agent: `freeze.cjs`, `test-freeze.cjs`, and private generated evidence
  under `docs/measurements/colbert-backend-wave1-20261023/` only.
- Adapter agent: `adapter.py`, `test_adapter.py`, and `ADAPTER.md` only.
- Runner agent: `runner.cjs`, `test-runner.cjs`, and model-free fixture children
  under `fixtures/` only.

## Wire messages

All messages are one UTF-8 JSON object per line; stdout is protocol-only.
Use schemaVersion `1`, a bounded nonempty `requestId`, and an explicit operation.
Frame size limit is 4 MiB. Unknown operations, malformed fields, shape/order/
identity errors and inference requests without a later execution gate fail closed.

Input operation `validate`:

```
{
  "schemaVersion": 1,
  "requestId": "synthetic-01",
  "operation": "validate",
  "contract": {
    "modelId": "mixedbread-ai/mxbai-edge-colbert-v0-17m",
    "revision": "<40 hex>",
    "weightsSha256": "<64 hex>",
    "tokenizerSha256": "<64 hex>",
    "projectionSha256": "<64 hex>",
    "backend": "torch-cpu or torch-mps",
    "precision": "float32 or float16",
    "dimensions": 48,
    "queryMaxTokens": 32,
    "documentMaxTokens": 512,
    "preparation": "gmax-token-ids-v1",
    "normalization": "per-token-l2",
    "documentStorage": "int8-per-document-maxabs-127"
  },
  "inputs": [
    {"id":"q1","kind":"query","inputIds":[50281,50368,50282],"attentionMask":[1,1,1]}
  ]
}
```

Input order is authoritative, IDs unique, 1 to 64 inputs, integer token IDs in
0..2^31-1, masks in 0..1, equal nonzero ID/mask length bounded by the input kind.
The adapter must not add markers, expand queries or retokenize pretokenized IDs.
Validate operation returns no vectors and imports neither torch nor pylate:

```
{"schemaVersion":1,"requestId":"synthetic-01","ok":true,"operation":"validate","inferencePerformed":false,"ids":["q1"],"dimensions":48}
```

Failures use `ok:false`, `error:{code,message}`, and `inferencePerformed:false`.
No source text, weights or unrestricted stack traces in protocol errors. The
future infer operation uses the same contract plus explicit verified local
artifact location and execution permission; it is not enabled by Wave 1.

## Frozen preparation manifest

`freeze.cjs` emits its own schemaVersion-1 preparation manifest, source/question
and prepared-chunk hashes, available historical Granite/query/candidate caches
and provenance/availability states. Freeze the accepted 30-case fixture checksum
`b039ee9601f509abaaaf0f3c67b661476a4965a3df02612d1965792524b105c0`.
Never relabel historical caches as a current-release baseline or fabricate missing
dense outputs/candidate lists. Missing/changed source or incomplete required
evidence is an explicit refusal or incomplete preparation state, never success.
Freeze current-release source/artifact identity from existing accepted local
material where available; do not download a package to fill a missing artifact.

## Runner

`runner.cjs` validates a request, creates a private fresh HOME/GMAX_HOME and
working directory, and runs the adapter's validation-only operation over stdio.
No model execution mode is enabled. Its exported bounded-child primitive can be
tested with the owned synthetic fixture children (timeout, output/error limits,
resource refusal, abort and descendant cleanup). Never use a production process
as the cleanup target. Pinned baseline data cannot be written by a child.

The runner records argv, request/response hashes, CPU/RSS/disk samples with units
and limits, deadlines, child ownership and final cleanup. Refuse nonpositive or
over-budget limits and nonfinite/malformed sampling. Defaults: 6 GiB owned RSS,
512 MiB swap growth, 12 GiB experiment disk, 8 GiB host available memory,
15 GiB free disk, <=1 sample/second, <=30 minutes per cell. Model-free tests use
smaller deadlines/resource fixtures. Do not change host safety configuration.

## Adapter preparation

Implement local-artifact request validation and future runtime wiring with lazy
imports, no network fallback, explicit actual-device checks, projection loading,
token normalization, deterministic order and Gmax-compatible storage conversion.
Any unverified runtime detail is documented and must refuse; do not advertise a
working MPS model based on mocked tests. The 64-input boundary set can use
synthetic token arrays in Wave 1; real tokenizer parity awaits the model stage.

## Tests and handback

Use Node's built-in test runner for `test-*.cjs` and Python stdlib unittest for
`test_adapter.py`. No installs or inference. Tests must cover malformed requests,
token/mask/order validation, default inference refusal and the component's actual
failure boundaries. Keep tests out of Vitest's `*.test.*` filename pattern.
Return changed paths, exact checks/results, generated evidence, missing artifacts
and remaining runtime qualification. Stop at the Wave 1 boundary. No nested
agents or agents from another model; no independent-review claim in this wave.
