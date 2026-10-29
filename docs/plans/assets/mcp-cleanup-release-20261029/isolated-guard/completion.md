# Isolated guard and published110 handover — completed October29,2026

Published release remains[0.26.110](https://github.com/reowens/grepmax/releases/tag/v0.26.110),
source`920afc5419ea65bc314833a79b6c09600e1cc556`, archive SHA256
`1297ae0ccdafb03af3c776130e098dd91b966db6d11b84aa2c1de7e0489dc2d8`.
One original publication/workflow40860070807, no republish/version change or
compiler/pack/test/native/LLM/relevance/profile rerun in this continuation.
The36/36 fake cases remain earlier evidence; later literal fixture tightening
was not rerun. Neither native cleanup behavior nor RSS/fan/relevance gains were
measured. Later dependency/Arrow/Lance0.41 and hourly-hook work is not in110.

## Scoped guard and actual operational use

The selected durable rule now requires zero **owned-job** swap, not zero change
in P3's allocated swap slots. `scripts/guard-local-operation.py` creates one new
UUID sibling under the existing delegated memory/pids parent, verifies empty
membership and `memory.swap.max=0`, then the child transfers/verifies membership
before exec. Supervisor is outside the job and its swap is separately checked.
No shared cgroup/controller/global swap policy, cache or unrelated process changed.

TwoCPUs0/1,nice10,aggregate ownedRSS<2GiB,180s,min8GiB available, containment and
OOM/owned-cleanup guards remain. New scope current/peak/zswap/events and host
PSI/OOM/disk counters are recorded; host allocated-swap signed delta is diagnostic.
First trigger is immutable, distinct from final/cleanup samples; missing essential
visibility refuses/stops work. SIGTERM/metric-loss cleanup uses only the owned
cohort, with pidfd TERM then owned cgroup kill/drain/removal when needed.
A handover marker is accepted only by exact inode/hash plus a live cohort owner;
complete bytes/proof precede atomic publication. Foreign quarantine stays binding.

| Actual operation | Wrapper revision | Seconds | Peak sampled ownedRSS bytes | Job swap/current+peak+zswap | Cleanup |
| --- | --- | --- | --- | --- | --- |
|stage|1|3.019705|450965504|0/0/0|empty, removed|
|handover|1|10.540451|50921472|0/0/0|empty, removed|
|plugin-refresh|1|2.025290|350203904|0/0/0|empty, removed|
|registration|2|0.270300|30461952|0/0/0|empty, removed|
|mcp-metadata|2|0.521640|192143360|0/0/0|empty, removed|

All five had no firstFailure, no cleanup errors, no OOM and exit0. The first real
use was the necessary published-package stage, not a synthetic probe. Old failed
14,573,568B and160,866,304B receipts/partial stage remain unchanged as historical
failures. New stage used a new prefix and byte-checked all341published files;
exact production/optional dependency maps match109, whose working dependency
tree was retained. SDK/native0.40/Python13/separate qualified Rust12 unchanged.

Successful use covered exactR1(stage/handover/plugin) andR2(config/direct metadata)
source copies/hashes retained privately. FinalR3 improves failed-metric sample
labeling and cleanup after lost visibility; that final failure-path refinement
is source-inspected only, not rerun/fault-injection tested. No independent review,
unit/compiler/build or extra qualification gate was added. These passing ordinary
operations do not establish every failure path or cross-platform support.

## P3, plugin and selected MCP configuration

P3 was confirmed110 **ready/open/active**, PID2840070. Config/unit/store identities,
Small/CPU384/worker4, cpu.max200000/100000,weight10/nice10 preserved. Exact109rollback:
`/home/reoiv/.local/state/gmax-handover/20261029-0.26.110-isolated/previous-install`.
Owned temporary marker removed; no maintenance/index/FTS/prune/cache action.
Serving daemon intentionally remains; all owned operational cohorts are closed.
Normal Claude user plugin refresh109→110 completed in the CLI-selected
`.claude-robot` configuration; all16installed plugin payloads match published
package bytes. No live hook event test or forced active-session restart.

Selected standard Codex registration remainscommand`gmax`,args`["mcp"]`, now
only its env has`GMAX_MCP_TOOL_PROFILE=core`. Private backup is retained; parsed
comparison proves all other configuration unchanged. No global environment change.
Direct standard MCP initialize/tools-list advertised110 and exactcore8:
repo_status,list_projects,semantic_search,list_symbols,extract_symbol,code_skeleton,
trace_calls,impact_analysis. ZERO tool calls/searches/store/model operations;
transport closed. Current repo's launch context remainsnot_registered.

## Actual provider catalog remains distinct

Parent explicitly reported one actual post-config ALL_TOOLS scan:329total,
28Gmax. The owner's separate actual catalog was also329/28. Neither is core8.
No safe programmatic reconnect/catalog-refresh tool is exposed here. Remaining
activation is a **normal supported client/provider MCP reconnect consuming the
updated standard configuration**, then actual advertisement of exactly8Gmax
tools. This active parent/current provider was not killed/restarted/reset/forked,
no top-level session/model switch/T3 adapter/code was used. No invented UI path
or automatic cwd refresh/inheritance guarantee. Config/direct8 are complete;
active8 is pending normal client lifecycle, not claimed verified.

Restoring the previous selected MCP env key/value uses the private config backup
and normal client consumption; preserve any later unrelated settings. P3 rollback
is the exact109package above using the same unit and safety checks. No rollback
was needed for this successful handover. Original quality attempts remainunknown,
no retries; CPU/backend/resource-history work stays deferred. Pending prompts
untouched. No automatic next batch or profile.

Local exact source copies/controllers/logs/private config backup and reconciliation:
`/home/reoiv/.local/state/gmax-delivery/20261029-0.26.110/isolated-guard/`.
