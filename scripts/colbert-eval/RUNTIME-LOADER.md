# Pinned runtime loader preparation (mock-only)

`runtime_loader.py` prepares constructor and pretokenized forward wiring for the
original Mixedbread17M model. **Real loading and inference remain disabled.**
There is no CLI, framework import provider, on-disk artifact reader, execution
flag, or qualification issuer. `load_local_runtime(*args, **kwargs)` always
raises `AdapterError(code="runtime_unqualified")` before inspecting arguments,
importing dependencies, reading artifacts, or invoking a constructor. Missing,
forged, and truthy qualification objects cannot change that behavior.

The existing `adapter.py`, validation protocol, and `runner.cjs` are unchanged.
They do not import this new module. Ordinary module initialization imports only
stdlib modules and the inert adapter helpers. Tests reject inference dependency
imports during initialization and verify validation with imports and file opens
denied. No environment setting enables execution.

## Proposed pins and evidence

`runtime-lock.json` is a **source-pinned mock API contract**, not a resolved or
reproducible environment lock. The exact proposed versions are:

| API package | Version | Role |
| --- | --- | --- |
| torch | 2.7.0 | tensors, placement, precision, inference context |
| pylate | 1.5.1 | ColBERT constructor and Dense heads |
| sentence-transformers | 5.3.0 | inherited forward and Transformer module loading |
| transformers | 4.56.2 | ModernBERT eager/SDPA and config/model/tokenizer loading |
| safetensors | 0.6.2 | future actual checkpoint loading; header validation here is stdlib |
| huggingface-hub | 0.34.4 | future local-only resolution |
| tokenizers | 0.22.0 | constructor dependency; tokenization is bypassed |

These are real release identifiers verified against version-specific PyPI JSON
metadata. This wave does not claim they are latest, installed, successfully
resolved together, or verified at runtime. Declared requirements permit these
API pins: PyLate 1.5.1 requires SentenceTransformers exactly 5.3.0 and
Transformers >=4.41.0, <=5.3.0; ST permits Transformers >=4.41.0, <6 and
Torch >=1.11; Transformers 4.56.2 requires Hub >=0.34.0, <1,
Tokenizers >=0.22.0, <=0.23.0, and Safetensors >=0.4.3.

The lock retains URLs, observed response SHA256/byte counts, base requirements,
and available macOS wheel filenames from each API package's PyPI metadata. No
wheel, sdist, tokenizer artifact, or weight was downloaded. PyPI version JSON
can change; its retained hash identifies the observed response, not an immutable
future response. No package artifact hash has been selected or qualified.

Implementation assumptions use these immutable primary source revisions. The
lock records each source file's URL, byte count and SHA256:

- [PyLate ColBERT](https://github.com/lightonai/pylate/blob/2ca9899261205c6b14ee54e72e716110a573fb4a/pylate/models/colbert.py),
  [Dense](https://github.com/lightonai/pylate/blob/2ca9899261205c6b14ee54e72e716110a573fb4a/pylate/models/Dense.py),
  `pyproject.toml`, and `__version__.py` at
  `2ca9899261205c6b14ee54e72e716110a573fb4a`. The source identifies 1.5.1.
  Correspondence between this commit and a future selected distribution remains
  an explicit gate.
- [SentenceTransformer.forward](https://github.com/huggingface/sentence-transformers/blob/ce48ecc77f8c7ed97c8fcc3cd99fde6071206680/sentence_transformers/SentenceTransformer.py#L1179)
  and [Transformer](https://github.com/huggingface/sentence-transformers/blob/ce48ecc77f8c7ed97c8fcc3cd99fde6071206680/sentence_transformers/models/Transformer.py)
  at `ce48ecc77f8c7ed97c8fcc3cd99fde6071206680` (v5.3.0 tag target).
  `forward(features)` iterates ordered modules and returns `token_embeddings`;
  Transformer forwards input features to AutoModel. `_load_init_kwargs` merges
  top-level hub flags and explicit model/tokenizer/config kwargs.
- [ModernBERT](https://github.com/huggingface/transformers/blob/cd74917ffc3e8f84e4a886052c5ab32b7ac623cc/src/transformers/models/modernbert/modeling_modernbert.py)
  at `cd74917ffc3e8f84e4a886052c5ab32b7ac623cc` (peeled v4.56.2 tag).
  It registers eager and SDPA attention. `reference_compile=False` avoids the
  optional compiled execution branch. Availability and numerical behavior of
  either attention implementation remain untested.
- [Torch Module](https://github.com/pytorch/pytorch/blob/134179474539648ba7dee1317959529fbd0e7f89/torch/nn/modules/module.py),
  [inference_mode](https://github.com/pytorch/pytorch/blob/134179474539648ba7dee1317959529fbd0e7f89/torch/autograd/grad_mode.py),
  [MPS availability](https://github.com/pytorch/pytorch/blob/134179474539648ba7dee1317959529fbd0e7f89/torch/backends/mps/__init__.py),
  and [MPS fallback registration](https://github.com/pytorch/pytorch/blob/134179474539648ba7dee1317959529fbd0e7f89/aten/src/ATen/mps/MPSFallback.mm)
  at `134179474539648ba7dee1317959529fbd0e7f89` (v2.7.0 tag target).

Torch 2.7.0 metadata advertises macOS ARM64 wheels for Python 3.9–3.13, including
a distinct free-threaded 3.13 wheel. It lists no macOS x86_64 wheel. PyLate and
ST require Python >=3.10, so Python 3.9 is outside this proposal. No particular
host/Python/ABI/wheel combination is selected. PyLate also requires native
fast-plaid/fastkmeans/ninja and other transitive packages. Their exact resolution,
macOS support, build behavior and artifact hashes remain unresolved. The lock
retains those declared requirements without pretending to resolve them.

## Artifact and module contract

The model revision remains `592c6417c1c6687572043408ed1ae5196bce16b1`.
The existing [upstream metadata](upstream-mixedbread.json) pins backbone weight,
tokenizer and both projection identities. This wave adds small config source
reads at that exact revision: `config.json`, `modules.json`,
`config_sentence_transformers.json`, `sentence_bert_config.json`,
`special_tokens_map.json`, `tokenizer_config.json`, and both Dense configs.
The lock retains raw-file hashes, sizes, source URLs and parsed content. It does
not read the existing model/cache directories or historical measurement bundle.
The tokenizer weight/blob identities are expectations from prior metadata,
not newly verified local artifact bytes.

`verify_mock_artifacts(contract, lock, reader)` accepts only an explicit
`MemoryArtifactReader`, never an OS pathname reader. It exercises bounded
SHA256, JSON and safetensors-header checks on injected synthetic bytes:

- Require the exact twelve manifest paths; reject path traversal, absolute or
  backslash paths, missing files and unlisted reader files.
- Require every supplied root/relative ancestor observation to be a directory,
  every file regular, link count one, and before/after identity, size, mtime and
  ctime stamps unchanged. Symlink, hardlink and mutation observations refuse.
- Hash in chunks <=64 KiB, with <=70 MiB per file and <=80 MiB total. JSON
  configs are <=32 KiB and checkpoint headers <=64 KiB. Reject duplicate JSON
  keys, nonfinite constants, bad offsets, gaps, overlaps, truncation and trailing
  tensor payload bytes. The tokenizer is hashed without retokenization.
- Require complete source-observed ModernBERT 256-hidden configuration and
  ordered `0` encoder, `1_Dense`, `2_Dense` module declarations. Recompute the
  adapter's ordered four-file projection-chain hash.
- Require original F32 checkpoint headers. Map backbone tensor names with
  `0.auto_model.` prefix, then exactly `1.linear.weight:[512,256]` and
  `2.linear.weight:[48,512]`. Both heads have Identity activation, no bias and
  no residual. The nested `2_Dense/2_Dense` file is never a third head.

The loader compares the complete injected model state key/shape set to those
headers, rejecting added, missing or reordered modules/parameters. Unexpected
persistent buffers also refuse until their mapping is reviewed. Hashes protect
bytes, but this wave does not establish that a real constructor loaded every
checkpoint value correctly. No real checkpoint header was read. Actual tensor
key/value mapping remains a later gate.

`MemoryArtifact.regular(path, bytes)` creates a synthetic regular-file fixture.
Other `MemoryArtifact` observations can exercise failure paths. Such observations
cannot attest to a real filesystem. A future secure OS reader needs separate
review, no-follow component handling, stable descriptor identity and protection
against changes between verification and constructor reads. A caller's supplied
stamp is insufficient evidence. There is no on-disk loading implementation here.

## Mock constructor and forward APIs

`load_mock_runtime(contract, *, lock, reader, provider, local_directory,
attention="eager") -> MockRuntime` is explicitly a trusted test hook. The provider
must be a `MockRuntimeProvider` containing stdlib `unittest.mock.Mock` Torch,
PyLate and cleanup objects, plus the exact API version observations. Actual
module objects are refused. Injected Python callbacks are trusted test code;
this is not a sandbox against arbitrary in-process Python execution.

Constructor kwargs use the canonical synthetic absolute directory,
`local_files_only=True`, `trust_remote_code=False`, explicit CPU/MPS placement,
32/512 query/document limits, empty prefixes and skiplist, no query expansion,
attended supplied expansion positions, and `truncation=False`. Model, tokenizer
and config kwargs each carry local-only flags. The model kwargs select only
`eager` or `sdpa` attention and `torch_dtype`; config kwargs force
`reference_compile=False`. `embedding_size` is absent so the prepared wiring
cannot request an extra randomly initialized projection. `.to(device=...,
dtype=...)` and `.eval()` follow construction, then placement, dtype and the
complete module/state layout are checked. This remains a tested mock API
contract; kwargs alone are not evidence that a real constructor succeeds.

`MockRuntime.forward_raw(inputs, *, output_ids)` snapshots validated Gmax IDs
and masks, right-pads using ID 50283/mask zero, creates exact int64 input tensors
on the requested device, checks their shape/dtype/device/contents and calls
`model.forward(features)` under `torch.inference_mode()`. It never calls
`encode` or `tokenize`, passes text, expands queries, filters punctuation or mask
positions, sorts, pools, normalizes, quantizes, truncates or splits batches.
PyLate's constructor changes its tokenizer padding ID to the mask ID; this
forward path bypasses that tokenizer and uses the adapter's padding explicitly.

The full input list forms one batch, maximum 64 items; no separate batching
argument is silently accepted. Returned `input_ids` and `attention_mask` must
remain unchanged. Parameter placement/precision is checked again for every
call; input tensors must be int64, and output tensors must have the requested
floating precision/device and exact `[batch,sequence,48]` shape. All output
positions, including added padding, must be finite. Only adapter-added padding
is removed. Supplied zero-mask positions remain present. Output extraction
copies to CPU only after output placement checks.

`output_ids` is a mandatory ordered caller assertion checked against the
input batch. It cannot prove that a buggy model permuted vectors internally;
real forward/batch parity must establish semantic row correspondence. The
synthetic provider emits token-dependent rows so tests check actual mock row
order, in addition to metadata and shape.

Raw vectors are returned as immutable rows. Apply existing
`adapter.quantize_document(rows)` separately for document storage; query numeric
conversion/pooling/export parity is a separate gate. The original FP model and
released ONNX-int8 model use different weight artifacts/precision. Shared final
int8 storage conversion does not establish cross-store compatibility.

MPS mocks require actual injected parameter/input/output observations on MPS,
`is_available() is True`, and an explicit captured
`PYTORCH_ENABLE_MPS_FALLBACK="0"` observation, checked at load and forward.
CPU fallback or wrong dtype refuses. **That environment flag is insufficient
for a real no-fallback claim:** the pinned Torch source also registers some
unconditional CPU fallbacks. Device labels alone cannot prove operation-level
GPU execution. No real CPU/MPS precision combination is qualified; the 2×2 mock
precision matrix tests refusal logic only.

`MockRuntime.close()` drops its model reference and invokes the injected cleanup
hook once. It supports `with`; constructor, placement, shape, numeric and
forward failures invoke cleanup. A constructor exception invokes
`cleanup(None)` to signal partial allocations owned by the provider. The hook
is no evidence about real device allocator release, resource containment or
cleanup of an actual runtime. No daemon or process settings are changed.

## Exact mock-only usage and checks

Run the focused checks with Python stdlib; no dependency installation is needed:

```sh
python3 -B scripts/colbert-eval/test_runtime_loader.py
python3 -B scripts/colbert-eval/test_adapter.py
node --test scripts/colbert-eval/test-contract.cjs scripts/colbert-eval/test-integration.cjs
```

To inspect the reusable API using the test's explicitly synthetic fixtures:

```sh
PYTHONPATH=scripts/colbert-eval python3 -B - <<'PY'
from runtime_loader import MemoryArtifactReader, load_mock_runtime
from test_runtime_loader import synthetic_bundle, FakeModel, fake_provider
lock, records, contract = synthetic_bundle()  # replaces real digests with toy bytes
inputs = [{"id": "d1", "kind": "document", "inputIds": [7, 8], "attentionMask": [1, 0]}]
with load_mock_runtime(contract, lock=lock, reader=MemoryArtifactReader(records),
                       provider=fake_provider(FakeModel()),
                       local_directory="/synthetic/artifacts") as runtime:
    rows = runtime.forward_raw(inputs, output_ids=["d1"])
    assert len(rows[0]) == 2
    assert runtime.runtime_qualified is False
PY
```

The focused suite contains 38 tests, including a fresh `python -I -B -S` import
and validation check. It covers missing/forged qualification; dependency drift;
missing/mutated/wrong weight, projection and tokenizer identities; traversal and
symlink observations; checkpoint/header/module/state errors; actual injected
input/parameter/output placement and dtype errors; MPS CPU fallback; order,
32/512 bounds, batch sizes 1/8/16/64, preserved zero masks, ragged/filtered/nonfinite
outputs, and failure cleanup. These are **mock evidence only**.

## Remaining execution and export gates

Follow the repository [review and verification budget](../../AGENTS.md#review-and-verification-budget).
Finishing this loader does not automatically require another independent review
or fresh approval for work already authorized. Real loading remains unimplemented
here; neither this source nor `runtime-lock.json` proves runtime qualification.
Complete only the following work needed for the selected bounded run:

1. Resolve all transitive dependencies for each exact target platform/Python/ABI;
   select and hash all distributions; verify source-to-distribution correspondence
   and native dependency availability without hidden build/runtime downloads.
2. Obtain the original model artifacts for the selected run,
   verify every raw byte and tokenizer/config identity, build the reviewed OS
   reader, and verify checkpoint header/key/shape/value loading without random
   initialization, hidden files, symlinks or verification/load races.
3. Qualify real eager/SDPA pretokenized forward, exact masks and order, batch
   1/8/16 behavior, raw48-dimensional vectors, requested precision and actual
   CPU/MPS execution. Establish operation-level fallback and real cleanup/resource
   evidence. Local-only flags are not OS filesystem or network confinement.
4. Separately establish tokenizer parity with Gmax's authoritative query32 and
   document512 preparation. Upstream query48/default filtering is a different
   experiment. Verify normalization, document conversion, query math, pooling,
   MaxSim, both cross-store directions and any exported artifact identities.
5. Select the later resource/execution gate with the preserved ceilings:
   6 GiB aggregate RSS, 512 MiB swap growth, 12 GiB experiment disk,
   8 GiB available host memory, 15 GiB free disk, 1-second sampling and
   30 minutes maximum per cell. No execution gate is selected now.

Accepted baseline source is v0.26.96 at
`db7643cbfa42fa30d854078b42afb46d8ab04263`; accepted archive SHA256 is
`9f1499e71239228284ca47de25d3fceb7bfaa95564fc6a01a0afd00e28730ade`.
Its document token/padding/numeric behavior was read with `git show`, without
using dirty product files. Preparation source is
`5df9af186a15be966a964cd0b7a9eaba50da94f9`; relevant existing adapter/contracts
match it. No historical cache was reread/copied, no bundle-v4 result was relabeled
as current output, and no independent acceptance is claimed here.
