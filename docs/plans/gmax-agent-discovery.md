# Gmax agent discovery and current-repo status

## 0.26.110 handover and selected core configuration — completed

P3 now110ready/open/active with exact109rollback; plugin110refreshed. Standard
Codexgmax args[mcp] nowselectedenvcore, otherconfig preserved. Direct metadata
connectionadvertised exactcore8andclosed without toolcalls. Parentcurrentactual
ALL_TOOLS remains329/28Gmax; owneralso329/28. No safe programmaticrefresh tool
wasexposed. Actualcore8awaits normal supported client/provider MCP reconnect
consuming updatedregistration and then anactualeight-name catalog; no forced
app/provider restart, sessionreset/fork, modelchange orT3adapter. Repo remains
not_registered,noindexing. [Exactguard/deploy/catalog record](assets/mcp-cleanup-release-20261029/isolated-guard/completion.md).
Older stop/config/catalog sections belowretain their original observation dates.


## 0.26.110 publication; core8 handover not executed

October29: MCP profiles/errors/cancellation and Table cleanup are published in
source920afc5. Fresh packaging passed after the explicitly resumed preparation;
subsequent P3 staging stopped on160,866,304bytes host-wide swap growth. No live
installation/service/plugin or selected Codex configuration change occurred.
Core8 direct listing and actual active core8 visibility are NOT verified. Last
retained parent329/full28 advertisement remains a prior observation; current
repo not_registered. No indexing, T3 adapter/restart or automatic retry. See
[exact delivery outcome](assets/mcp-cleanup-release-20261029/completion.md).
Earlier local/shipped/catalog records below retain their original chronology.


Implementation note, 2026-10-29. This is the focused discovery record; the
delivery/upgrade owners retain their shared plans and instruction files.

## Retained delivered state — 0.26.109

[Completion evidence](assets/lance-discovery-release-20261029/completion.md) records
published source `60bc601196075961367d0fa58e511090c9ddcb82`, P3 last verified
ready/open/active, and refreshed Claude plugin 0.26.109. One focused native
invocation passed 3 cases / 8 unselected skipped; final production compilation
was reused. SDK/native 0.40.0, embedded Lance 13 and Python 13 shipped; separately
qualified Rust 12 remains unchanged. No memory/fan/relevance gain is established.

Standard Codex registration was missing and is now repaired (`gmax`, `["mcp"]`),
with other configuration preserved. The direct server advertised 28 tools,
including `repo_status` and `semantic_search`; Gmax was not_registered and
Platform indexed. The earlier October 29 retained active-provider catalog had
301 entries and no Gmax tools; that remains a dated prior observation. The direct
listing and registration did not establish parent attachment at that stage.
See the [README workflow](../../README.md#current-repo-status).

## Selected item 1 complete — parent catalog confirmation

**Selected item 1 — agent visibility: COMPLETE for the parent provider.**
On October 29, 2026 the parent reported its current actual `ALL_TOOLS` scan:
**329 tools including 28 `mcp__gmax__` tools**, including
`mcp__gmax__repo_status` and `mcp__gmax__semantic_search`. All 28 descriptions
identify current repo `/home/reoiv/dev/hetchy/tools/gmax`,
`index=not_registered`, `matchedRoot=null`, `daemon=unobserved`.
This is actual parent catalog advertisement, superseding the earlier retained
301/no-Gmax parent visibility result; it is not inferred from CLI configuration
or the direct server's 28-tool listing. No reconnect/configuration change is
needed for this selected parent goal.

The owner's separate child catalog scan still has **301 tools / zero Gmax tools**.
Parent visibility is confirmed; child attachment is not. Neither observation
establishes search readiness for this **unregistered** repo. No indexing is
authorized. No search/status RPC, client process, provider reconnect or runtime
verification was performed to record this confirmation. No automatic cwd/catalog
refresh or visibility in every client is claimed.

## Historical local integration — before publication

Durable guidance and the config-home fix were complete locally before release.
The final guarded production compilation passed; the earlier pre-platform-fix
swap refusal remains separately recorded in the [integration evidence](assets/local-integration-20261029/completion.md).
Runtime/setup verification then followed during delivery, as recorded above.

## Historical evidence and causal chain

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


## Corrected direction: existing MCP registration, no T3 code changes

**User correction, October 29, 2026:** the earlier proposed T3 adapter is
withdrawn and is not required work or an accepted next feature. No T3 codebase
changes are selected or authorized. The approach is standard MCP registration
plus Gmax-owned status/context. A missing Gmax entry in the active catalog does
not prove that T3 lacks MCP support or needs new infrastructure. The actual
registration, inheritance, launch and catalog state was unverified at this
correction. Subsequent delivery established standard registration/direct server
operation, and the later parent catalog scan above confirms parent advertisement.
The owner's child catalog remains separate and does not contradict that result.

The existing Gmax Codex installer already uses the exact registration command
`codex mcp add gmax -- gmax mcp` (`src/commands/codex.ts:97-117`). The launch
metadata it recognizes is STDIO, command `gmax` (or a path with that basename),
args `["mcp"]`. `gmax plugin update codex` selects that existing installer through
`src/commands/plugin.ts:109-112`. These are documented configuration actions,
not commands executed during this correction. No guessed T3-specific field,
UI step or override flag is prescribed. Whether the T3 Codex driver consumes
that particular Codex configuration has not been established here.

For an existing standard MCP registration consumed by the active client,
installing the new Gmax release supplies the new `repo_status` tool and
repo-specific MCP initialization instructions through the same `gmax mcp`
transport (`src/commands/mcp.ts:3511-3524,3645-3662`). `repo_status` remains
available for unregistered repos. It reports status without auto-indexing. A
release can therefore help an already-connected client without T3 code changes;
it does not itself create or enable an absent client registration or refresh an
already-running connection.

For Claude Code integrations that already run the installed plugin, refreshing
it with the existing `gmax plugin update claude` path makes the new startup/cwd/
subagent context available on the client's supported events. The committed
`CLAUDE_CONFIG_DIR` fix aligns plugin cache detection/removal with a custom
Claude configuration home, so the Gmax release also contains a concrete
configuration-home fix. That fix does not establish this Codex thread's cause.
Claude hooks are not assumed to execute in a Codex session.

No T3 source hunt, external changes, client activation or live configuration
inspection is part of this correction. Provider configuration inheritance,
Mac-GUI/Linux-agent host mapping and automatic cwd/registry-event delivery remain
unknown. MCP initialization context reflects server launch cwd; `repo_status`
accepts an explicit cwd. Automatic mid-session context/catalog refresh is not
promised without evidence of existing client support, and is not a reason to
prescribe an adapter or T3 rewrite.

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
was dumped and no host was probed. Standard MCP registration needs to refer to
the executable, environment/configuration home and workspace on the actual agent
execution host. Their mapping is unverified here. Do not assume a Mac GUI's
registration or local Unix socket is shared with a Linux agent. This is an
existing configuration/launch consideration, not evidence for a required adapter
or T3 code change. Cross-platform failure remains unproven.

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
