/**
 * Client-side access policy for store reads.
 *
 * Every read-only gmax command has three ways to get an answer, and exactly one
 * of them is correct in any given situation:
 *
 *   1. Ask the daemon over `~/.gmax/daemon.sock`. Preferred whenever a daemon
 *      is up: the daemon is the only process that should hold the store open.
 *   2. Open the store in-process. Legitimate only when *no daemon exists*
 *      (autostart disabled, tests, CI). Opening the store takes a `StoreLease`,
 *      which mkdirs under `~/.gmax` — so a "read" is a writer as far as the
 *      filesystem is concerned.
 *   3. Refuse. When the process is sandboxed, both of the above fail with an
 *      errno that says nothing useful. One actionable line beats a stack trace.
 *
 * `withStoreRead` encodes that decision. The fallback set is deliberately tiny:
 * `ENOENT`/`ECONNREFUSED` mean there is no daemon listening, and nothing else
 * does. A *live* daemon error (DAEMON_BUSY, timeout, a scope rejection, a store
 * failure) must never send the caller into the store concurrently.
 *
 * Sandbox handling: Claude Code's Bash sandbox denies writes under `~/.gmax`
 * and blocks Unix sockets. The socket connect then fails `EPERM`, and the lease
 * mkdir fails `EPERM`/`EACCES`. Both are turned into a refusal carrying the one
 * settings key that fixes it, exit code 2, and no stack.
 *
 * Env switches:
 *   GMAX_NO_DAEMON=1  Skip the daemon attempt entirely and run the in-process
 *                     path. Intended for byte-identical output comparisons
 *                     between the two paths; it does not relax the sandbox
 *                     refusal, so a sandboxed shell still gets the lease hint.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { PATHS } from "../../config";
import type { DaemonResponse } from "./daemon-client";

/**
 * Socket-level errors that prove no daemon is listening. These — and only these
 * — permit the in-process path.
 */
const NO_DAEMON_ERRORS = new Set(["ENOENT", "ECONNREFUSED"]);

/** Errnos that mean the sandbox denied the operation, not that it failed. */
const SANDBOX_ERRNOS = new Set(["EPERM", "EACCES", "EROFS"]);

export type DaemonErrorClass =
  | "ok"
  | "no-daemon"
  | "sandboxed"
  | "daemon-error";

export const SOCKET_DENIED_MESSAGE =
  'gmax: cannot reach the daemon socket from this sandbox. Add to Claude Code settings: "sandbox": {"network": {"allowUnixSockets": ["~/.gmax/daemon.sock"]}}';

export const LEASE_DENIED_MESSAGE =
  'gmax: cannot open the store from this sandbox. Add to Claude Code settings: "sandbox": {"filesystem": {"allowWrite": ["~/.gmax"]}}';

/** The one line to print when the daemon socket is unreachable from a sandbox. */
export function socketDeniedMessage(): string {
  return SOCKET_DENIED_MESSAGE;
}

/** The one line to print when the store lease cannot be taken from a sandbox. */
export function leaseDeniedMessage(): string {
  return LEASE_DENIED_MESSAGE;
}

/**
 * Refusal to reach the store at all. Carries the actionable line as its
 * message; commands print it verbatim (one line, no stack) and exit 2.
 */
export class StoreAccessRefused extends Error {
  readonly kind: "socket" | "lease";
  readonly exitCode = 2;

  constructor(kind: "socket" | "lease") {
    super(kind === "socket" ? SOCKET_DENIED_MESSAGE : LEASE_DENIED_MESSAGE);
    this.name = "StoreAccessRefused";
    this.kind = kind;
  }
}

export function isStoreAccessRefused(err: unknown): err is StoreAccessRefused {
  return err instanceof StoreAccessRefused;
}

/**
 * Build the refusal and mark the process failed. Exit code 2 distinguishes
 * "refused, configure your sandbox" from an ordinary command failure (1).
 */
export function refuseStoreAccess(
  kind: "socket" | "lease",
): StoreAccessRefused {
  process.exitCode = 2;
  return new StoreAccessRefused(kind);
}

/**
 * Print a refusal as a single line and set the exit code. Returns false when
 * `err` is something else, so callers can chain it into an existing catch:
 *
 *   catch (err) { if (reportStoreAccessRefusal(err)) return; ...existing... }
 */
export function reportStoreAccessRefusal(err: unknown): boolean {
  if (!isStoreAccessRefused(err)) return false;
  console.error(err.message);
  process.exitCode = 2;
  return true;
}

/** Pull an errno-ish string out of whatever the socket layer handed back. */
function errorCode(error: unknown): string | undefined {
  if (typeof error === "string") return error;
  if (error && typeof error === "object") {
    const code = (error as NodeJS.ErrnoException).code;
    if (typeof code === "string") return code;
    const message = (error as Error).message;
    if (typeof message === "string") return message;
  }
  return undefined;
}

/**
 * Classify a daemon-side failure. `error` is either the `error` field of a
 * DaemonResponse (sendDaemonCommand reports `err.code ?? err.message`) or a
 * thrown ErrnoException.
 *
 * - "ok"           no error present
 * - "no-daemon"    nothing is listening; the in-process path is allowed
 * - "sandboxed"    the sandbox blocked the socket; refuse with the socket hint
 * - "daemon-error" a live daemon said no; report it, never fall back
 */
export function classifyDaemonError(error: unknown): DaemonErrorClass {
  if (error === undefined || error === null || error === "") return "ok";
  const code = errorCode(error);
  if (!code) return "daemon-error";
  if (NO_DAEMON_ERRORS.has(code)) return "no-daemon";
  if (SANDBOX_ERRNOS.has(code)) return "sandboxed";
  return "daemon-error";
}

/**
 * True only for the two socket errors that prove no daemon exists.
 *
 * Kept as a named predicate because it is the exact rule `search-run.ts` has
 * always applied (and re-exports); `unknown command` is deliberately NOT in the
 * set — see `isUnknownCommandError` for the version-skew allowance.
 */
export function shouldFallbackFromDaemonError(error: unknown): boolean {
  return classifyDaemonError(error) === "no-daemon";
}

/**
 * A daemon older than this CLI does not know a newly added verb. Treat that as
 * "no daemon" for one release so an unrestarted daemon does not break the
 * command, then remove the allowance. Mirrors the `search-v2` transition rule.
 */
export function isUnknownCommandError(error: unknown): boolean {
  return typeof error === "string" && error.startsWith("unknown command");
}

/**
 * Classify a failure from opening the store in-process (the `StoreLease` mkdir,
 * an LMDB `env.open`, a LanceDB write). Sandbox denials become a refusal that
 * names the filesystem settings key; everything else is a real error.
 */
export function classifyLeaseError(err: unknown): "sandboxed" | "other" {
  const code = (err as NodeJS.ErrnoException)?.code;
  if (typeof code === "string" && SANDBOX_ERRNOS.has(code)) return "sandboxed";
  const message = err instanceof Error ? err.message : "";
  // Node fs errors stringify as "EPERM: operation not permitted, mkdir '...'".
  // LMDB reports the same denial as "Operation not permitted: ...".
  if (/^(EPERM|EACCES|EROFS):/.test(message)) return "sandboxed";
  if (/^Operation not permitted\b/.test(message)) return "sandboxed";
  return "other";
}

/**
 * Convert a lease/store-open failure into a refusal when the sandbox caused it,
 * otherwise hand the original error back unchanged.
 */
export function asStoreAccessError(err: unknown): unknown {
  if (isStoreAccessRefused(err)) return err;
  return classifyLeaseError(err) === "sandboxed"
    ? refuseStoreAccess("lease")
    : err;
}

export interface StoreReadOptions<T> {
  /** Ask the daemon. Should resolve (not throw) with the daemon's response. */
  daemon: () => Promise<DaemonResponse>;
  /** Open the store here. Entered only when no daemon is listening. */
  inProcess: () => Promise<T>;
  /** Map an ok daemon response to the command's own shape. */
  render?: (resp: DaemonResponse) => T | Promise<T>;
  /**
   * Treat `unknown command` from an older daemon as "no daemon" for one
   * release. New read verbs set this; `search`/`search-v2` deliberately do not.
   */
  fallbackOnUnknownVerb?: boolean;
  /** Message for a live-daemon error. Defaults to `<name> failed: <error>`. */
  daemonErrorMessage?: (resp: DaemonResponse) => string;
  /** Skip the daemon attempt (same effect as GMAX_NO_DAEMON=1). */
  skipDaemon?: boolean;
}

function defaultDaemonErrorMessage(name: string, resp: DaemonResponse): string {
  const detail =
    typeof resp.hint === "string"
      ? `: ${resp.hint}`
      : typeof resp.error === "string"
        ? `: ${resp.error}`
        : "";
  return `Daemon ${name} failed${detail}`;
}

/** True when the caller asked for the in-process path explicitly. */
export function isDaemonBypassed(): boolean {
  return process.env.GMAX_NO_DAEMON === "1";
}

/**
 * Run one store read through the access policy. See the file header for the
 * decision table; `name` names the operation in daemon-error messages.
 */
export async function withStoreRead<T>(
  name: string,
  opts: StoreReadOptions<T>,
): Promise<T> {
  const runInProcess = async (): Promise<T> => {
    try {
      return await opts.inProcess();
    } catch (err) {
      throw asStoreAccessError(err);
    }
  };

  if (opts.skipDaemon || isDaemonBypassed()) return runInProcess();

  let resp: DaemonResponse;
  try {
    resp = await opts.daemon();
  } catch (err) {
    if (isStoreAccessRefused(err)) throw err;
    const cls = classifyDaemonError((err as NodeJS.ErrnoException)?.code);
    if (cls === "sandboxed") throw refuseStoreAccess("socket");
    if (cls !== "no-daemon") throw err;
    return runInProcess();
  }

  if (resp.ok) {
    return opts.render ? await opts.render(resp) : (resp as unknown as T);
  }

  const cls = classifyDaemonError(resp.error);
  if (cls === "sandboxed") throw refuseStoreAccess("socket");
  if (
    cls === "no-daemon" ||
    (opts.fallbackOnUnknownVerb && isUnknownCommandError(resp.error))
  ) {
    if (process.env.GMAX_DEBUG === "1") {
      console.error(`[${name}] daemon path unavailable: ${resp.error}`);
    }
    return runInProcess();
  }
  throw new Error(
    (opts.daemonErrorMessage ?? ((r) => defaultDaemonErrorMessage(name, r)))(
      resp,
    ),
  );
}

// --- Spawn guard -----------------------------------------------------------

/**
 * Probe whether this process could write under `~/.gmax` at all.
 *
 * A daemon spawned from a sandboxed shell inherits the sandbox for its whole
 * life: it fails its own lock mkdir, dies, and leaves a confusing crash in
 * daemon.log while the caller waits out the 30s readiness poll. Cheaper to ask
 * first. mkdir+rmdir of a PID-named probe dir is the smallest operation that
 * exercises the same permission the lease needs.
 *
 * "unknown" (e.g. ENOSPC, a weird EIO) is deliberately not "sandboxed": only a
 * denial should suppress a spawn.
 */
export function probeStoreWritable(
  dir: string = PATHS.globalRoot,
): "writable" | "sandboxed" | "unknown" {
  // Only a denial may suppress a spawn, so an unusable path (a test harness
  // with a partial PATHS, say) reports "unknown" rather than guessing.
  if (typeof dir !== "string" || dir === "") return "unknown";
  const probe = path.join(dir, `.spawn-probe-${process.pid}`);
  try {
    fs.mkdirSync(dir, { recursive: true });
    try {
      fs.mkdirSync(probe);
    } catch (err) {
      // A same-PID leftover from a crashed probe still proves writability.
      if ((err as NodeJS.ErrnoException)?.code !== "EEXIST") throw err;
    }
    try {
      fs.rmdirSync(probe);
    } catch {}
    return "writable";
  } catch (err) {
    return classifyLeaseError(err) === "sandboxed" ? "sandboxed" : "unknown";
  }
}

/**
 * One-line notice for a spawn suppressed because the sandbox denies writes to
 * `~/.gmax`, or null when a spawn is fine. Same shape as
 * `autostartDisabledNotice()` in autostart.ts: the caller decides whether to
 * print, and the text names the exact fix.
 */
export function storeWriteDeniedNotice(dir?: string): string | null {
  return probeStoreWritable(dir) === "sandboxed" ? LEASE_DENIED_MESSAGE : null;
}

let sandboxNoticePrinted = false;

/**
 * Print the lease-denied hint at most once per process. The spawn guard sits on
 * paths that run per command (`ensureDaemonRunning`, `launchWatcher`), and a
 * repeated hint is noise.
 */
export function warnStoreWriteDeniedOnce(message = LEASE_DENIED_MESSAGE): void {
  if (sandboxNoticePrinted) return;
  sandboxNoticePrinted = true;
  console.error(message);
}

/** Test hook: forget that the notice was printed. */
export function resetStoreWriteDeniedNotice(): void {
  sandboxNoticePrinted = false;
}
