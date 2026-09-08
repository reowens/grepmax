/**
 * Registry for daemon read verbs.
 *
 * The daemon is meant to be the only process that opens the store, so every
 * read-only CLI command becomes a thin IPC client. Rather than growing one more
 * `case` in `ipc-handler.ts` per verb (and making that file a merge magnet),
 * verbs register here and `ipc-handler`'s `default:` looks them up before it
 * reports `unknown command`.
 *
 * Each verb runs through `Daemon.runSharedOperation(verbName, ...)`, so an
 * exclusive rebuild answers DAEMON_BUSY naming the verb instead of racing it,
 * and its abort signal is bound to socket close exactly like `search`.
 *
 * Verbs are request/response only: one JSON line in, one JSON line out. Anything
 * that needs progress belongs in the streaming command set instead.
 *
 * Handlers live beside `search-handler.ts` (`graph-handler.ts`,
 * `rows-handler.ts`, `vector-handler.ts`), each taking a narrow deps interface
 * so `ipc-handler` tests can drive them with a fake `Daemon`.
 */

import type * as net from "node:net";
import type { DaemonResponse } from "../utils/daemon-client";
import type { Daemon } from "./daemon";
import { createGraphVerbs } from "./graph-handler";

/** Bumped when the verb wire shapes change incompatibly. */
export const READ_VERBS_PROTOCOL = 1;

export interface ReadVerbContext {
  daemon: Daemon;
  /** The client connection, for handlers that need liveness; do not write to it. */
  conn: net.Socket;
  /** Aborted when the client disconnects. */
  signal: AbortSignal;
}

/** `payload` is the raw parsed command object, including `cmd`. */
export type ReadVerbHandler = (
  payload: Record<string, unknown>,
  ctx: ReadVerbContext,
) => Promise<DaemonResponse>;

const registry = new Map<string, ReadVerbHandler>();

/**
 * Register one or more verbs. Re-registering a name replaces it, which keeps
 * hot-reload and test setup simple; duplicate names across packages are a bug,
 * so the collision is logged when it happens with a different handler.
 */
export function registerReadVerbs(
  entries:
    | Record<string, ReadVerbHandler>
    | Iterable<[string, ReadVerbHandler]>,
): void {
  const iterable = (entries as { [Symbol.iterator]?: unknown })[
    Symbol.iterator
  ];
  const pairs: Iterable<[string, ReadVerbHandler]> =
    typeof iterable === "function"
      ? (entries as Iterable<[string, ReadVerbHandler]>)
      : Object.entries(entries as Record<string, ReadVerbHandler>);
  for (const [name, handler] of pairs) {
    registry.set(name, handler);
  }
}

export function getReadVerb(name: unknown): ReadVerbHandler | undefined {
  return typeof name === "string" ? registry.get(name) : undefined;
}

export function readVerbNames(): string[] {
  return [...registry.keys()].sort();
}

/** Test hook: drop every registration. */
export function clearReadVerbs(): void {
  registry.clear();
}

// ---------------------------------------------------------------------------
// graph verbs (WP-B) — graph.resolve, graph.tests, graph.dependents,
// graph.trace, graph.peek, graph.dead, graph.audit; handlers in
// graph-handler.ts.
//
// `graph.peek` is not in the plan's table: `peek` needs its defining-chunk rows
// and its `is_exported`/`end_line` metadata alongside the graph, and those
// selects would otherwise land in WP-C's `rows.locate`. Keeping them in one
// composite verb costs one round trip instead of four and keeps peek's
// rendering (and its `fs.readFileSync` signature extraction) unchanged.
//
// WP-D added four more for the MCP tools that have no CLI twin:
// `graph.neighbors`, `graph.paths` and `graph.subgraph` are the GraphBuilder
// traversal primitives behind `get_neighbors` / `find_paths` /
// `subgraph_for_files` — distinct entry points with their own hop and size
// bounds, which is why they are separate verbs rather than options on
// `graph.trace`. `graph.risk` is the store half of `review_risk`: the git half
// (diff, churn) stays with the caller, exactly as `extract` keeps its body read.
// ---------------------------------------------------------------------------

/**
 * Called once from the Daemon constructor rather than at module load, so that
 * importing this registry (as `ipc-handler` and its tests do) does not populate
 * it behind a test's back.
 */
export function registerGraphVerbs(): void {
  registerReadVerbs(createGraphVerbs((ctx) => ctx.daemon.storeReadDeps()));
}

// ---------------------------------------------------------------------------
// rows verbs (WP-C) — rows.symbols, rows.project, rows.locate, rows.skeleton.
// Handlers and their `registerRowsVerbs()` live in rows-handler.ts;
// `Daemon.start()` calls it, because registering at module scope would make the
// registry non-empty on import and break the assertions in
// tests/ipc-read-verbs.test.ts.
//
// `rows.project` is not in the plan's table: `symbols` and `project` were to
// share one row-proxy verb. `project.ts` selects up to 200 000 rows with two
// symbol-array columns, and the platform project holds 266 753 chunks, so the
// proxy shape would push hundreds of megabytes through the daemon's event loop
// for a summary that fits in a few kilobytes. Both verbs return the finished
// aggregate instead — see the rows-handler.ts header.
//
// WP-C also shipped `rows.tests` for `extract`'s footer; WP-D removed it. It
// wrapped the same `findTests` call `graph.tests` does, and `extract` now sends
// that verb, so the duplicate wire shape is gone before any daemon served it.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// vector verbs (WP-C) — vector.similar, vector.surprises; handlers and
// `registerVectorVerbs()` in vector-handler.ts, called from `Daemon.start()`.
// ---------------------------------------------------------------------------
