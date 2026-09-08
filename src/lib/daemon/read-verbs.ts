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
// graph.trace, graph.dead, graph.audit; handlers in graph-handler.ts.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// rows verbs (WP-C) — rows.symbols, rows.locate, rows.skeleton;
// handlers in rows-handler.ts.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// vector verbs (WP-C) — vector.similar, vector.surprises;
// handlers in vector-handler.ts.
// ---------------------------------------------------------------------------
