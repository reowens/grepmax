# ColBERT adapter preparation: Wave 1

`adapter.py` implements the parent-owned [wire contract](CONTRACT.md) for
validation and pure synthetic preparation checks. Run its focused tests with:

```sh
python3 scripts/colbert-eval/test_adapter.py
```

The default CLI takes JSONL on stdin and writes only JSONL responses on stdout:

```sh
python3 scripts/colbert-eval/adapter.py < private-validation-requests.jsonl
```

No flags enable execution. `infer`, unknown operations, execution fields, and
forged runtime qualification all refuse. A refused operation has
`inferencePerformed:false`. `load_local_runtime()` always raises
`runtime_unqualified` before imports, filesystem access, or loading. This wave
does not provide a working Torch CPU or MPS adapter, or an independent review.

## Validation boundary

Validation imports no Torch, PyLate, Transformers, tokenizer or NumPy, reads no
artifacts or source text, performs no inference, and accesses no network. Only
stdlib modules load when the Python program starts. After module import, both
object validation and frame validation also work with all imports, filesystem
opens/stats/listing, sockets and subprocess creation denied by tests.

The schema, exact keys, lowercase revision/hash syntax, 80-character ASCII
identifier syntax, 1–64 input limit, supported backend/precision declarations,
48 dimensions, and 32/512 token limits follow `contract.cjs`. Integer-valued
JSON numbers such as `1.0` have the same numeric meaning as `1` in the parent's
JavaScript validator; Python booleans are rejected. Hash validation proves
syntax and declared identity consistency only, never artifact availability or
authenticity. Declaring `torch-mps` in a validation request does not require or
demonstrate an available MPS runtime.

Frames are at most 4 MiB **including the line terminator**, as in
`contract.cjs`. The reader uses bounded reads and terminates on an oversized
frame, avoiding an unbounded discard loop. Malformed requests produce bounded
fixed errors without source contents or stack traces. Invalid/missing request
IDs become `null` on errors. Recoverable malformed lines permit later lines;
UTF-8 decoding is strict. Duplicate JSON object keys and nonstandard JSON
`NaN`/`Infinity` constants are also rejected. Duplicate keys are a deliberate
stricter parsing refusal than native `JSON.parse`; valid protocol frames are
unaffected.

## Pure helpers and exact preparation

- `validate_contract`, `validate_inputs`, `validate_request`, `decode_frame`,
  `handle_request`, `handle_frame`: declarations and bounded wire validation.
- `pad_batch`: immutable snapshots of ordered supplied token IDs/masks, right
  padding with Gmax's ID `50283` and zero attention for added positions.
- `restore_batch_rows`: exact output identity/order and `[batch,seq,48]` checks,
  finite values including padded positions, then removal of added padding only.
- `normalize_rows`: current Gmax document row L2 math, with zero norm replaced
  by one. Zero rows stay zero. Nonfinite values/overflow refuse.
- `quantize_document`: Gmax document normalization and storage conversion,
  returning flattened signed integers, one document scale, rows and dimensions.
- `check_artifact_identity`, `projection_chain_digest`,
  `check_projection_layout`, `check_actual_device`: pure consistency checks of
  supplied observations. They never inspect a model or certify the observations.
- `local_only_runtime_plan`: an inert source-derived constructor/tensor plan.
  The absolute directory syntax is checked without testing existence. Returned
  kwargs are not a verified loader or permission to execute them.

Supplied zero attention positions remain present, including all-zero masks.
There is no inferred marker, skiplist, padding-token filtering, retokenization,
sorting, truncation or extra query expansion. Only padding added by `pad_batch`
is trimmed by the output helper. Attention masking within a real model remains
unverified; synthetic shape checks cannot establish batch-invariant inference.

The quantizer mirrors the order in the read-only current
`src/lib/workers/embeddings/colbert.ts` document encoder:

1. Represent raw document output values as float32, matching ONNX output.
2. Accumulate each row's squares and divide by its L2 norm in Python double
   precision, corresponding to JavaScript Number arithmetic. Zero norm uses one.
3. Find one `maxAbs` across every normalized row **before** float32 storage;
   use `1` for an all-zero document. Store normalized values through float32,
   matching assignment into `Float32Array`.
4. Quantize those stored values with `floor((value/maxAbs)*127 + 0.5)` and clamp
   to `[-127,127]`. This matches the relevant `Math.round` behavior, including
   negative half ties; Python `round()` is not used.

The stored `scale` is `maxAbs`, **not** `maxAbs/127`. Reconstruction is
`signedInt8/127*scale`. A synthetic `[3,4,0,…]` row gives scale `0.8` and first
codes `[95,127]`; zero rows give scale `1` and zero codes. A document containing
a unit row and a normalized `[-1,sqrt(3),0,…]` row exercises the negative half
tie and produces `-63` for the latter's first code. These are numerical helper
checks, not model evidence or a cross-platform bit-equality guarantee. Norm
overflow refuses rather than silently returning broken vectors; extreme norm
underflow retains the source's zero-norm behavior.

The current query encoder uses double-number rows and a `1e-9` norm threshold;
the document encoder normalizes every nonzero norm and stores float32. The
document helper deliberately does not claim to implement query pooling or that
query threshold. Neither mean pooling nor MaxSim/cross-store ranking is
qualified here.

## Source identity and both projection heads

Primary metadata was read directly, without downloading weights or a tokenizer.
The parent retains the evidence in
[upstream-mixedbread.json](upstream-mixedbread.json). Its pinned model revision is
`592c6417c1c6687572043408ed1ae5196bce16b1`.

[`modules.json`](https://huggingface.co/mixedbread-ai/mxbai-edge-colbert-v0-17m/raw/592c6417c1c6687572043408ed1ae5196bce16b1/modules.json)
selects the ModernBERT encoder, then `1_Dense`, then `2_Dense`. The
[`1_Dense` configuration](https://huggingface.co/mixedbread-ai/mxbai-edge-colbert-v0-17m/raw/592c6417c1c6687572043408ed1ae5196bce16b1/1_Dense/config.json)
is 256→512 and the
[`2_Dense` configuration](https://huggingface.co/mixedbread-ai/mxbai-edge-colbert-v0-17m/raw/592c6417c1c6687572043408ed1ae5196bce16b1/2_Dense/config.json)
is 512→48, both identity activation with no bias. The layout checker refuses
missing, reordered or differently configured heads. It follows `modules.json`,
never the duplicate `2_Dense/2_Dense/model.safetensors` filename.

`projectionSha256` uses the parent's complete ordered chain recipe: SHA256 of
the UTF-8 compact JSON array of `[relativePath, lowercaseRawFileSha256]` pairs,
in exactly this order, without whitespace or trailing newline:

```json
[["1_Dense/config.json","fdedbe7da07dafae623a002bcde227e767b8129da964fd90a3da301e3c7f929f"],["1_Dense/model.safetensors","cbd910c4bc2a0338f58f08b4a840770b38bceda90eb1c433233cbf227121bee1"],["2_Dense/config.json","d0e3d51270eb8bef21c3f321b2848ebfc2894d5e93fde02f7f09a8c7308748f0"],["2_Dense/model.safetensors","8e724279af3acf91c20d4a4dd33c6bd272f80b02095ff969e8a3f3de6432175c"]]
```

This gives
`5e55d448ebdb0dcb824f8e8226e991deb7a072f75433bfa34ad38b6609b67e2b`.
`projection_chain_digest` reproduces it from supplied hashes with no file reads.
`modules.json` itself has a separately retained identity and is checked for the
exact chain. The expected encoder weight hash is
`63e9d246f0166ceafa8bd63ee52cb929335ca30110efdb28e7f877c7aa641ca1`.
Weight hashes are upstream metadata expectations; checkpoint bytes, tensor keys
and loaded parameter values have not been locally verified.

## Upstream preparation differs from Gmax

The pinned
[`config_sentence_transformers.json`](https://huggingface.co/mixedbread-ai/mxbai-edge-colbert-v0-17m/raw/592c6417c1c6687572043408ed1ae5196bce16b1/config_sentence_transformers.json)
declares query length 48, document length 512, prefixes `[Q] ` / `[D] `,
`attend_to_expansion_tokens:false`, `do_query_expansion:false`, and a punctuation
skiplist. Gmax's read-only `src/lib/workers/colbert-tokenizer.ts` instead creates
32-token queries with attended `[MASK]` expansion and supplies explicit markers.
Its query truncation reserves two positions before adding three framing tokens;
the existing final truncation can remove the final separator at the boundary.
This adapter preserves those prepared IDs; it does not fix that preparation.

The source-derived plan disables prefixes, expansion and skiplist, and records
Gmax's limits; the future parity route must feed exact `input_ids` and
`attention_mask` tensors directly. Calling `PyLate.encode` with upstream text
defaults would change the experiment and cannot be called backend-only parity.

## Runtime wiring that remains unqualified

The inspected primary PyLate
[`ColBERT` source](https://github.com/lightonai/pylate/blob/2ca9899261205c6b14ee54e72e716110a573fb4a/pylate/models/colbert.py)
accepts local paths, `local_files_only`, explicit device and model/tokenizer/config
kwargs. Its text encode path performs additional preprocessing/filtering.
Its constructor can synthesize a projection when absent or append one for an
overridden output dimension. The prepared kwargs omit `embedding_size`; the
layout checker requires both existing heads. The inspected source SHA256 is
`87005f68ad496abeda2275eb0024f597a0e181897abe8bdef47620f790efa19b`.
This source commit is evidence for planning, not a selected installed release.

The prepared tensor specification names `torch.int64` inputs. It intentionally
does not guess a callable pretokenized forward signature, output key, parameter
dtype setting, checkpoint state-dict key mapping, or PyLate/SentenceTransformers
release combination. No Torch or PyLate imports exist in Wave 1; a future loader
must add lazy imports behind verified local artifact and execution gates.
`local_files_only:true` and `trust_remote_code:false` are prepared at every
exposed constructor level. Their transitive behavior must still be checked
against the actual pinned runtime; kwargs alone are not network confinement.

A later authorized wave must, before enabling the public `infer` operation:

- Verify the private local artifact bytes, revision, tokenizer/config identity,
  backbone hash, ordered projection aggregate and exact checkpoint mapping;
  reject missing heads rather than accepting randomly initialized parameters.
- Pin the runtime API/version and verify a direct pretokenized forward path,
  both loaded projection tensors, requested precision and `[batch,seq,48]`
  finite outputs. Confirm normalization has not already altered the output;
  never silently normalize twice or assume an epsilon policy.
- Establish actual parameter, input and output device placement and floating
  precision. For MPS require actual availability and disabled CPU fallback, plus
  evidence that the executed operations did not fall back. Supplied string
  labels in `check_actual_device` are refusal-logic fixtures only.
- Verify batch sizes 1/8/16, real tokenizer parity, token filtering, query/document
  normalization, storage conversion, pooling, MaxSim and cross-direction stored
  vector compatibility on both hosts. Wave 1 tests contain synthetic arrays.

The released `onnx/model_int8.onnx` path represents quantized ONNX weights;
original float32/float16 PyLate weights change both runtime and precision/artifact.
Gmax's final per-document int8 storage conversion is a separate quantization
step. No claim of ONNX/FP bit equality, MPS execution, throughput, ranking quality
or existing-store compatibility follows from this preparation.

## Model-free checks performed

The stdlib invocation above passes 32 tests. Coverage includes malformed wire
fields, exact ID/mask preservation, synthetic 64-input boundaries and batches
1/8/16, dimensions, ordering, padding, zero/nonfinite vectors, deterministic
storage conversion, projection/device refusal, and the unconditional execution
gate. No real model function is called. The test process suppresses bytecode
cache writes.

Two additional in-memory Node/Python checks passed on the preparation host:

- 17 requests sent to `python3 -I -B -S adapter.py`: four supported
  backend/precision declarations validated through parent `validateResponse`,
  and 13 malformed/inference cases matched parent `validateRequest` error codes.
- 10 synthetic documents, 577 token rows total: Python scales and signed int8
  codes matched the current JavaScript normalization/Float32Array/maxabs/rounding
  loops exactly for these inputs, including all-zero and negative-half cases.

These checks generated console evidence and this written record only. They
generated no weights, tokenizer outputs, inference vectors, model measurements,
or production-store artifacts. Real tokenizer parity and runtime qualification
remain outstanding.
