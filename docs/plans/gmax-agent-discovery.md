# Gmax agent discovery and current-repo status

Implementation note, 2026-10-29. This is the focused discovery record; the
delivery/upgrade owners retain their shared plans and instruction files.

**Final owner integration complete locally.** Durable guidance is integrated in
AGENTS/CLAUDE, all selected discovery files and the config-home fix are included.
The final combined guarded production compilation passed; the earlier
pre-platform-fix swap-guard refusal is retained separately.
[Exact integration and execution record](assets/local-integration-20261029/completion.md).
No runtime/native/host/client activation was exercised.

## Evidence and causal chain

The implementation agent's advertised catalog contained 301 entries and no name
or description matching `gmax` or `grepmax`. This proves absence of an advertised
Gmax tool in this thread only. It does not establish binary/service absence or
the tool catalogs of other clients. No searches or live service probes were run
for this work.

The repo's Claude plugin declares hooks, commands and skills but no bundled MCP
server. `install-claude-code` installs that plugin. `install-codex` separately
registers `gmax mcp` using the Codex CLI; that registration does not prove that
T3, Claude, another provider or an already-running session attaches it. Npm
postinstall deliberately avoids changing user-home client configuration.

Previously SessionStart unconditionally said `gmax ready` and emitted a generic
CLI survey, regardless of current-repo registration. CwdChanged and activity
maintained watch leases without availability context. SubagentStart treated any
path prefix in the registry as indexed, used the process cwd instead of the
event cwd, and did not distinguish pending/error/legacy metadata. Pre-Grep hints
did not check registration. The MCP semantic-search description also explicitly
preferred CLI use. A hook watch lease demonstrates watch ownership, not search
use, tool advertisement or current-repo index readiness.

Parent-supplied retained evidence: Gmax itself is not registered; Platform is a
separate canonical root, not its ancestor/alias. The original expected Gmax
queries never ran. The corrected Platform attempt stopped at the host memory
guard; rankings were not retained and attempt count is unknown. None of those
facts were remeasured here, and this change makes no ranking/performance claim.

## Local implementation

`plugins/grepmax/hooks/repo-status.js` is the shared, dependency-free discovery
implementation; `src/lib/utils/repo-status.ts` supplies types for compiled callers.
The existing npm payload already includes `plugins/`, so hooks and compiled
consumers use the same code without a second registry interpretation.

- Read only bounded `stores.json` routing and the selected `projects.json`
  metadata (1 MiB per file). Choose the deepest registered containing root using
  canonical paths and path-component containment, never another sibling project.
  Report both the nearest repo root and matched registered scope, including
  umbrella projects. Invalid/unreadable metadata is not `not_registered`.
- Preserve `indexed`, `pending`, `error`, `legacy_unknown`, unavailable and unknown
  states. Counts are cached; metadata cannot establish freshness or embedding
  compatibility. Missing secondary-store storage is `store_unavailable`.
- For a matched primary-store project, permit one read-only ping, capped at
  400 ms and a 16 KiB response. Distinguish offline, denied/unavailable,
  initializing, paused, ready and legacy-unknown daemons. No ping is needed to
  establish that the current repo is unregistered. Secondary-store daemon state
  stays unobserved because those stores intentionally have no resident daemon.
- No native table, vector count query, LMDB access, model, filesystem scan,
  watch lease, daemon launch, retry timer or background process is added by
  discovery. Ancestor/root metadata lookups are the only directory traversal.
  Existing SessionStart/CwdChanged/activity lease lifecycle remains separate.
- SessionStart, CwdChanged and SubagentStart now emit current-repo context.
  Pre-Grep semantic hints require an explicitly indexed current project.
  Context presents a CLI suggestion separately from MCP availability, and never
  asserts that a tool absent from the client's catalog is callable.
- `gmax status --current [--cwd <directory>] [--json|--agent]` takes a fast entry
  path before the full CLI registry/native imports. Ordinary all-project status
  also includes current-repo context (`currentProject` in JSON). The plugin's
  status command uses the bounded current-repo path.
- Full `gmax mcp` now exposes `repo_status({cwd?})`, including unregistered roots.
  It bypasses the index tools' registered-project/store wrapper and never searches
  or opens the store. MCP initialization instructions include the launch repo's
  cached setup state; `index_status` identifies its current repo and directs
  lightweight setup questions to `repo_status`. Semantic-search descriptions no
  longer direct an attached MCP client away from its available tool.
- Installer text and plugin skill/reference guidance distinguish CLI hints,
  actual client registration and current-repo readiness.

No registration, client configuration, plugin activation or service state was
changed. The dedicated `gmax mcp --existing-index-only` document bridge retains
its separate narrow contract; this work does not attach it or expand its tools.

## Example context (illustrative, not executed)

For a registry entry with `status: indexed` at `/repos/platform`, a session in
`/repos/platform/src` gets `index=indexed`, `matchedRoot="/repos/platform"`, cached
count evidence and a scoped CLI suggestion. Daemon state is independent: a
readable indexed registry plus an absent daemon reports `daemon=offline`, not
`not_registered` or guaranteed search readiness. The hint says to use an
advertised Gmax semantic-search tool when present, otherwise suggests the CLI
conditionally on its executable being available and retrieval being permitted.

For `/repos/gmax` with only `/repos/platform` registered, context is:

```text
Gmax current repo: "/repos/gmax"; index=not_registered; matchedRoot=null; daemon=unobserved.
Gmax is not set up for this repo. Other registered projects do not cover it; do not silently search another project. Adding/indexing requires separate authorization.
MCP attachment is client-owned: use a Gmax tool only if it is advertised in your actual tool catalog. This hook/CLI hint does not register an MCP server.
```

The not-registered result requires no search and does not replace the daemon's
other-project status with a claim that the daemon itself is absent.

## Concrete client/T3 adapter proposal

Gmax can expose metadata, context hooks and an MCP catalog; it cannot inject a
server into an unrelated client's provider tool catalog. T3/client integration
is required for automatic availability in clients that do not run these hooks.
No T3 hook/config contract or MCP-registration API was exposed in this thread's
catalog, so no other repository or user configuration was edited.

The client-owned adapter should:

1. At thread/workspace attachment and accepted cwd changes, obtain a snapshot
   with argv `gmax`, `status`, `--current`, `--cwd`, the actual workspace/cwd,
   `--json`. Consume `schemaVersion: 1`, `repoRoot`, `matchedRoot`, `indexState`,
   `cachedChunks`, `daemon.state`, `storeHome` and `mcp` separately. Use argv,
   not an interpolated shell command. Invalidate on selected registry/routing
   metadata changes; coalesce events rather than polling or asking the model to
   run a check before every task.
2. Display/inject current-repo status even for `not_registered` or metadata
   errors. A running daemon or registration for another project cannot override
   this state. Never register/index the repo as a discovery side effect.
3. Consult the client's actual approved MCP configuration and active tool
   catalog. For a trusted, enabled Gmax STDIO registration, attach `gmax mcp` in
   the thread's correct workspace, verify the connected server identity and
   advertised `repo_status`/`semantic_search` tools, and refresh the provider
   catalog through its supported lifecycle. Keep this thread/workspace binding
   explicit; a global service cwd is not a safe substitute.
4. Suggest semantic retrieval when the repo is indexed and the tool is actually
   attached. Otherwise label attachment missing/disabled/error independently
   from index state; provide a concrete registration/setup action through the
   client's existing trust flow. A textual CLI hint must not set `toolAvailable`.
5. After cwd changes, rebind the MCP connection or pass the verified matched
   registered root explicitly to scoped queries. Cross-project fallback remains
   opt-in. Keep the status surface available when no search tool is attached.

The repo-owned hooks refresh on supported startup/cwd/subagent events; they
cannot make T3 run Claude hooks. Same-cwd registry mutations are visible to an
explicit status request or next applicable context event. Fully automatic
mid-session registry-change propagation and dynamic tool attachment require the
client adapter above. This is a partial implementation of the cross-client goal,
not a claim that Gmax has appeared in this thread's catalog.

## Targeted macOS/Linux configuration check — integration owner

Static source/config inspection found one concrete repository bug, now fixed in
`src/commands/plugin.ts`: Claude plugin cache detection and removal assumed
`~/.claude` even when `CLAUDE_CONFIG_DIR` selected another configuration home.
Both now resolve that variable before falling back to `os.homedir()/.claude`.
The existing Claude installer delegates account/config selection to the Claude
CLI; this aligns the plugin manager's local cache operations with that intent.
This affects custom-home setups on either OS; it is not proof of this thread's
missing MCP catalog or a Mac-versus-Linux-specific failure. No client/cache
operation was executed and no user configuration was modified.

The selected discovery helper has no Darwin-only branch or Homebrew path:
Node `path`, `realpathSync`, `path.relative` component containment and the deepest
registered ancestor determine scope; both registered roots and cwd are
canonicalized. No unconditional lowercase transformation assumes a filesystem's
case behavior. `GMAX_HOME` selects store metadata, otherwise `os.homedir()/.gmax`
does; secondary routing comes from that host's `stores.json`. These are local
host/user paths, not a cross-host registry or socket protocol.

Claude hooks launch `node` through the receiving client's PATH and use quoted
`CLAUDE_PLUGIN_ROOT`; Codex registers bare `gmax mcp` in the invoking Codex
configuration and follows `CODEX_HOME` for instructions. Neither hardcodes a
Darwin-only executable. A GUI's PATH may differ from the shell/ACP host's PATH;
that possibility was not measured. The repository's managed client list has
Claude Code, not a Claude Desktop installer/config writer. No missing Linux
Desktop config location is inferred from that absence. CLI registration on one
host/user/client does not attach tools on another.

Official SDK0.40's loader has Darwin arm64 and Linux GNU/musl native branches;
the corresponding optional pins/lock entries match0.40. The loader can throw if
no native or WASI fallback loads, which could terminate a full MCP process before
catalog discovery. No native import/startup was performed, so ABI/loader failure
is neither demonstrated nor excluded. The bounded `status --current` entry avoids
those native/index imports. Existing Apple x64 support must not be inferred from
the loader's fallback probes: the selected official optional set has Darwin
arm64, not an Apple x64 package.

Provided execution context identifies the `/home/reoiv/...` workspace; no mapping
of a macOS T3 GUI to this agent/ACP process's HOME, PATH, cwd, package/Node runtime,
MCP config or registry/socket was supplied. No private/global config or environment
was dumped and no host was probed. The client adapter must bind the **actual
execution host and user** as well as workspace/cwd, approved STDIO command/argv,
config home and active provider catalog. Translate paths only using an explicit
verified mapping; do not reuse a Mac registry or claim a Linux socket is the same
service. A concrete adapter must distinguish launch/PATH/native-load/transport
failure from no configured/attached server, refresh same-cwd registry changes,
and refresh the real provider tool catalog. Cross-platform failure remains a
plausible boundary, not an established diagnosis or a reason to dismiss the
repository bug above.

## Durable instruction text for the integration owner

> Use `rg`/`rg --files` for literal text and file lookup. When current-repo
> discovery reports an indexed project and Gmax is available in the actual tool
> catalog, consider ordinary semantic retrieval for conceptual code discovery.
> Ordinary retrieval is not a new test, benchmark or profile invocation. Explicit
> query budgets, STOPs, no-query restrictions, host/resource limits, autostart
> quarantine and large-model authorization still apply. A test prohibition alone
> does not forbid otherwise permitted ordinary retrieval. A CLI suggestion or
> watch lease does not establish MCP attachment. Report current-repo
> `not_registered`, pending, error, offline and unknown states honestly; never
> search another project, index/rebuild, start a service or load a model merely
> to satisfy discovery/status.

This wording is returned for owner integration; AGENTS.md and CLAUDE.md were not
edited by this agent. No present query restriction was relaxed or query executed.

## Discovery-owner validation limits at handoff (before integration)

Source/fixture edits and scoped diff inspection only. Zero test executions, runtime queries,
native/model smokes, profiles, benchmarks, audits, independent reviews,
dependency installs, compilations/builds, service operations, SSH/live-host
actions, global user-config changes, releases or PRs were performed.

The Lance owner's earlier production compilation predates these changes and
does not validate them. A final production compilation, if still within the
parent's explicit authorization, belongs to the integration owner. This note
does not add a verification or approval gate. The existing hook-lifecycle VM
fixture now stubs the new `./repo-status` import, and the CLI-reference fixture's
description reflects the separated hook context. Neither fixture was run; no
new test invocation or runtime acceptance is claimed.
