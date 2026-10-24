# Released baseline export preparation

`baseline-export.cjs` contains a reusable observation API and a model-free JSONL
validator/packer. It imports Node built-ins only. It does not import Searcher,
load a runtime/model, read model/cache/store files, run inference, install
dependencies, or start/manage a daemon. No real baseline material was generated
by this implementation. Tests use synthetic observations only.

Actual release loading is disabled: `loadReleasedSearcher()` always throws
`RELEASE_LOADER_DISABLED`. There is no capture/infer CLI operation. The existing
validation protocol, Python loader, runner and product files are unchanged.

## Exact CLI

All file arguments must be absolute, normalized paths without symlink
components. Input files must be regular files. The output parent must already
exist; the output directory must be fresh.

```sh
node scripts/colbert-eval/baseline-export.cjs --help
node scripts/colbert-eval/baseline-export.cjs validate \
  --plan /private/capture-plan.json --material /private/captured-material.jsonl
node scripts/colbert-eval/baseline-export.cjs pack \
  --plan /private/capture-plan.json --material /private/captured-material.jsonl \
  --out /private/new-baseline-bundle
node --test scripts/colbert-eval/test-baseline-export.cjs
```

Help exits 0. Structurally valid preparation exits **2**, including a packed
bundle: its manifest always says `status:incomplete`, `currentRelease:false`,
`qualification:unqualified`. Invalid input exits 1, produces a bounded error on
stderr and leaves no promoted output. No flag can change qualification.
`validate` writes no files. `pack` writes `plan.json`, the byte-for-byte original
`material.jsonl`, `wire-hashes.jsonl` and `result-manifest.json`.

The packer claims an empty output directory privately, writes into a private
sibling staging directory, fsyncs files, checks the output reservation's inode,
and renames the completed directory over the owned empty reservation. It cleans
its staging/reservation on failure. Directories are mode 0700, files 0600.
This is atomic publication of an explicitly **unqualified preparation bundle**;
missing documents/questions, changed identities or malformed material cannot be
published. Missing internal observations may be retained only as explicit
manifest blockers; `requiredObservationsComplete:false` prevents interpreting
such a bundle as a complete capture. This is not an OS sandbox or protection
against a hostile process concurrently replacing ancestor directories. Parent
directory fsync/power-loss durability is not claimed.

The current ranking hook has no full ordered scoring-cohort domain or explicit
default/inapplicable-prior semantics. Even supplied ranking arrays therefore
retain `ranking-coverage-unverified` and cannot set
`requiredObservationsComplete:true`. A later reviewed hook/schema must expose
that domain; final results, rerank membership and capped diagnostics cannot
establish it. Empty structure observations contradicting known nonempty scoring
are rejected. Empty symbol additions or inapplicable priors do not themselves
prove full coverage.

## Immutable source evidence

The release source is commit
`db7643cbfa42fa30d854078b42afb46d8ab04263` (v0.26.96), with accepted archive SHA256
`9f1499e71239228284ca47de25d3fceb7bfaa95564fc6a01a0afd00e28730ade`.
Preparation source is `5df9af186a15be966a964cd0b7a9eaba50da94f9`.
The fixed 30-case fixture SHA256 is
`b039ee9601f509abaaaf0f3c67b661476a4965a3df02612d1965792524b105c0`.

These facts were inspected using `git show <release-commit>:<path>`, with no
imports or execution of release/working product code:

| Release path | Relevant observation |
| --- | --- |
| `src/lib/search/searcher.ts:184` | Constructor accepts `db` and an explicitly supplied `workerPool`; supplying the pool avoids evaluating the default `getWorkerPool()` argument. |
| `src/lib/search/searcher.ts:515` | `pool.encodeQuery(query, signal)` returns dense/query ColBERT/pooled vectors. |
| `src/lib/search/searcher.ts:614` | FTS uses `table.search(query)` and a chained `toArray`; the wrapper snapshots the entire returned lexical list before Searcher clears its copy. |
| `src/lib/search/searcher.ts:866` | `diagnosticDetails()` exposes actual gate decisions/settings. These may be copied directly; final rankings do not establish gate state. |
| `src/lib/search/searcher.ts:984` | `pool.rerank(input, signal)` receives ordered query matrix and quantized document payloads, scales and optional token IDs. It carries **no chunk IDs**. |
| `src/lib/search/diagnostics.ts` | The pointer cohort is capped at 200 post-fusion entries; it cannot reconstruct an arbitrary full ordered rerank batch or all internal weights/priors/additions. |
| `src/lib/workers/pool.ts` | `encodeQuery` and `rerank` are dependency methods; worker/process imports make importing the live module unsuitable for model-free preparation. |
| `src/lib/workers/orchestrator.ts:578` | Rerank converts query rows to float32, reconstructs quantized document rows, conditionally uses matching-length token IDs, and calls `maxSim` from `colbert-math.ts`. No implementation is copied here. |

The release Searcher bytes hash to
`fe22293abd8eeec04ec34f073cef91d4d31b21c74b4b27519835670def47ab1f`;
release `pnpm-lock.yaml` hashes to
`e581d5d1a179b30acdab6f93af914929f8e42cfe4e184da094510efbf8dd55af`.
These are pinned in `PIN`. No current external library API/version assumptions
are needed; no network requests were made. The accepted archive digest is a
supplied identity, not a new archive inspection or source/archive equivalence
claim.

## Plan schema (version 1)

`validatePlan(plan)` returns an immutable copy and requires exactly these keys:

```js
{
  schemaVersion: 1,
  baseline: { ...PIN },
  identities: {
    sourceManifestSha256, chunkManifestSha256, sourceTreeSha256,
    scorerSha256, evaluatorAdapterSha256
  },
  granite: { modelId, revision, dimensions, precision, normalization, artifacts },
  colbert: { modelId, revision, dimensions: 48, precision, normalization, artifacts },
  documents: [{ id, sourceId, sourceSha256, chunkWireSha256 }],
  questions: [{ id, query }] // exactly 30; complete frozen fixture order
}
```

Every digest is lowercase SHA256; model revisions are 40 lowercase hex
characters. `artifacts` is an ordered complete inventory of
`{path,sha256,bytes}` declarations; relative paths cannot traverse. Empty
inventories produce named artifact-identity blockers. An inventory is a
declaration, not a byte verification: the packer never opens those paths.
Granite dimensions must be 1..8192, consistent across every full document/query
vector. No truncation, normalization, precision conversion or pooling occurs.
Document/question IDs must be unique and retained in plan order.

`chunkWireSha256 = wireHash(snapshotWire(originalPreparedChunk))`; the captured
chunk must retain its original `id`, `path` and `content`, plus the complete
caller-supplied prepared metadata. No source labels/text are rewritten.
The source/chunk manifest digests must refer to the authorized complete frozen
corpus. `sourceTreeSha256` and `scorerSha256` identify separately retained source
inventories: SHA256 of canonical JSON arrays of `[releaseRelativePath,rawSha256]`
pairs, sorted by path; the scorer inventory must include Searcher, structure/
intent/preference/seed/PageRank dependencies, ANN configuration, worker scoring
and `colbert-math.ts` with its dependencies. The evaluator adapter digest is
the raw byte hash of its entry module; its complete transitive inventory and
lock equivalence remain an execution gate. The packer checks digest syntax and
header/plan agreement; it cannot prove inventory completeness or source
equivalence from a digest alone.

The plan is an externally reviewed expected inventory. It is not derived from
whatever rows happen to be captured. Creating a shortened plan is not corpus or
fixture verification. All outputs remain blocked until the actual fixture,
complete source/chunk inventories and released adapter equivalence are proved.
Historical caches, including the owner-verified bundle-v4, cannot satisfy these
current-release gates. They are not read by this command.

## Capture API

Exports: `PIN`, `LIMITS`, `LATER_EXECUTION_LIMITS`, `canonical`, `sha256`,
`snapshotWire`, `decodeWire`, `wireHash`, `validatePlan`, `validateHeader`,
`validateDocument`, `validateQuestion`, `createCapture`,
`loadReleasedSearcher`, `processMaterial`, `cli`.

The following describes later caller integration; it does **not** authorize
model execution. The API itself never creates/loads Searcher or runs a query.

```js
const { createCapture, canonical } = require('./baseline-export.cjs');
const capture = createCapture(reviewedPlan, {
  provenance: 'unverified-released-capture' // tests use 'synthetic'
});
for (const row of completePreparedChunksInPlanOrder) {
  capture.recordDocument(row.originalChunk, row.exactGraniteVector);
}
for (const question of reviewedPlan.questions) {
  const observer = capture.beginQuestion(question.id);
  // Later authorized adapter must construct the actual immutable released
  // Searcher with these dependencies, without rewriting/copying its ranker:
  const pool = observer.wrapWorkerPool(isolatedOriginalPool);
  const db = observer.wrapDatabase(isolatedOriginalDatabase);
  // releasedAdapter.createSearcher({ workerPool: pool, database: db })
  // Actual search runs diagnostics:true; response is passed unchanged below.
  // observer.observeRerankIds(ids) requires a reviewed actual-boundary hook.
  // observer.observeRanking({structureWeights, priors, symbolAdditions})
  // requires reviewed internal observation hooks; never infer these values.
  observer.finish(originalResponse);
}
// Available only after every document and all 30 questions finish successfully:
for (const row of capture.records()) {
  // Serialize to a caller-owned private capture file, one row per line:
  const line = canonical(row) + '\n';
}
// The model-free CLI validates/packs that material under the reviewed plan.
```

`recordDocument(originalChunk, exactGraniteVector)` immediately copies and
validates a full vector and exact chunk hash. It accepts documents only before
questions. Each question observer accepts one query encoding and at most one
rerank call, following the inspected release behavior; concurrent/duplicate
query encodings and duplicate/late boundary observations refuse. Pool wrappers
preserve method receiver, arguments and original return object identity. The
rerank input is copied before delegation and output copied immediately after
resolution. Original arrays/buffers/results are never mutated by observation.
Dependency exceptions propagate; they cannot produce exportable partial output.

Exporter snapshot failures are sticky across the entire capture. If released
code catches a serialization/identity/bounds failure as an ordinary dependency
error (for example its FTS fallback), `finish()`, subsequent questions and
`records()` still rethrow that original observation failure. A genuine failed
underlying FTS call remains distinguishable from a successful dependency result
that the observer could not record. Original rows/results are never substituted.
The failure latch records occurrence separately from the thrown value; `null`,
`undefined`, `false`, zero, `NaN`, empty strings and zero BigInt remain fatal.

`wrapDatabase` intercepts only `ensureTable()`/`table.search()`/chained FTS
`toArray()` to retain the exact lexical call result in original order. Other
methods are bound to their original receivers. It performs no independent
queries. Unsupported Arrow/proxy/custom values refuse rather than guessing a
serialization; a future adapter must establish a reviewed lossless observation
path for those representations.

The reusable internal hook inputs are `observeRerankIds(orderedIds)`, before
the actual rerank call, and `observeRanking({structureWeights,priors,
symbolAdditions})`, where weights/priors are ordered `{id,value}` arrays and
symbol additions are ordered IDs. These are observation hooks, not ranker
implementations. Without hooks, rerank IDs/ranking details stay null and produce
named blockers. Even supplied hooks do not qualify a real release adapter.

`finish(originalResponse)` stores the entire response, including diagnostics;
gate fields must agree with the actual observed rerank invocation. A skipped
rerank has `calls:[]` and a reason from original gate detail:
`released-gate-disabled`, `empty-candidate-pool`, `gate-unobservable` or
`skip-reason-unobservable`. No candidate list is invented for skipped rerank.
An empty response remains empty: retrieval misses are never supplemented with
answer chunks. FTS unavailability is separately retained without a candidate
list. Missing diagnostic gate/lexical/ranking observations remain named blockers.
Contradictory supplied evidence is rejected even when both gate copies agree:
invocation requires requested or activated rerank; activation requires a valid
evaluated concentration share reaching the positive threshold; an unevaluated
gate has no share. Known pooled counts and successful lexical calls must also
agree with the released invocation/FTS state. Missing facts remain unobserved.
With known pooled counts, an unrequested nonempty pool evaluates the active
concentration gate; an empty pool cannot report that evaluation.
Concentration shares must be an integer bucket ratio within the released
top-ten window. Original `stages.fusion` and/or `trace.total` determine its exact
length when supplied and must agree; a one-entry window has share 1. Known
counts must fit the document inventory and bound the pooled stage. Missing
fusion size retains `released-gate-window-unobserved`; it is not inferred from
final results or the capped diagnostic cohort.

## Material and wire representation

Material is UTF-8 JSONL with a mandatory final LF: one header, every document,
then all 30 questions. Blank frames, unknown keys at schema boundaries,
wrong/duplicate/missing IDs, order changes, changed header identity, malformed
vectors, nonfinite values, lossy typed wire values and contradictory gates
refuse. JSON parsing uses Node `JSON.parse` plus a bounded nesting/duplicate-key
check, including escaped duplicate keys. Producers should use `canonical()`.
The original raw frame digest is retained separately from the canonical value
digest.

Observation fields use `snapshotWire`/`decodeWire`: plain JSON values plus
`{$wire:'undefined'}`, `{$wire:'-0'}`, or `{$wire:<typedName>,values:[...]}`.
Supported typed names are Buffer, Float32Array, Float64Array, signed/unsigned
8/16/32-bit arrays and Uint8ClampedArray. Buffer bytes remain unsigned bytes;
Int8Array values remain signed. Number values keep JavaScript double values,
and negative zero is tagged. Reserved `$wire` keys/custom prototypes refuse.
No actual runtime tensor serialization is claimed. The round trip retains
primitive values/type/element order, not object aliasing or buffer byte offsets.

Header fields are `type`, `schemaVersion`, `planSha256`, `baseline`, `identities`,
`granite`, `colbert`, `provenance`. Documents have `type`, `id`, `sourceId`,
`sourceSha256`, `chunk`, `graniteVector`. Questions have `type`, `id`, `query`,
`encoding`, `lexical`, `gate`, `rerank`, `ranking`, `response`. Exported validators
and tests provide executable examples. Wire hashes cover exact raw JSONL
frames (including LF), canonical records, chunk/vector/encoding/lexical/gate/
ranking/response parts and each ordered rerank input/result/ID list.

Bounds: plan 16 MiB, JSONL frame 2 MiB including LF, input/capture 512 MiB,
output 768 MiB, 100,000 documents, exactly 30 questions, 1,000,000 nodes/array
elements per observation, depth 32. Reads use bounded buffers; JSONL is processed
one bounded frame at a time. Capture retains copied rows in memory with a
cumulative 512 MiB serialized bound; it is not a streaming runtime/memory
controller. Packing retains only bounded row-hash metadata in addition to the
current frame. These limits are preparation limits, not runtime qualification.

## Remaining gates

1. Verify exact released source/archive/transitive imports, dependencies/lock,
   scorer and isolated evaluator adapter equivalence. Importing the live pool
   or worker loads process/runtime infrastructure; a reviewed isolated loader
   must keep those effects behind an independently authorized execution gate.
2. Provide a reviewed observation hook carrying the exact ordered chunk IDs at
   the actual `pool.rerank` boundary and full internal structure weights/priors
   and symbol-definition additions. The existing constructor seam alone does
   not expose those fields. Never reconstruct them from bounded diagnostics or
   duplicate/text-rewrite the ranker. Until this hook is reviewed, actual release
   loading remains disabled and these observations remain blockers.
   Its full scoring domain must include defaults and inapplicable prior values
   explicitly before the ranking coverage blocker can be removed.
3. Verify the actual 30-case fixture and complete frozen source/chunk inventory,
   original document/text formatting, lexical behavior, all Granite document
   and query vectors, generation/model/tokenizer/config/weight artifacts and
   precisions against a fresh isolated export. Supplied identities and mocks
   are not verification of those bytes or behavior.
4. Pin and qualify real runtime APIs/devices, exact scorer behavior, artifact
   loading, vector parity, ordered rerank input identity, storage/tokenization
   and all cross-store compatibility. No inference/artifact/runtime evidence
   comes from this implementation.
5. Select a separate execution gate before any real execution, preserving
   6 GiB aggregate RSS, 512 MiB swap growth, 12 GiB experiment disk, at least
   8 GiB host available memory and 15 GiB free disk, 1-second sampling and a
   30-minute deadline. The constants are retained in every manifest; the
   exporter does not operate a runtime resource controller or select that gate.

The focused Node tests cover synthetic ordering, skips/gates/misses, buffers and
results mutated after observation, lexical clearing, malformed/nonfinite data,
ID coverage, missing questions/artifact identity, changed release/lock/source
identity, blocked historical provenance, path/bound failures, private atomic
publication and cleanup. They are not real-runtime, device or model evidence.
