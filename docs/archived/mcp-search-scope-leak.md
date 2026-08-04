---
type: plan
status: archived
created: 2026-06-30T07:17:07Z
updated: 2026-06-30T21:46:40Z
surfaces:
modules:
domain:
audience: internal
parent_plan:
related_plans:
related_docs:
current_state: ARCHIVED. Fix A+B is implemented and fresh MCP-session smoke passed from `qsys/qsys-training` and `qsys/docs`: default `semantic_search` stayed qsys-scoped with zero platform leakage, while `scope:"all"` and `projects:"platform"` returned platform results. Follow-up source-mode robustness fix shipped in `WorkerPool`: TS workers now preload an absolute `tsx` loader instead of bare `ts-node/register`, so fresh source MCP processes launched outside the gmax repo can boot query workers. Fix C (findProjectRoot registry/marker-aware) intentionally NOT taken — higher risk, left as documented option.
next_step: No further MCP scope work. Next active backlog item is Agent UX: Phase 9 template-literal DSL skeletons or Phase 7 `impact` rollup polish.
---

# Mcp Search Scope Leak

## Problem

The MCP `search` tool (the semantic-search tool Claude Code calls) returns
results from the **entire index** — including unrelated projects like
`platform` — when the user intends to search within a single project (e.g.
`qsys`). This happens silently, with no flag requested by the caller.

### Root cause (confirmed)

Two facts combine:

1. **The MCP server pins to one directory at startup, resolved by `.git` only.**
   - `src/commands/mcp.ts:217` — `const projectRoot = findProjectRoot(process.cwd())`,
     computed once when the `gmax-mcp` server launches, from the Claude Code
     session's working directory.
   - `findProjectRoot` (`src/lib/utils/project-root.ts:25`) only walks up looking
     for a `.git` directory. It does **not** consult the gmax registry or the
     `.gmax.json` marker.

2. **A non-exact registry match silently falls back to a global search.**
   - `src/commands/mcp.ts:290` — `const proj = getProject(projectRoot)` does an
     **exact-match** lookup (`e.root === root`, see `project-registry.ts:82`).
     There is no attempt to find a registered *ancestor*.
   - `src/commands/mcp.ts:291,300` — `if (!proj && typeof args.root !== "string")
     { searchAll = true }` → the query runs against every project in the index.
   - `src/commands/mcp.ts:354` — when `searchAll`, scoping is applied only if the
     caller passed `projects:`/`exclude_projects:`; otherwise the whole DB is
     searched.

`handleSemanticSearch` is invoked from exactly one place
(`src/commands/mcp.ts:2610`, `isSearchAll = false`), so this fallback is the
**only** path that sets `searchAll` without the caller asking — confirmed, no
hidden "search all" tool variant.

### Exact trigger

The `qsys` umbrella (`/Users/reoiv/Development/projects/qsys`) has **no `.git`**.
So `getProject` only succeeds when the session cwd is the umbrella root
*exactly*. From any subdirectory it fails and falls through to global search:

| Session cwd | `findProjectRoot` returns | `getProject` | Result |
|---|---|---|---|
| `…/projects/qsys` (exact root) | `…/qsys` (no .git → cwd) | finds "qsys" | scoped — no leak |
| `…/qsys/qsys-training` (no .git) | `…/qsys-training` (falls back to subdir) | miss | **searchAll → leak** |
| `…/qsys/docs` (no .git) | `…/docs` | miss | **searchAll → leak** |
| `…/qsys/q-sys-mcp` (has .git) | `…/q-sys-mcp` (stops at own .git) | miss | **searchAll → leak** |

Searching from anywhere *inside* the project (the normal case) resolves to a
path that isn't the registered umbrella, hits `searchAll = true` at
`mcp.ts:300`, and pulls from the whole database — including `platform`.

### Relevant existing code

- `getParentProject(root)` — `src/lib/utils/project-registry.ts:96`. Already
  finds a registered project whose root *covers* a given subdirectory. **Not
  currently wired into the MCP resolution path.** Directly usable by Fix A.
- `getChildProjects(root)` — `project-registry.ts:108`. Inverse lookup.
- CLI search (`src/commands/search.ts:249-256`) does **not** have this leak: on a
  missing exact match it errors ("This project hasn't been added…") instead of
  falling back to a global search. The MCP path diverges from the CLI here.

---

## Options

### Fix A — Resolve to a registered ancestor before falling back (surgical, MCP-only)

**Where:** `src/commands/mcp.ts:290`, immediately before the `!proj` block.

**Change:** if `getProject(projectRoot)` misses, try
`getParentProject(projectRoot)`. If it returns a registered ancestor (e.g. the
`qsys` umbrella), treat that as the resolved project — set the scope /
`pathPrefix` (and `displayRoot`) to the ancestor's root. Only when *both* the
exact and ancestor lookups miss does control reach the existing fallback.

- **Effect:** searches from `qsys/qsys-training`, `qsys/docs`, or
  `qsys/q-sys-mcp` resolve up to the registered `qsys` and scope to it. No
  `platform` leakage.
- **Blast radius:** ~5 lines in one handler. The other MCP tools
  (peek/extract/related, `mcp.ts:875+`) still use the exact `projectRoot`, so
  the same helper should likely be applied there for consistency (follow-up).
- **Trade-off:** leaves the global fallback intact for the genuinely
  outside-any-project case (acceptable; pairs naturally with Fix B).
- **Risk:** low. Additive; touches only the resolution branch.

### Fix B — Remove the silent global fallback (behavioral policy)

**Where:** `src/commands/mcp.ts:291-304`.

**Change:** replace `searchAll = true` with an explicit error mirroring the CLI
(`search.ts:250`): e.g. "cwd isn't an indexed gmax project — pass
`root:"qsys"` or `scope:"all"`." Cross-project search then happens **only** when
the caller explicitly passes `scope:"all"` or `projects:"…"`.

- **Effect:** the entire index is never searched implicitly again — matches the
  requirement "don't search everything unless I use a flag."
- **Blast radius:** changes default behavior for every session/project that
  currently relies on the convenience fallback (e.g. launching Claude Code from
  a non-repo directory now errors instead of returning results).
- **Trade-off:** strictest and most predictable; it is a global behavior change.
  Best combined with Fix A so it only errors when there is truly no exact *and*
  no ancestor match.
- **Risk:** medium (behavioral, not mechanical). May surprise workflows that
  depended on the implicit global search.

### Fix C — Make `findProjectRoot` registry/marker-aware (systemic, at the source)

**Where:** `src/lib/utils/project-root.ts:25`.

**Change:** during the upward walk, treat a registered project root (or a
`.gmax.json` marker file) as a boundary in addition to `.git`. A subdirectory of
`qsys` then resolves to `qsys` *before* `mcp.ts:290` runs, so `getProject`
succeeds and the fallback is never reached.

- **Effect:** fixes the leak for **every** consumer at once — MCP search, CLI
  search, and all symbol tools — and removes the `.git`-only assumption that
  caused this.
- **Blast radius:** largest. `findProjectRoot` also feeds `ensureProjectPaths`
  and the **indexing / walk-root** logic (`add`, `index`). Changing what it
  returns can shift index-root semantics.
- **Trade-off:** most thorough but highest risk; needs test coverage across
  add/index/search before shipping.
- **Risk:** high (core resolver used throughout the codebase).

---

## Recommendation

**A + B together.** Fix A makes subdirectory searches resolve to the umbrella
(solves the reported case immediately); Fix B removes the silent global so
anything genuinely out-of-project fails loudly instead of dumping the whole DB.
Fix C is the "correct at the source" option but should only be taken on with
dedicated test coverage given how widely `findProjectRoot` is used.

### Verification (whichever fix lands)

- From `qsys/qsys-training` and `qsys/docs`: MCP `search` returns only
  `qsys`-prefixed results; zero `platform` paths.
- `scope:"all"` and `projects:"…"` still perform cross-project search.
- CLI `gmax "…" --root qsys` remains correctly scoped (already passes).
- `tsc` clean, `biome check` clean, test suite green.
- Note: requires rebuild + global reinstall of `grepmax` and a daemon/MCP
  restart to take effect (installed `gmax` is a global copy, not a symlink to
  this repo).

---

## Implementation (shipped — A + B)

**`src/commands/mcp.ts`:**

- Added `resolveRegisteredProject()` — a closure over the server's pinned
  `projectRoot`. Returns `{ proj, root }`: exact `getProject` match, else a
  registered ancestor via `getParentProject` (Fix A), else `{ proj: undefined }`.
- `handleSemanticSearch`:
  - Uses the helper for `proj`/`resolvedRoot`.
  - **Fix B:** removed the silent `searchAll = true` fallback. When `!searchAll`
    and no project resolves and no explicit `root` is passed, it now returns an
    error pointing at `scope:"all"` / `projects:` — the whole index is never
    searched implicitly. Cross-project remains opt-in.
  - Default scoping prefix now uses `resolvedRoot` (the umbrella), so a session
    launched in a subdirectory scopes to the whole registered project, not just
    the subdir.
  - Dropped the now-unused `scopeNote` plumbing; `searchAll` is now `const`.
- Symbol-tool gates (`handleTraceCalls`, list-symbols) switched from
  `getProject(projectRoot)` to `resolveRegisteredProject()`, so they're usable
  from subdirectories of an umbrella too.
- Import: added `getParentProject` from `project-registry`.

**`tests/project-registry.test.ts`:** added a `getParentProject` suite covering
subdir→umbrella resolution, no self-match at the umbrella root, out-of-project →
undefined, and the prefix-boundary case (`/qsys-other` must not match `/qsys`).

**Not done:** Fix C (`findProjectRoot` registry/marker-aware) — higher blast
radius (feeds add/index walk-root); left as the documented "correct at the
source" option for a future change with dedicated coverage.

### Verification done

- `tsc --noEmit` clean, `biome check` clean, full suite 646 passed (+4 new).
- Built (`pnpm build`) and globally reinstalled; `grepmax` global is now a
  symlink to this repo, and `dist/commands/mcp.js` contains the new resolver.
- Resolver logic exercised against the **real** registry: all five `qsys`
  subdirs (with and without their own `.git`) resolve to the `qsys` umbrella;
  `platform` resolves to itself; `/tmp` errors loudly (no global leak).

### Fresh MCP verification done

Fresh `node_modules/.bin/tsx src/index.ts mcp` processes were launched with
`GMAX_NO_STALE_HINT=1` from both live qsys subdirectories:

- `/Users/reoiv/Development/projects/qsys/qsys-training`
- `/Users/reoiv/Development/projects/qsys/docs`

Results:

- Default `semantic_search` for `qsys designer macos installer provisioner`
  returned `qsys-designer-macos-wrapper/...` paths and no `platform` paths.
- Explicit `scope:"all"` for `ViewAsProvider context web terminal` returned
  `../../../beyond/platform/packages/web-terminal/src/contexts/ViewAsContext.tsx`.
- Explicit `projects:"platform"` returned the same platform result and no qsys
  paths.

During this live smoke, source-mode MCP initially failed before scope assertions
because the local query worker exited with `Cannot find module
'ts-node/register'` when launched from qsys. The resolver now uses an absolute
`tsx` preload for TS workers, matching the parent dev entrypoint and making
source-mode MCP cwd-independent.

## Closeout

Fix A+B shipped and was verified through fresh MCP sessions from nested qsys directories.
The source-mode worker bootstrap follow-up also shipped. Fix C remained intentionally
unnecessary because registered-ancestor resolution and explicit cross-project selection
closed the observed leak without broad root-discovery changes.

## Notes / context

- This session also (mistakenly) restructured the `qsys` index — removed the
  umbrella, added four child projects, then **restored the umbrella exactly as
  it was** at the user's instruction. Index state is back to a single `qsys`
  project (~10k chunks).
