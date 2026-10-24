# First real Mac CPU/MPS comparison

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
batch1 was slower. The first MPS batch1 pass took 8.38 s, including cold shapes.
Two passes and fixed backend order do not establish a production speedup.

Peak sampled process-group RSS was 912.30 MiB, swap growth zero, last sampled CPU
time 20.08 s and total wall time 90.67 s. Owned-process cleanup passed without
signals. Separate Metal allocation peaks were not retained. Full raw vectors,
timings, resource samples and manifests are in the private preparation root's
`run-01/` directory; `run-01/summary.json` records the result and its limits.
