# Final local upgrade/discovery integration — October 29, 2026 UTC

Source/fixture/docs complete locally; no release, version bump, push, global
installation, plugin/MCP activation or P3 action. Upgrade commit
`4b414da3b2007ad1e009bd069545112786900838` is preserved. The final discovery commit
is recorded by the owner in the local commit receipt and final result.

## Selected behavior and boundaries

All sixteen discovery-owner files are included, especially the new packaged
`plugins/grepmax/hooks/repo-status.js`, typed `src/lib/utils/repo-status.ts` and
ignored-by-default `docs/plans/gmax-agent-discovery.md`. Registry metadata and an
optional bounded ping report current-repo index state separately from daemon
state and actual MCP attachment. The lightweight CLI fast path avoids full
CLI/native imports. MCP `repo_status` bypasses index-reading registered-project/
store context. Hook startup/cwd/subagent context and indexed-only semantic hints
preserve existing lease ownership; they do not attach tools or autoindex a repo.
The existing VM import stub and cheatsheet fixture comments are aligned and
included, not left pending. No fixture was executed.

AGENTS/CLAUDE now distinguish ordinary permitted semantic retrieval from test/
benchmark invocations, retaining rg for literal files/text and all explicit
query/STOP/resource/model/no-autostart restrictions. The earlier durable exact-
pin maintenance preference is preserved. No project status enters instructions.

The static integration found no new Lance API adaptation: shared discovery uses
Node built-ins/JSON and the existing ping contract, not SDK/store APIs. Manifest/
lock/generated runtime remain SDK/native0.40.0, embedded Lance13 and Python13.
The earlier58-file official SDK match is reused, not rerun. Separate custom
Rust12 native maintenance stays unchanged, not newly qualified for core13 writes.

Later platform steering identified one additional selected source fix in
`src/commands/plugin.ts`: Claude cache detection/removal now follows
`CLAUDE_CONFIG_DIR`, falling back to the previous home. The source bug is concrete;
its contribution to this thread's absent tools is unknown. This preserves
installation inventory authority and does not run any configuration mutation.
The [discovery record](../../gmax-agent-discovery.md) contains exact static host/
PATH/native-loader findings and the ready client adapter proposal. Provided
workspace context does not establish Mac GUI to Linux ACP host/user/HOME/PATH/
root/socket/config mappings. No Mac/Linux diagnosis is asserted. The managed
Claude Code plugin is not a Claude Desktop/T3 registration. Missing native/ABI
payloads can still fail full MCP startup; no import or transport smoke was run.

The external adapter remains unimplemented: bind actual execution host/user/
workspace/cwd and approved STDIO command/argv/config; consume bounded snapshots,
invalidate registry/routing changes including same-cwd updates, verify transport/
server identity, and refresh the actual provider tool catalog. Repo hints cannot
make T3 execute Claude hooks or attach an unadvertised tool. No whole-client or
cross-host integration is claimed complete.

## Exact compilation history

The earlier upgrade-only guarded compile remains at
`../lance-upgrade-20261029/typecheck-receipt.json` (0.846s); it predates discovery.

First integration attempt, before later platform steering/fix: compiler **exit0**
with no type errors; controller **exit1**, final global zero-new-swap guard refused
6,283,264bytes swap growth. Peak owned RSS345,030,656bytes, elapsed1.393s,
13,182,918,656bytes final available, no owned survivors. Global swap growth is not
attributed to the compiler. No cap was raised or service signaled. The actual
[guard-failure receipt](pre-platform-fix-typecheck-receipt.json) is retained;
this is not described as a passing guarded compilation.

The subsequent explicitly selected material config-home source fix received one
final combined compilation: `node_modules/.bin/tsc --noEmit --incremental false`,
compiler/controller **exit0**, **0.845168672s**, peak aggregate sampled owned RSS
**339,361,792bytes**, **zero new swap**, **43,484,372,992bytes** final available,
**no live owned processes**. See [final receipt](typecheck-receipt.json).
The established controller applies two CPUs/nice10,2GiB aggregate owned RSS,
180seconds, minimum8GiB available and zero swap growth, plus owned TERM/KILL
cleanup. Final admission/guards passed; no passing check was repeated for a
receipt. Hashes frozen before that final invocation still match selected source.
No product source changed afterward. Production compilation includes the
preserved unrelated working tree but does not select or validate that work.

Zero unit tests/test typechecks, hook/CLI/MCP execution, native imports/stores,
models, queries, profiles, benchmarks, audits, independent review or live host
probes. Native/read-write/transport/hook behavior remains **UNEXERCISED**.
No measured RSS, search-quality or cross-platform runtime improvement is claimed.

## Preservation and completion

Selected file/hash manifest: [selected-files.json](selected-files.json).
Commit construction uses a separate index and exact paths; owning plan/handoff
commit images contain only this integration's new section/frontmatter atop the
prior committed docs, preserving older unrelated dirty history in the working
tree. Original index entries/ITA and unrelated source are preserved. No reset,
stash, discard, worktree, broad stage or private-history push occurred.
Local frozen-input snapshots/controller/logs/commit receipt:
`/home/reoiv/.local/state/gmax-local-integration/20261029-upgrade-discovery/`.

P3 remains the previously recorded deployed0.26.108; no fresh verification.
Platform quality attempt count is still **unknown**, rankings unmeasured, and no
query budget reset/retry follows. Original Gmax cases were never queried. The
separate Table-finally cleanup remains proposed/unselected; FTS is complete and
unchanged; CPU attribution/resource history/backend experiments stay deferred.
All selected local source/fixture/doc work is complete. The external adapter is a
clearly bounded remaining client task, not a new prerequisite/approval gate or
automatically selected next implementation. Saved prompts are untouched and the
umbrella delivery plan remains active.
