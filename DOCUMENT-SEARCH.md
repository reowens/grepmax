# Existing-index document search (contract v1)

`gmax mcp --existing-index-only` serves two read-only stdio MCP tools. The exact
entry dispatch precedes the normal CLI. Server identity is
`gmax-document-search`; the 2025-06-18 initialize exchange is supported by the
current MCP SDK. Contract version is independent of package version.

Every tool returns `structuredContent` with `contractVersion: 1` and capabilities
`{existingIndexOnly: 1, queryLogging: false, watch: false, runtimeStartup: false}`.
The text content contains only the result state. No source/snippet bodies are
returned. Runlist has no gmax, model or SDK runtime dependency.

- `document_search_status({paths})` returns `state: ready`, a required positive
  safe-integer `generation`, `project: {root,store,lastIndexed}`,
  actual metadata `covered` paths, `coverage: {requested,indexed,partial}`,
  `embeddingReady`, `queryState` and index state. Readiness does not guarantee
  worker availability when the subsequent query arrives. Coverage is not a
  registry/store-wide chunk count and does not prove current source freshness.
  Covered paths retain a validated `indexedMtimeMs` where available. A missing
  sampled Markdown file reduces coverage instead of discarding other paths;
  malformed or out-of-scope paths still refuse. Counts are recomputed, and
  metadata uses a bounded field allowlist without free-form diagnostics.
- `semantic_search({query,prefixes})` returns `state: ready`, canonical `root`,
  selected `store`, required `generation`, `matches` and index state. Each pointer is
  `{path,startLine,endLine,score,hash?,hashAlgorithm?}`. Ranges are one-based full
  source ranges, converted from indexed zero-based lines. Score is
  `1/(1+max(0,cosineDistance))`, not a relevance probability.
- `hashAlgorithm: sha256-bytes` is declared only when the vector row digest agrees
  with current version-1 metadata whose digest hashes the exact indexed bytes.
  Legacy/mismatched provenance retains document-only pointers. Consumers must
  reread and authorize current source, verify the digest and map body lines before
  jumping to a section. This bridge never hashes new bytes to bless old lines.

Limits: 500 query characters, 32 explicit prefixes, 2,000 coverage paths and a
512 KiB serialized path budget, 50 vector candidates, 1 MiB transport frames and
a 10-second bridge operation deadline. The most specific registered ancestor
of the canonical checkout selects the primary store; registered spelling is
preserved for daemon/row lookups. Coverage and prefixes must resolve inside the
checkout and selected project. Secondary stores are unavailable. No candidate
refill broadens scope. Symlink targets are rechecked before pointers are returned.

Unavailable states: `unsupported_tool`, `unsupported_daemon`, `no_index`,
`index_unavailable`, `daemon_unavailable`, `store_unavailable`,
`embedding_unavailable`, `embedding_mismatch`, `host_pressure`, `busy`,
`cancelled`, `timeout`, `no_coverage`, `search_unavailable`. Envelopes contain
stable states, never raw query-bearing diagnostics. Schema/unknown-tool errors
remain standard MCP errors.

The supported bridge negotiates daemon `existingIndexOnlySearch: 1` and resource
generation. Missing, null, non-integer and changed generations refuse; Runlist
also fences status against subsequent retrieval. Private daemon commands are `documents.status` and `documents.search`;
Runlist does not call the socket API. The daemon validates roots, stores, bounds
and generation again under its shared-operation coordinator, including after
encoding and native retrieval. Paused/contained resources refuse rather than
return keyword results.

Retrieval in this first slice is **dense-only** against an already-open LanceDB
connection/table. It never invokes normal hybrid search, FTS creation, reranking,
ColBERT inference, `ensureTable`, schema evolution, index mutation or local-store
fallback. Query encoding uses a currently idle, already-warm compatible worker:
CPU requires a loaded Granite tokenizer/session; GPU requires cached positive
confirmation of the existing configured MLX model. Idle time alone does not revoke
that identity: each bounded `/embed` response revalidates model and dimensions,
and successful inference renews the normal health cache. Failure revokes restricted
eligibility until external work confirms readiness. A worker rechecks before inference;
no initialization, health polling, retry or backend fallback is allowed. Cold or
busy workers refuse immediately without queueing, spawning or scaling.

Read-only admission honors the configured host guard policy without creating locks,
reservations, pruning records or changing containment markers. Under the default
`strict` policy, existing Darwin inference requires fresh known-normal aggregate
resources and reads the existing ledger; absent ledgers are treated as empty and
corrupt or symlinked ledgers refuse. Explicit `critical-only` uses fresh OS/kernel
pressure probes without aggregate sampling or ledger access: warning/unknown
measurements remain diagnostic, while confirmed critical pressure refuses.
Containment is checked before and after sampling in either policy. This read-only
path never creates a safety latch; the daemon's safety machinery remains authoritative.
Other platforms retain the existing no-footprint-probe policy; this is not a
cross-platform native qualification claim. Markdown coverage
and returned pointers require regular files, including after symlink resolution;
a directory whose name ends in `.md` can be a prefix but never a source pointer.

Cancellation closes only the request/owned bridge. It rejects the caller and
discards late results; an already executing shared worker remains assigned until
its terminal response or exit. Caller deadlines/heartbeats cannot trigger worker
replacement or native session initialization. Idle RSS retirement and consecutive
oversized completions remain enforced, including after restricted work, without
filling the worker floor on that path. Further restricted calls then report
unavailable; ordinary work may expand under ordinary admission. Busy inference is
never interrupted by RSS retirement. The daemon's independent safety/shutdown
machinery remains authoritative.

Native retrieval receives the remaining overall deadline and holds its shared
operation until the actual native promise settles. A JavaScript timer cannot
release resources that native code still uses. Caller cancellation/bridge timeout
remains bounded and late results are discarded. If the SDK fails to settle even
after its native deadline, exclusive resource teardown stays blocked rather than
closing underneath the read; no worker/store replacement is induced to hide the
failure. Cancellation cannot interrupt an already running ONNX native call.
Global logging settings are unchanged, and this path never logs query text.

## Isolated qualification

Use `node scripts/build-document-search-candidate.cjs /absolute/new/output` to
compile/package without overwriting `dist`, installing, publishing, or invoking
lifecycle scripts. The script copies the pinned native JS runtime with provenance.
`node scripts/audit-document-search.cjs /absolute/extracted/package` exercises a
synthetic daemon and checks packaged files/import boundaries. The normal consumer
audit invokes that check against its freshly installed tarball too.

The optional Runlist fixture is
`RUNLIST_GMAX_QUALIFICATION_ENTRY=/absolute/extracted/package/dist/bin.js node --test desktop/test/semantic-gmax-contract.test.mjs`.
Fixture homes/IPC are private temporary directories; no real daemon, index,
watcher, model or grammar download is used. Reusing checkout dependencies for a
local package probe must be reported separately from fresh dependency resolution.
Installation, a shared-daemon restart, watcher recovery and live retrieval require
separate explicit actions. Source/package fixture success proves none of those.
