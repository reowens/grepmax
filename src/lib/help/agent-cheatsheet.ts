/**
 * Canonical agent cheatsheet — the single source of truth for the gmax command
 * survey available through `gmax help-agent`. Session hooks emit repo-specific
 * availability from repo-status.js rather than assuming this CLI is ready.
 *
 * Keep this file as plain string data with NO imports so the hook can cheaply
 * `require()` the compiled CommonJS output.
 */

/** Compatibility intro for consumers of the exported full hint. */
export const SESSION_START_PREFIX =
  "Gmax CLI reference (availability depends on the current repo). Add --agent for compact output. MCP tools require client registration and actual catalog advertisement.";

/** The command survey — Find / Understand / Survey + scope/roles/recovery. */
export const AGENT_CHEATSHEET = `Find:
  gmax "topic"                       semantic search
  gmax similar <symbol>              similar code

Understand:
  gmax peek <symbol>                 signature + callers + callees + tests
  gmax extract <symbol>              full body + tests
  gmax trace <symbol>                call graph (--inbound = callers + snippets)
  gmax test <symbol>                 tests for symbol
  gmax impact <symbol>               blast radius
  gmax related <file>                file deps + dependents

Survey:
  gmax project                       codebase overview (langs, structure, key symbols)
  gmax skeleton <file>               file structure (file path, NOT a directory)
  gmax surprises --experimental      similar but graph-disconnected file pairs
  gmax context "topic-or-path" --budget 4000 topic summary or deterministic file/dir context
  gmax log <path-or-symbol>          git commits (replaces recent/diff)
  gmax status                        indexed projects
  gmax status --current --json        current-repo setup (metadata + bounded ping only)

Scope flags: --root <name|path>, --in <subpath>, --exclude <subpath>.
Roles in results: [DEFI] [ORCH] [IMPL] [DOCS].
Notation: s=/d= score/distance (higher s / lower d = better; s is per-query-normalized — top hit ≈1.0, relative to this query, not absolute confidence) · C:n complexity ·
  <- caller / -> callee · dep:/rev: outbound/inbound file deps (count = shared symbols) ·
  test hops: direct = calls it, N-hop = N calls away, via-import = imports but call unseen ·
  test via=X,Y: caller symbols inside the test file (often helpers, not the tests) ·
  (not indexed) = external/builtin, no definition in the index.
Recovery: "not added yet" → gmax add; stale → gmax index; broken → gmax doctor --fix.`;

/** Full CLI reference; this does not establish current-repo availability. */
export const SESSION_START_HINT = `${SESSION_START_PREFIX}\n\n${AGENT_CHEATSHEET}`;
