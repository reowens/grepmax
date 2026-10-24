# Mac ColBERT backend experiments

The selected run uses original Mixedbread17M FP32 weights through PyLate on this
Mac, first CPU and then MPS. It does not use the unfinished baseline exporter,
change Gmax's configured model, access an index, or start a service.

Prepared local root:
`docs/measurements/colbert-mac-smoke-20261023/`

- Python 3.12.15, 63 resolved packages installed from hash-locked binary
  distributions. `requirements.lock` in that private root is the resolved host
  environment; the older `runtime-lock.json` remains a source/API proposal.
- Torch 2.7.0, PyLate 1.5.1, SentenceTransformers 5.3.0, Transformers 4.56.2.
- All 12 original model files match pinned hashes: 71,426,747 bytes total,
  revision `592c6417c1c6687572043408ed1ae5196bce16b1`.
- 64 frozen inputs: 32 queries and 32 documents including empty text, Unicode,
  code and long inputs. IDs/masks come directly from Gmax's unchanged released
  tokenizer; queries are 32 tokens and documents span 3–512 tokens. Python does
  not retokenize them.

Run from the repository root when execution is selected:

```sh
node scripts/colbert-eval/mac-smoke.cjs --execute \
  --root <gmax-checkout>/docs/measurements/colbert-mac-smoke-20261023
```

The command uses the existing owned-process runner: 30-minute execution limit,
6 GiB aggregate RSS, 512 MiB swap growth, 12 GiB experiment disk, at least 8 GiB
available memory and 15 GiB free disk, normal memory pressure, one-second samples
and checked process-group cleanup. Prepared runtime/model/cache allocation is
snapshotted once; fresh output/cache allocation is sampled live. Missing readings
or pressure refuse admission. It does not retry or change host policy.

The experiment verifies actual loaded parameter values against all three weight
files, including both Dense heads. CPU uses one thread. Each backend warms up
once, then runs two passes at batch sizes 1, 8 and 16. Raw 48-dimensional token
outputs must be finite, preserve effective rows, and reach cosine >=0.999 against
the CPU batch-1 reference. All token arrays and per-case parity/timings are saved
inside the fresh run root named by the controller. Timing order is CPU then MPS;
this first screen is not a paired production speed or ranking result.
Only a single input is used for warm-up; first encounters with new batch/sequence
shapes can include compilation overhead in their timings.

The readiness-only mode verifies files and imports the runtime without
constructing a model. The sole preparation readiness attempt refused with
`RESOURCE_MEMORY_PRESSURE` before Python startup. Its manifest is retained as
`readiness-manifest.json` in the private preparation root. No model was loaded,
and runtime imports/constructor/forward behavior were unverified at that point.
The actual command repeats admission once when selected; continuing pressure
will refuse again. No polling or additional preparation review is required.

This checks raw original-weight CPU/MPS behavior. ONNX-int8 compatibility,
operation-level CPU fallback profiling, storage/pooling/MaxSim parity, ranking
quality and P3 remain later work. Device checks and fallback=0 alone do not prove
every internal operation ran on MPS. Metal memory shares system memory and is
reported without adding the same allocation twice.

## Current conclusion and next step

The fully warmed paired comparison completed: document batch16 MPS was
6.53–6.66× faster than deployed ONNX CPU in both orders. Batch1 queries were
6.65–8.79× slower on MPS. Keep query encoding on ONNX. Document batching is worth
a saved-vector compatibility check before any production integration.

The host was active: Swift compilation, simulator, host-project and Gmax activity were
observed. This is evidence of a repeatable document batching gain within this run,
not an idle-host or production throughput guarantee. Earlier fixed-order timing
claims remain provisional; background load was not recorded during those runs.

The saved-output storage/scoring check is also complete (below). Next: compare
correct-answer retrieval on the existing frozen 30-question code/document set,
using ONNX queries with MPS documents versus ONNX documents. Count lost/found
targets and report Recall@10/MRR@10 before selecting integration. No new labels,
exporter hardening or independent review is needed for that screening experiment.
Deployed model, settings, services and indexes remain unchanged.

## Saved-output storage and scoring check

`node scripts/colbert-eval/saved-compat.cjs <private-root>` replays released
`v0.26.96` document normalization, int8 conversion, mean pooling, query
normalization and MaxSim/rerank arithmetic against the saved outputs. Model
session results are supplied from files; constructors/loads and tokenizer
initialization are bypassed. The model constructor's unused TS parameter-property
modifier is removed for Node strip-only parsing; the arithmetic is retained.
The skiplist is frozen from the installed model, with source/vector/input hashes
retained. No model inference, store access or production change occurs.

All 32 MPS documents preserved token alignment and finite outputs, passed signed
int8 byte round-trip checks, and scored with all 32 unchanged ONNX batch1 queries:
1,024 query/document pairs per configuration. Two saved MPS batch16 passes produced
identical stored scores, as did the two ONNX batch16 controls.

| Compared with ONNX document batch16 pass1 | ONNX batch1 | MPS batch16 |
|---|---:|---:|
| Mean absolute MaxSim difference | 0.00195 | 0.02434 |
| Maximum absolute MaxSim difference | 0.05015 | 0.08849 |
| Queries with a changed first result | 0 / 32 | 12 / 32 |
| Mean top-five overlap | 100% | 91.875% |
| Minimum pooled-vector cosine | 0.99999954 | 0.99995186 |

MPS changed an average 34.29% of int8 components per document relative to ONNX;
this counts differing integer components, not percentage vector error. Its two
passes agreed exactly. Winner changes are between repeated variants of the same
synthetic text, with baseline score gaps no greater than 0.03031. They have
different token sequences. The sample contains 25 distinct document tokenizations
and has no relevance labels. These results demonstrate format/scorer operation
and measurable numerical/rank drift; they do not establish retrieval quality,
database/ANN behavior, or safe index mixing on real projects.

Private evidence: `saved-compat/result.json` and `summary.json` under the prepared
root, including all scores, changed winners, inversion details and hashes.
The first replay attempt stopped before arithmetic because this Node build
supports TS strip mode only; the owner corrected the inert constructor handling
and completed the replay. No test suite or reviewer was added.

## Fully warmed paired comparison

Selected command: `--compare-paired --root <same-root>`. Both sessions stay loaded.
Every query/document batch/sequence shape receives a full warm-up traversal before
measurements. Each measurement repeats the same 32 inputs five times, excluding
output-file writes and host snapshots. Pass1 uses ONNX→MPS for each pair; pass2
uses MPS→ONNX. Timings include input preparation, forward, validation and CPU
output copy. Raw outputs retain the last traversal of each measurement.

Seconds per 32-input traversal, shown as pass1 / pass2:

| Inputs | Batch | ONNX CPU | MPS | ONNX time / MPS time |
|---|---:|---:|---:|---:|
| Queries | 1 | 0.0561 / 0.0491 | 0.4931 / 0.3263 | 0.114 / 0.150 |
| Queries | 8 | 0.0653 / 0.0461 | 0.0987 / 0.0374 | 0.662 / 1.233 |
| Queries | 16 | 0.0406 / 0.0367 | 0.0567 / 0.0212 | 0.716 / 1.735 |
| Documents | 1 | 0.3872 / 0.3494 | 0.9816 / 0.7249 | 0.395 / 0.482 |
| Documents | 8 | 0.4980 / 0.4948 | 0.1225 / 0.0852 | 4.064 / 5.810 |
| Documents | 16 | 0.5052 / 0.4855 | 0.0759 / 0.0744 | 6.659 / 6.529 |

All 24 measurements completed in 55.44s. Peak sampled owned RSS was 1,939.81MiB,
swap growth zero, and checked cleanup found no live owned processes without
signals. Resource ceilings were unchanged. Minimum matched token cosine against
the different ONNX-int8 artifact was 0.99091131, with no zero-vector disagreement;
this is not storage/scoring or ranking acceptance.

Boundary snapshots retain top process CPU/RSS and whole-device GPU readings
(0–89% utilization, including experiment activity). `ps` CPU percentages are
decaying process averages; boundary snapshots cannot prove quiet intervals or
attribute GPU use. The parent retains its usual one-second resource samples.
No other processes were stopped. The installed ONNX runtime was 1.30.0 from
Gmax 0.26.96, using the same pinned private graph and released session settings.
Full vectors, measurements, host snapshots, source hashes and cleanup evidence
are retained under the private preparation root's `run-03/` directory.

## First execution result

The user subsequently selected execution. Admission passed; all 12 passes over
64 frozen inputs completed with minimum token cosine 0.9999999999990468.
Actual loaded parameters matched the original backbone and both projections.

| Batch | CPU seconds | MPS seconds |
|---|---:|---:|
| 1 | 0.633 | 2.616 |
| 8 | 0.512 | 0.487 |
| 16 | 0.553 | 0.359 |

These are second-pass totals for 64 inputs. Batch16 MPS was about 1.54× faster;
batch 1 was slower. The first MPS batch 1 pass took 8.38 s, including cold shapes.
Two passes and fixed backend order do not establish a production speedup.

Peak sampled process-group RSS was 912.30 MiB, swap growth zero, last sampled CPU
time 20.08 s and total wall time 90.67 s. Owned-process cleanup passed without
signals. Separate Metal allocation peaks were not retained. Full raw vectors,
timings, resource samples and manifests are in the private preparation root's
`run-01/` directory; `run-01/summary.json` records the result and its limits.

## ONNX CPU comparison

`--compare-onnx --root <same-root>` runs the installed ONNX-int8 CPU artifact
first and original-FP32 MPS second under the same bounded controller. The ONNX
child inherits the owned process group and uses the installed Gmax runtime and
released one-thread session settings. It reads only the private model copy.
Both arms consume the frozen IDs/masks, trim added padding and save raw vectors.
Different weight precision is reported as a comparison, not a same-weight pass.

The selected run completed all 12 passes. Second-pass totals for 64 inputs:

| Batch | ONNX CPU seconds | MPS seconds |
|---|---:|---:|
| 1 | 0.499 | 1.597 |
| 8 | 0.611 | 0.123 |
| 16 | 0.653 | 0.087 |

Warm batch 16 MPS was 7.49× faster in this run; batch 1 was 3.20× slower. Timed
batch 16 CPU use was 0.532 CPU-seconds for ONNX versus 0.066 for MPS. Peak sampled
RSS was 1,273.66 MiB, swap growth zero, wall time 23.97 s, and cleanup passed.

Mean matched token cosine was 0.99990666 and worst 0.99091131. Document minimum
was 0.99969095; query minimum 0.99091131. No zero-vector disagreements occurred.
This does not establish int8 storage, pooling/MaxSim, ranking or cross-store
compatibility. Keep the deployed encoder unchanged. Establish repeatable timings
first; document batching is then the candidate for a saved-vector compatibility
follow-up before integration.

Two passes, fixed backend order and uncontrolled host/cache effects limit speed
claims: earlier batch 16 MPS took 0.359 s, versus 0.087 s here. The 7.49× figure is
an observation, not a production guarantee. Full evidence is in `run-02/` under
the private preparation root. No installed model, settings, service or index was
changed.
