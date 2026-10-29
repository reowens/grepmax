# Search degradation and recovery

Search reports the retrieval stages that actually failed or could not be used.
Warnings use existing execution outcomes; they do not run another health request,
inspect index statistics, load a model, or retry a stage to explain the result.

- **Full-text search unavailable:** results use vector retrieval without lexical
  matches. A missing-index message comes from the existing index-adoption failure,
  never from an empty result set. After indexing completes, the store owner may
  explicitly authorize `gmax repair --fts` to build a missing index. This command
  does not replace an existing index. For a query failure or an unknown index
  availability failure, check `gmax status --json` and have the store owner inspect
  the failure before selecting a repair.
- **Query embeddings unavailable or failed:** the search failed; there is no new
  lexical-only fallback. Check `gmax config` and `gmax status --json`, then have
  the operator restore the configured backend or resolve model compatibility.
  The message does not prescribe switching models, clearing safety stops, or
  starting a model service. An existing backend-unavailable code is distinguished
  from other embedding failures; host-safety refusals are identified separately
  and point to status and operator pressure/quarantine review.
- **Requested reranking failed:** candidate token-data loading or the rerank call
  failed. Search still fails, retaining the existing policy rather than returning
  an unreranked replacement. Check `gmax status --json` and `gmax config`; resolve
  the worker or index/model compatibility problem before retrying.
- **Reranking lacks token embeddings:** when reranking actually runs with no
  query tokens or no candidate token data, the warning identifies which input is
  missing. Results and scoring retain their existing behavior. Check the listed
  configuration/status commands; the store owner should resolve compatibility
  before planning reindexing. An automatically activated rerank is labeled
  `Automatic`, while an explicitly requested rerank is labeled `Requested`.

Reranking that was disabled, never requested/activated, or had no candidates is
not itself degradation. Zero hits alone do not establish that FTS is missing.

CLI warnings are on stderr, including `warn` records in agent mode. Successful
HTTP `/search` responses retain `results` and may add optional `warnings` using
the same existing warning channel. The HTTP-backed CLI renders those warnings
on stderr too. Older daemons/servers that omit warnings remain compatible;
malformed optional warning values are ignored rather than failing valid hits.
The existing generic lexical warning from an older daemon gets a conservative
explanation without assuming that its index is missing.

New explanations contain no query text, source content, paths, environment
values, or backend stack traces. Cancellation and sandbox refusal handling,
ranking, result membership, fallback rules, exit codes, store ownership and
scheduling remain unchanged. The hints execute no repair, restart, model load,
extra database scan, or diagnostic RPC.
