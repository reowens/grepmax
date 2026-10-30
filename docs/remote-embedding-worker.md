# Private embedding worker boundary

The selected source implementation is integrated locally. One focused fake-only
invocation passed18 cases. The single typecheck found3 diagnostics at2 locations,
corrected in `153d6f9` without rerunning tests or compilation. Final compilation
is unconfirmed; no actual Mac/Windows worker was activated.
Validation evidence (private record)
distinguishes fake coverage from runtime compatibility.
The source completion record (private record)
contains commits, bounds, operator inputs and exact validation limits.

`src/embedding-batch.ts` reads fixed bounded `embedding-input.json` and atomically
writes `embeddings.json`. It calls the executor with the prepared ONNX factory,
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

Inner/outer job identity is persisted before dispatch. Cancellation awaits owned
stop and terminal cleanup evidence; unknown custody is retained without duplicate
submission or silent local-inference fallback. P3 keeps the only store writer.
Prepared assets/ACLs, route admission and actual native/token/numeric compatibility
remain runtime/operator prerequisites, not observed failures or missing stub code.
Models cold-load per one-shot job and are reused within that job; no permanent
model service was added. No fan, memory or speed improvement is claimed.
