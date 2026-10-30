# Private embedding worker boundary

Implementation is still in progress. This is source documentation, not evidence
of an activated Mac/Windows worker or model compatibility.

`src/embedding-batch.ts` now reads only the fixed bounded job input/output,
validates the worker-local prepared manifest and invokes the bounded executor
with `createPreparedOnnxRuntime`. The factory verifies artifacts, sets offline
flags before dynamic model imports, disables transformer filesystem caching,
uses the explicit prepared model root and awaits owned session disposal.
Its caller must supply actual admitted job containment and trusted local roots.
No embedding request chooses cache paths or executable instructions.

The entry environment is fixed by the Platform task adapter:
`GMAX_EMBED_MANIFEST`, `GMAX_EMBED_MODELS_ROOT`,
`GMAX_EMBED_RUNTIME_ROOT`, `GMAX_EMBED_RUNTIME_COMMIT` and optional
`GMAX_EMBED_DEPENDENCIES_ROOT`. Input is `embedding-input.json`; output is
`embeddings.json` in the same owned job directory. Output is atomic and bounded.
Metadata describes source requirements, not observed host readiness.

The P3 sender uses its Linux operational guard and the existing fixed Platform
bridge; that Linux guard is not a Mac/Windows cgroup requirement. Existing
Windows native task and Mac owned-process mechanisms are being extended by the
worker owner, including cancellation-to-owned-stop and terminal/drain evidence.
There is no generic shell endpoint or new model service. No roster was changed.

The original available:false/exit75 foundations were source stubs, not observed
host failures. Real factory/entry/sender wiring is now present; final packet,
resource, dependency-link and terminal-custody integration remains unfinished.
See exact source continuation (private record)
for file ownership and commits. All fixture source and native code is unexecuted
and uncompiled under the selected budget. No fan/performance result is claimed.
