/**
 * Canonical agent cheatsheet — the single source of truth for the gmax command
 * survey shown to agent sessions. Consumed by two places:
 *   - `gmax help-agent` (re-summon the survey on demand, e.g. after a session
 *     has compacted away the original SessionStart injection)
 *   - the SessionStart hook (`plugins/grepmax/hooks/start.js`), which loads this
 *     compiled module from the installed package and falls back to an inline
 *     copy only if the require fails — so the two can never silently drift.
 *
 * Keep this file as plain string data with NO imports so the hook can cheaply
 * `require()` the compiled CommonJS output.
 */

/** Intro line shown only at SessionStart (not part of the on-demand command). */
export const SESSION_START_PREFIX =
  "gmax ready. Add --agent to any command for compact output (~89% fewer tokens).";

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
  gmax context "topic-or-path" --budget 4000 topic summary or deterministic file/dir context
  gmax log <path-or-symbol>          git commits (replaces recent/diff)
  gmax status                        indexed projects

Scope flags: --root <name|path>, --in <subpath>, --exclude <subpath>.
Roles in results: [DEFI] [ORCH] [IMPL] [DOCS].
Recovery: "not added yet" → gmax add; stale → gmax index; broken → gmax doctor --fix.`;

/** Full SessionStart context = prefix + cheatsheet. */
export const SESSION_START_HINT = `${SESSION_START_PREFIX}\n\n${AGENT_CHEATSHEET}`;
