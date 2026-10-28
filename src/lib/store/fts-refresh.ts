import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { resourceBudget } from "../utils/resource-budget";
import {
  type CleanupRuntime,
  prepareCleanupRuntime,
  runCleanupProcess,
} from "./lance-cleanup";
import {
  assertStoreMutationAllowed,
  availableStoreDiskBytes,
} from "./maintenance-policy";
import { StoreLease, storeLeasePaths } from "./store-lease";

const MIB = 1024 ** 2;
const MAX_GROWTH = 512 * MIB;
const DISK_MARGIN = 1024 * MIB;
const MAX_RSS = 1024 * MIB;
const MAX_MS = 120_000;
const MAX_FILES = 100_000;

export interface FtsRefreshResult {
  engine: "12.0.0";
  index: "content_idx";
  outcome: "completed" | "checked";
  beforeVersion: number;
  afterVersion: number;
  dataRewritten: false;
  rows: number;
  unindexedRows: number;
  /** Absent only in receipts produced before fragment-bounded catch-up. */
  batchRows?: number;
  selectedFragments?: number;
  physicalInputRows: number;
  contentBytes: number;
  pendingFragments: number;
  segmentsBefore: number;
  remainingRows: number;
  newFileBytes: number;
  elapsedMs: number;
  beforeFingerprint: string;
}

export interface FtsRefreshState {
  schemaVersion: 1;
  storeIdentity: string;
  attemptId: string;
  expectedVersion: number;
  startedAt: number;
  outcome: "running" | "uncertain" | "completed";
  finishedAt?: number;
  previousUncertainAttemptId?: string;
  result?: FtsRefreshResult;
}

function validResult(
  r: FtsRefreshResult,
  version: number,
  run: boolean,
): boolean {
  const count = (v: number) => Number.isSafeInteger(v) && v >= 0;
  const batchRows = r?.batchRows === undefined ? r?.unindexedRows : r.batchRows;
  const selectedFragments =
    r?.selectedFragments === undefined
      ? r?.pendingFragments
      : r.selectedFragments;
  return (
    r?.engine === "12.0.0" &&
    r.index === "content_idx" &&
    r.outcome === (run ? "completed" : "checked") &&
    r.beforeVersion === version &&
    r.dataRewritten === false &&
    [
      r.rows,
      r.unindexedRows,
      r.physicalInputRows,
      r.contentBytes,
      r.pendingFragments,
      r.segmentsBefore,
      r.remainingRows,
      r.newFileBytes,
      r.elapsedMs,
    ].every(count) &&
    (r.batchRows === undefined) === (r.selectedFragments === undefined) &&
    count(batchRows) &&
    count(selectedFragments) &&
    batchRows <= r.unindexedRows &&
    batchRows <= r.physicalInputRows &&
    selectedFragments <= r.pendingFragments &&
    (batchRows > 0 || r.unindexedRows === 0) &&
    (batchRows === 0 || selectedFragments > 0) &&
    (selectedFragments < r.pendingFragments || batchRows === r.unindexedRows) &&
    r.unindexedRows <= r.rows &&
    r.physicalInputRows <= 100_000 &&
    r.contentBytes <= 64 * MIB &&
    r.pendingFragments <= 10_000 &&
    r.segmentsBefore > 0 &&
    r.segmentsBefore < 256 &&
    r.newFileBytes <= MAX_GROWTH &&
    r.remainingRows === r.unindexedRows - (run ? batchRows : 0) &&
    r.afterVersion === version + Number(run && batchRows > 0) &&
    /^[a-f0-9]{64}$/.test(r.beforeFingerprint)
  );
}

export function ftsRefreshStatePath(store: string): string {
  return path.join(store, ".gmax-fts-refresh.json");
}

export function readFtsRefreshState(store: string): FtsRefreshState | null {
  const identity = fs.realpathSync(store);
  const file = ftsRefreshStatePath(identity);
  const stat = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!stat) return null;
  if (!stat.isFile() || stat.nlink !== 1 || stat.size > 16 * 1024)
    throw new Error("FTS refresh state is unverified or oversized");
  const state: FtsRefreshState = JSON.parse(fs.readFileSync(file, "utf8"));
  if (
    state.schemaVersion !== 1 ||
    state.storeIdentity !== identity ||
    !/^[a-f0-9-]{36}$/.test(state.attemptId) ||
    !Number.isSafeInteger(state.expectedVersion) ||
    state.expectedVersion < 1 ||
    !Number.isSafeInteger(state.startedAt) ||
    !["running", "uncertain", "completed"].includes(state.outcome) ||
    (state.outcome === "completed" &&
      (!Number.isSafeInteger(state.finishedAt) ||
        !validResult(state.result!, state.expectedVersion, true)))
  )
    throw new Error("FTS refresh state is invalid; inspect before retry");
  return state.outcome === "running"
    ? { ...state, outcome: "uncertain" }
    : state;
}

function writeState(state: FtsRefreshState): void {
  // Validate an existing receipt before replacing it; never follow a symlink.
  readFtsRefreshState(state.storeIdentity);
  const target = ftsRefreshStatePath(state.storeIdentity);
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    const fd = fs.openSync(temporary, "wx", 0o600);
    try {
      fs.writeFileSync(fd, `${JSON.stringify(state)}\n`);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(temporary, target);
    const directory = fs.openSync(state.storeIdentity, "r");
    try {
      fs.fsyncSync(directory);
    } finally {
      fs.closeSync(directory);
    }
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function localTable(input: string): string {
  const table = path.resolve(input);
  const stat = fs.lstatSync(table);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    path.basename(table) !== "chunks.lance"
  )
    throw new Error(
      "FTS refresh requires an existing local chunks.lance directory",
    );
  return fs.realpathSync(table);
}

function memory(): { available: number; swap: number } {
  const values = new Map(
    fs
      .readFileSync("/proc/meminfo", "utf8")
      .trim()
      .split("\n")
      .map((line) => {
        const [key, value] = line.split(":");
        return [key, Number.parseInt(value.trim(), 10) * 1024] as const;
      }),
  );
  const result = {
    available: values.get("MemAvailable")!,
    swap: values.get("SwapTotal")! - values.get("SwapFree")!,
  };
  if (
    !Number.isSafeInteger(result.available) ||
    !Number.isSafeInteger(result.swap) ||
    result.available < 0 ||
    result.swap < 0
  )
    throw new Error("FTS refresh host memory measurements unavailable");
  return result;
}

function check(store: string, initialSwap?: number, pid?: number): void {
  if (process.platform !== "linux")
    throw new Error(
      "Explicit FTS refresh is currently qualified for Linux only",
    );
  assertStoreMutationAllowed();
  // An explicit table path bypasses CLI store routing. Preserve containment in
  // that table's home as well as the current/shared home checked above.
  for (const name of ["safety-stop.json", "autostart-disabled"]) {
    if (
      fs.lstatSync(path.join(path.dirname(store), name), {
        throwIfNoEntry: false,
      })
    )
      throw new Error("FTS refresh target store is quarantined");
  }
  const free = availableStoreDiskBytes(store);
  if (!Number.isSafeInteger(free) || free < MAX_GROWTH + DISK_MARGIN)
    throw new Error("FTS refresh disk headroom unavailable");
  const host = memory();
  if (
    host.available < 8 * 1024 ** 3 ||
    (initialSwap !== undefined && host.swap - initialSwap > 512 * MIB)
  )
    throw new Error("FTS refresh host memory admission refused");
  if (pid !== undefined) {
    const status = fs.readFileSync(`/proc/${pid}/status`, "utf8");
    const rss = /^VmRSS:\s+(\d+) kB$/m.exec(status);
    if (!rss || Number(rss[1]) * 1024 > MAX_RSS)
      throw new Error("FTS refresh helper RSS limit exceeded or unavailable");
  }
  resourceBudget.check();
}

function tableBytes(table: string): number {
  const pending = [table];
  let count = 0,
    bytes = 0;
  while (pending.length) {
    const directory = fs.opendirSync(pending.pop()!);
    try {
      for (;;) {
        const entry = directory.readSync();
        if (!entry) break;
        if (++count > MAX_FILES || entry.isSymbolicLink())
          throw new Error("FTS refresh table inventory refused");
        const file = path.join(directory.path, entry.name);
        if (entry.isDirectory()) pending.push(file);
        else if (entry.isFile()) bytes += fs.statSync(file).size;
        else throw new Error("FTS refresh nonregular table entry");
      }
    } finally {
      directory.closeSync();
    }
  }
  return bytes;
}

export interface FtsRefreshRequest {
  table: string;
  run?: boolean;
  check?: boolean;
  expectedVersion?: number;
  acknowledgeUncertain?: string;
  signal?: AbortSignal;
}

/** Standalone owner: refuses live readers/writers, never stops another service.
 * Native execution is explicit only; there is no scheduling or optimize fallback. */
export async function refreshFtsStore(request: FtsRefreshRequest) {
  request.signal?.throwIfAborted();
  const table = localTable(request.table);
  const store = path.dirname(table);
  const state = readFtsRefreshState(store);
  if (!request.run && !request.check)
    return { outcome: "status", table, state, fullTableRewriting: "disabled" };
  if (
    !Number.isSafeInteger(request.expectedVersion) ||
    request.expectedVersion! < 1
  )
    throw new Error("FTS refresh requires a positive --expected-version");
  if (request.run && request.check)
    throw new Error("Choose either --check or --run");
  check(store);
  const signal = request.signal
    ? AbortSignal.any([request.signal, AbortSignal.timeout(MAX_MS)])
    : AbortSignal.timeout(MAX_MS);
  // Acquire before runtime setup: a live daemon must refuse promptly. Setup is
  // bounded and shares the same non-resetting deadline as native execution.
  const lease = await StoreLease.acquireExclusive({
    storeDir: store,
    timeoutMs: 1000,
    signal,
    role: "explicit-fts-refresh",
  });
  try {
    const reserve = resourceBudget.reserve(1024, "fts-runtime");
    let runtime: CleanupRuntime;
    try {
      runtime = await prepareCleanupRuntime(signal);
    } finally {
      reserve.release();
    }
    const result = await runFtsRefresh(runtime, table, lease, {
      ...request,
      signal,
    });
    return {
      outcome: result.outcome,
      table,
      result,
      state: readFtsRefreshState(store),
      fullTableRewriting: "disabled",
    };
  } finally {
    await lease.release();
  }
}

/** Use only the pinned helper beside prune.py. Tests can supply a private pinned
 * runtime. Keep the helper registered as lease owner until close, even on abort. */
export async function runFtsRefresh(
  runtime: CleanupRuntime,
  input: string,
  lease: StoreLease,
  request: FtsRefreshRequest,
): Promise<FtsRefreshResult> {
  const table = localTable(input);
  const store = path.dirname(table);
  if (!(lease instanceof StoreLease))
    throw new Error("FTS refresh requires a StoreLease");
  if (
    !Number.isSafeInteger(request.expectedVersion) ||
    request.expectedVersion! < 1
  )
    throw new Error("FTS refresh requires a positive --expected-version");
  check(store);
  const initialSwap = memory().swap;
  let attempt: FtsRefreshState | undefined;
  try {
    const result = await lease.withExclusiveUse(store, async () => {
      const previous = readFtsRefreshState(store);
      if (
        request.run &&
        previous?.outcome === "uncertain" &&
        request.acknowledgeUncertain !== previous.attemptId
      )
        throw new Error(
          `Inspect the interrupted attempt, then use --acknowledge-uncertain ${previous.attemptId} before retry`,
        );
      const beforeBytes = tableBytes(table);
      const reservation = resourceBudget.reserve(1024, "fts-refresh");
      let unpin: (() => void) | undefined;
      let childPid: number | undefined;
      try {
        const output = await runCleanupProcess(
          runtime.python,
          [
            "-I",
            path.join(path.dirname(runtime.script), "fts.py"),
            "--table",
            table,
            "--expected-version",
            String(request.expectedVersion),
            "--lease-owner",
            storeLeasePaths(store).intentOwnerFile,
            "--lease-nonce",
            lease.owner.nonce,
            ...(request.run ? ["--run"] : []),
          ],
          {
            signal: request.signal,
            env: { LANCE_IO_THREADS: "2", LANCE_AUTO_MIGRATION: "false" },
            timeoutMs: MAX_MS,
            admission: {
              nonce: lease.owner.nonce,
              start: (pid) => {
                unpin = lease.pinExclusiveHelper(pid);
                childPid = pid;
                reservation.attach(pid);
              },
              approve: () => {
                check(store, initialSwap, childPid);
                request.signal?.throwIfAborted();
                if (request.run) {
                  attempt = {
                    schemaVersion: 1,
                    storeIdentity: store,
                    attemptId: randomUUID(),
                    expectedVersion: request.expectedVersion!,
                    startedAt: Date.now(),
                    outcome: "running",
                    previousUncertainAttemptId:
                      previous?.outcome === "uncertain"
                        ? previous.attemptId
                        : previous?.previousUncertainAttemptId,
                  };
                  writeState(attempt);
                }
              },
              check: () => {
                check(store, initialSwap, childPid);
                if (tableBytes(table) - beforeBytes > MAX_GROWTH)
                  throw new Error(
                    "FTS refresh sampled disk growth exceeded limit",
                  );
              },
              close: () => {
                unpin?.();
              },
            },
          },
        );
        const result: FtsRefreshResult = JSON.parse(output);
        if (!validResult(result, request.expectedVersion!, !!request.run))
          throw new Error("Invalid FTS result; completion is uncertain");
        return result;
      } finally {
        reservation.release();
      }
    });
    // withExclusiveUse performs its final ownership check after the callback.
    // The caller still holds the lease through this synchronous transition.
    if (attempt)
      writeState({
        ...attempt,
        outcome: "completed",
        finishedAt: Date.now(),
        result,
      });
    return result;
  } catch (error) {
    if (attempt)
      writeState({ ...attempt, outcome: "uncertain", finishedAt: Date.now() });
    throw error;
  }
}
