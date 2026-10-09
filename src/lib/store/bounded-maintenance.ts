import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { resourceBudget } from "../utils/resource-budget";
import { type CompactionResult, skippedCompaction } from "./compaction-result";
import {
  assertStoreMutationAllowed,
  availableStoreDiskBytes,
} from "./maintenance-policy";
import { type StoreLease, storeLeasePaths } from "./store-lease";

export const MAX_BOUNDED_TOTAL_WRITE_BYTES = 512 * 1024 ** 2;
export const BOUNDED_FREE_SPACE_MARGIN_BYTES = 1024 ** 3;
export const BOUNDED_MAINTENANCE_BLOCKED_REASON =
  "deleted-row cleanup deferred: a qualified native helper enforcing total data, search-index and temporary writes is unavailable; automatic version cleanup remains enabled";

export interface BoundedMaintenancePlan {
  protocolVersion: 1;
  engine: "12.0.0";
  status: "blocked" | "no-work" | "qualified";
  reason?: string;
  expectedVersion: number;
  planId: string;
  totalWriteBudgetBytes: number;
  freeSpaceMarginBytes: number;
  dataWriteBoundBytes: number | null;
  indexWriteBoundBytes: number | null;
  metadataWriteBoundBytes: number | null;
  verificationWriteBoundBytes: number | null;
  totalWriteBoundBytes: number | null;
  budgetKind: "cumulative-writes";
  nativeTotalWriteBudgetEnforced: boolean;
  rewritten: false;
}

function bytes(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

/** Advisory startup routing only. Pending or unrecognized state always goes
 * to the native recovery verifier; this never authorizes mutation or cleanup.
 * A historical, complete finalized receipt needs no helper to start writers. */
export function boundedMaintenanceReceiptState(
  storeDir: string,
): "missing" | "finalized" | "pending" | "unknown" {
  const file = path.join(
    storeDir,
    "chunks.lance",
    "_gmax-bounded-receipt.json",
  );
  let fd: number | undefined;
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 64 * 1024)
      return "unknown";
    fd = fs.openSync(
      file,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
    );
    const opened = fs.fstatSync(fd);
    if (
      !opened.isFile() ||
      opened.dev !== stat.dev ||
      opened.ino !== stat.ino ||
      opened.nlink !== 1
    )
      return "unknown";
    const buffer = Buffer.alloc(64 * 1024 + 1);
    const count = fs.readSync(fd, buffer, 0, buffer.length, 0);
    if (count > 64 * 1024) return "unknown";
    const r = JSON.parse(buffer.subarray(0, count).toString("utf8"));
    if (r.protocolVersion !== 2) return "unknown";
    if (r.phase !== "finalized") return "pending";
    const hash = (value: unknown) =>
      typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
    const identity =
      typeof r.receiptId === "string" &&
      /^[a-zA-Z0-9-]{1,128}$/.test(r.receiptId);
    if (
      !identity ||
      !hash(r.planId) ||
      !bytes(r.beforeVersion) ||
      r.beforeVersion < 1 ||
      !bytes(r.afterVersion) ||
      r.afterVersion < r.beforeVersion ||
      !bytes(r.totalWriteBudgetBytes) ||
      r.totalWriteBudgetBytes < 1 ||
      r.totalWriteBudgetBytes > MAX_BOUNDED_TOTAL_WRITE_BYTES ||
      r.journal !== `_gmax-maintenance-${r.receiptId}.journal` ||
      r.ownedWrites !== `_gmax-owned-${r.receiptId}.jsonl` ||
      !hash(r.beforeFingerprint) ||
      !hash(r.acceptedFingerprint) ||
      (!hash(r.sourceRowsDigest) &&
        !(
          r.sourceRowsDigest === "" &&
          r.aborted === true &&
          r.abortProven === true &&
          r.rowsVerified === 0
        )) ||
      !bytes(r.sourceBytes) ||
      r.sourceBytes > MAX_BOUNDED_TOTAL_WRITE_BYTES ||
      !bytes(r.rowsVerified) ||
      typeof r.aborted !== "boolean" ||
      typeof r.abortProven !== "boolean" ||
      (r.aborted && !r.abortProven) ||
      !Array.isArray(r.retiredMetadata) ||
      r.retiredMetadata.length !== 0 ||
      !Array.isArray(r.selectedFragmentIds) ||
      !r.selectedFragmentIds.every(bytes) ||
      typeof r.readerTag !== "string" ||
      typeof r.afterTag !== "string" ||
      !r.originalTags ||
      typeof r.originalTags !== "object" ||
      Array.isArray(r.originalTags) ||
      !Object.values(r.originalTags).every(
        (version) => bytes(version) && version > 0,
      )
    )
      return "unknown";
    return "finalized";
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT"
      ? "missing"
      : "unknown";
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/** Validate the read-only qualification protocol, never treat a helper's claimed
 * qualification as proof of an enforced write limit. Execution requires the
 * separately verified protocol-2 metered helper, not this candidate object. */
export function parseBoundedMaintenancePlan(
  value: unknown,
  expectedVersion: number,
): Readonly<BoundedMaintenancePlan> {
  if (!value || typeof value !== "object")
    throw new Error("invalid bounded cleanup plan");
  const p = value as BoundedMaintenancePlan;
  if (
    p.protocolVersion !== 1 ||
    p.engine !== "12.0.0" ||
    p.budgetKind !== "cumulative-writes" ||
    p.rewritten !== false ||
    typeof p.nativeTotalWriteBudgetEnforced !== "boolean" ||
    !["blocked", "no-work", "qualified"].includes(p.status) ||
    !Number.isSafeInteger(expectedVersion) ||
    expectedVersion < 1 ||
    p.expectedVersion !== expectedVersion ||
    typeof p.planId !== "string" ||
    !/^[a-f0-9]{64}$/.test(p.planId) ||
    (p.reason !== undefined &&
      (typeof p.reason !== "string" || p.reason.length > 512))
  )
    throw new Error("invalid or stale bounded cleanup plan");
  const components = [
    p.dataWriteBoundBytes,
    p.indexWriteBoundBytes,
    p.metadataWriteBoundBytes,
    p.verificationWriteBoundBytes,
  ];
  if (
    !bytes(p.totalWriteBudgetBytes) ||
    p.totalWriteBudgetBytes === 0 ||
    !bytes(p.freeSpaceMarginBytes) ||
    p.totalWriteBudgetBytes > MAX_BOUNDED_TOTAL_WRITE_BYTES ||
    p.freeSpaceMarginBytes < BOUNDED_FREE_SPACE_MARGIN_BYTES ||
    !Number.isSafeInteger(p.totalWriteBudgetBytes + p.freeSpaceMarginBytes) ||
    (p.status === "blocked" && !p.reason)
  )
    throw new Error("bounded cleanup total-write budget is invalid or unknown");
  const sum = components.reduce<number>((a, b) => a + (b ?? 0), 0);
  if (
    p.status === "blocked"
      ? ![...components, p.totalWriteBoundBytes].every((v) => v === null) ||
        p.nativeTotalWriteBudgetEnforced
      : !components.every(bytes) ||
        !bytes(p.totalWriteBoundBytes) ||
        !Number.isSafeInteger(sum) ||
        sum !== p.totalWriteBoundBytes ||
        p.totalWriteBoundBytes > p.totalWriteBudgetBytes ||
        (p.status === "no-work" && sum !== 0) ||
        (p.status === "qualified" &&
          (sum === 0 || !p.nativeTotalWriteBudgetEnforced))
  )
    throw new Error("bounded cleanup total-write bound is invalid or unknown");
  // Freeze a new primitive-only copy: later changes to helper output cannot
  // lower the checks during admission or reuse a different table head.
  return Object.freeze({
    protocolVersion: p.protocolVersion,
    engine: p.engine,
    status: p.status,
    reason: p.reason,
    expectedVersion: p.expectedVersion,
    planId: p.planId,
    totalWriteBudgetBytes: p.totalWriteBudgetBytes,
    freeSpaceMarginBytes: p.freeSpaceMarginBytes,
    dataWriteBoundBytes: p.dataWriteBoundBytes,
    indexWriteBoundBytes: p.indexWriteBoundBytes,
    metadataWriteBoundBytes: p.metadataWriteBoundBytes,
    verificationWriteBoundBytes: p.verificationWriteBoundBytes,
    totalWriteBoundBytes: p.totalWriteBoundBytes,
    budgetKind: p.budgetKind,
    nativeTotalWriteBudgetEnforced: p.nativeTotalWriteBudgetEnforced,
    rewritten: p.rewritten,
  });
}

/** Candidate admission only. Fresh disk and configured host checks are necessary
 * but insufficient: they do not prove a bound or authorize native execution.
 * Reserve the full budget on every sample, without guessing helper progress. */
export function checkBoundedMaintenanceCandidate(
  storeDir: string,
  candidate: unknown,
  expectedVersion: number,
  signal?: AbortSignal,
): Readonly<BoundedMaintenancePlan> {
  signal?.throwIfAborted();
  const plan = parseBoundedMaintenancePlan(candidate, expectedVersion);
  if (plan.status !== "qualified")
    throw new Error(plan.reason ?? "bounded cleanup has no qualified work");
  assertStoreMutationAllowed();
  const free = availableStoreDiskBytes(storeDir);
  if (
    !Number.isSafeInteger(free) ||
    free < plan.totalWriteBudgetBytes + plan.freeSpaceMarginBytes
  )
    throw new Error("bounded cleanup total-write disk headroom unavailable");
  resourceBudget.check();
  signal?.throwIfAborted();
  return plan;
}

/** Missing/unqualified packaged artifacts cannot enable native writes. */
export function boundedMaintenanceUnavailable(): CompactionResult {
  return skippedCompaction(BOUNDED_MAINTENANCE_BLOCKED_REASON);
}

export interface BoundedMaintenanceRuntime {
  executable: string;
  args?: string[];
}

export interface MaintenanceReaderProtection {
  beforeVersion: number;
  protectedVersion: number;
  planId: string;
  readerTag: string;
  receiptId: string;
}

export interface MeteredMaintenancePlan {
  protocolVersion: 2;
  engine: "12.0.0";
  status: "qualified" | "no-work";
  expectedVersion: number;
  beforeVersion: number;
  protectedVersion: number;
  action: "run" | "recover";
  planId: string;
  budgetKind: "cumulative-writes";
  nativeTotalWriteBudgetEnforced: true;
  effectiveStoreScheme: "file-object-store";
  sharedTotalWriteCapBytes: number;
  totalWriteBudgetBytes: number;
  freeSpaceMarginBytes: number;
}

export interface BoundedMaintenanceResult extends CompactionResult {
  rewritten: boolean;
  beforeVersion: number;
  protectedVersion: number;
  afterVersion: number;
  totalBytesWritten: number;
  dataBytesWritten: number;
  indexBytesWritten: number;
  metadataBytesWritten: number;
  verificationBytesWritten: number;
  rowsVerified: number;
  remainingDeletedRows: number;
  aborted: boolean;
  recoveryPending?: boolean;
  verifiedCopyVersion?: number;
  acceptedFinalization?: boolean;
  planId: string;
  receiptId: string;
}

/** Execution uses one non-resetting native ledger, not estimated component
 * sizes. Packaging verifies this executable and its pinned source separately. */
export function parseMeteredMaintenancePlan(
  value: unknown,
  expectedVersion: number,
  action: "run" | "recover" = "run",
): Readonly<MeteredMaintenancePlan> {
  if (!value || typeof value !== "object")
    throw new Error("invalid metered plan");
  const input = value as MeteredMaintenancePlan;
  // A no-work plan opens no protected window. Older native no-work responses
  // omit this field; no mutating plan may inherit a guessed protection version.
  const p = {
    ...input,
    protectedVersion:
      input.status === "no-work" && input.protectedVersion === undefined
        ? expectedVersion
        : input.protectedVersion,
  };
  if (
    p.protocolVersion !== 2 ||
    p.engine !== "12.0.0" ||
    !["qualified", "no-work"].includes(p.status) ||
    !Number.isSafeInteger(expectedVersion) ||
    expectedVersion < 1 ||
    p.expectedVersion !== expectedVersion ||
    p.action !== action ||
    !Number.isSafeInteger(p.beforeVersion) ||
    p.beforeVersion < 1 ||
    p.beforeVersion > expectedVersion ||
    !Number.isSafeInteger(p.protectedVersion) ||
    p.protectedVersion < 1 ||
    p.protectedVersion > expectedVersion ||
    (action === "run" && p.beforeVersion !== expectedVersion) ||
    (action === "run" && p.protectedVersion !== p.beforeVersion) ||
    (action === "recover" && p.protectedVersion !== expectedVersion) ||
    !/^[a-f0-9]{64}$/.test(p.planId ?? "") ||
    p.budgetKind !== "cumulative-writes" ||
    p.nativeTotalWriteBudgetEnforced !== true ||
    p.effectiveStoreScheme !== "file-object-store" ||
    !bytes(p.totalWriteBudgetBytes) ||
    p.totalWriteBudgetBytes < 1 ||
    p.totalWriteBudgetBytes > MAX_BOUNDED_TOTAL_WRITE_BYTES ||
    p.sharedTotalWriteCapBytes !== p.totalWriteBudgetBytes ||
    !bytes(p.freeSpaceMarginBytes) ||
    p.freeSpaceMarginBytes < BOUNDED_FREE_SPACE_MARGIN_BYTES ||
    !Number.isSafeInteger(p.totalWriteBudgetBytes + p.freeSpaceMarginBytes)
  )
    throw new Error("native total-write enforcement or frozen plan is invalid");
  return Object.freeze({ ...p });
}

function checkMeteredAdmission(
  storeDir: string,
  signal?: AbortSignal,
  budget = MAX_BOUNDED_TOTAL_WRITE_BYTES,
  margin = BOUNDED_FREE_SPACE_MARGIN_BYTES,
): void {
  signal?.throwIfAborted();
  assertStoreMutationAllowed();
  const free = availableStoreDiskBytes(storeDir);
  if (!Number.isSafeInteger(free) || free < budget + margin)
    throw new Error("bounded cleanup total-write disk headroom unavailable");
  resourceBudget.check();
  signal?.throwIfAborted();
}

function protection(
  phase: Record<string, unknown>,
  plan: Readonly<MeteredMaintenancePlan>,
): MaintenanceReaderProtection {
  if (
    phase.beforeVersion !== plan.beforeVersion ||
    phase.protectedVersion !== plan.protectedVersion ||
    phase.planId !== plan.planId ||
    typeof phase.readerTag !== "string" ||
    !/^[a-zA-Z0-9_-]{1,128}$/.test(phase.readerTag) ||
    typeof phase.receiptId !== "string" ||
    !/^[a-zA-Z0-9_-]{1,128}$/.test(phase.receiptId)
  )
    throw new Error("durable before-head reader protection is invalid");
  return {
    beforeVersion: plan.beforeVersion,
    protectedVersion: plan.protectedVersion,
    planId: plan.planId,
    readerTag: phase.readerTag,
    receiptId: phase.receiptId,
  };
}

class NativeMaintenanceRefusal extends Error {}

/** Keep useful failure categories without returning native paths, arbitrary
 * diagnostics or source content from the child process. */
function nativeRefusal(value: unknown): NativeMaintenanceRefusal {
  const reason = typeof value === "string" ? value : "";
  const category = /recover.required|unfinished.*receipt/i.test(reason)
    ? "previous cleanup requires native recovery"
    : /index.*(?:fit|budget|bound|footprint)/i.test(reason)
      ? "search-index updates do not fit the total-write cap"
      : /disk|space|free.bytes|margin|ENOSPC/i.test(reason)
        ? "native disk headroom unavailable"
        : /ledger|budget|charge|write.cap|journal/i.test(reason)
          ? "native write budget or ledger verification refused"
          : /owner|lease|helper.*alive/i.test(reason)
            ? "exclusive store ownership refused"
            : /head|version|tag|fingerprint|candidate/i.test(reason)
              ? "protected table state or recovery proof changed"
              : "native cleanup admission or verification refused";
  return new NativeMaintenanceRefusal(category);
}

/** Single child owns its cumulative ledger and durable receipts through final
 * tag release. Any failed handshake is uncertain: kill and await child close,
 * retain native tags/receipt, and never launch a second copy here. */
export async function runBoundedMaintenance(
  storeDir: string,
  lease: StoreLease,
  expectedVersion: number,
  runtime: BoundedMaintenanceRuntime,
  readers: {
    open: (p: MaintenanceReaderProtection) => Promise<void> | void;
    drain: () => Promise<void>;
  },
  signal?: AbortSignal,
  action: "run" | "recover" = "run",
): Promise<BoundedMaintenanceResult> {
  const discoveryBudget =
    action === "recover" ? 0 : MAX_BOUNDED_TOTAL_WRITE_BYTES;
  checkMeteredAdmission(storeDir, signal, discoveryBudget);
  if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1)
    throw new Error("invalid bounded cleanup before-version");
  const started = Date.now();
  const reservation = resourceBudget.reserve(512, "bounded-cleanup");
  try {
    return await lease.withExclusiveUse(storeDir, async () => {
      checkMeteredAdmission(storeDir, signal, discoveryBudget);
      return await new Promise<BoundedMaintenanceResult>((resolve, reject) => {
        const env: NodeJS.ProcessEnv = {};
        for (const key of ["PATH", "HOME", "TMPDIR", "TEMP", "SystemRoot"])
          if (process.env[key] !== undefined) env[key] = process.env[key];
        const child = spawn(runtime.executable, runtime.args ?? [], {
          env: {
            ...env,
            RAYON_NUM_THREADS: "1",
            TOKIO_WORKER_THREADS: "1",
            LANCE_CPU_THREADS: "1",
            LANCE_IO_THREADS: "1",
            LANCE_DEFAULT_IO_BUFFER_SIZE: String(32 * 1024 ** 2),
          },
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
        });
        let buffer = "";
        let outputBytes = 0;
        let failure: Error | undefined;
        let state:
          | "launch"
          | "ready"
          | "protect"
          | "drain"
          | "result"
          | "done" = "launch";
        let plan: Readonly<MeteredMaintenancePlan> | undefined;
        let protectedReaders: MaintenanceReaderProtection | undefined;
        let result: BoundedMaintenanceResult | undefined;
        let spent = [0, 0, 0, 0];
        let unpin: (() => void) | undefined;
        let killTimer: ReturnType<typeof setTimeout> | undefined;
        let phases = Promise.resolve();
        const stop = (reason: string, cause?: unknown) => {
          if (!failure) {
            failure = new Error(
              `${reason}; bounded cleanup completion is uncertain`,
            );
            if (cause !== undefined)
              Object.defineProperty(failure, "cause", { value: cause });
          }
          child.kill("SIGTERM");
          killTimer ??= setTimeout(() => child.kill("SIGKILL"), 1000);
        };
        const abort = () => stop("Bounded cleanup cancelled");
        const deadline = setTimeout(
          () => stop("Bounded cleanup timed out"),
          90_000,
        );
        const monitor = setInterval(() => {
          try {
            // The native ledger admits every charge against the actual remaining
            // allowance. A stale full-cap check here counts our own writes twice.
            checkMeteredAdmission(storeDir, signal, 0);
          } catch {
            stop("Bounded cleanup resource/disk admission refused");
          }
        }, 1000);
        const acknowledge = () => {
          if (failure || signal?.aborted)
            throw new Error("bounded cleanup cancelled before acknowledgement");
          child.stdin.write(`${lease.owner.nonce}\n`);
        };
        const admitCounters = (phase: Record<string, unknown>) => {
          if (!plan) throw new Error("native counters arrived without a plan");
          const fields = [
            "dataBytesWritten",
            "indexBytesWritten",
            "metadataBytesWritten",
            "verificationBytesWritten",
          ];
          const missingNoWork =
            plan.status === "no-work" &&
            phase.totalBytesWritten === undefined &&
            fields.every((field) => phase[field] === undefined);
          const counters = missingNoWork
            ? [0, 0, 0, 0]
            : fields.map((field) => phase[field]);
          const total = counters.reduce<number>(
            (sum, n) => sum + (typeof n === "number" ? n : Number.NaN),
            0,
          );
          if (
            !counters.every(bytes) ||
            !Number.isSafeInteger(total) ||
            (!missingNoWork && total !== phase.totalBytesWritten) ||
            total > plan.totalWriteBudgetBytes ||
            (plan.status === "no-work" && total !== 0) ||
            counters.some((n, i) => (n as number) < spent[i])
          )
            throw new Error("native cumulative write counters are invalid");
          spent = counters as number[];
          checkMeteredAdmission(
            storeDir,
            signal,
            plan.status === "no-work" ? 0 : plan.totalWriteBudgetBytes - total,
            plan.freeSpaceMarginBytes,
          );
          return total;
        };
        const handle = async (line: string) => {
          if (failure) return;
          const phase = JSON.parse(line) as Record<string, unknown>;
          if (phase.phase === "error") throw nativeRefusal(phase.reason);
          if (state === "launch" && phase.phase === "launch") {
            checkMeteredAdmission(storeDir, signal, discoveryBudget);
            state = "ready";
            acknowledge();
          } else if (state === "ready" && phase.phase === "ready") {
            plan = parseMeteredMaintenancePlan(
              phase.plan,
              expectedVersion,
              action,
            );
            admitCounters(phase);
            state = plan.status === "no-work" ? "result" : "protect";
            acknowledge();
          } else if (
            state === "protect" &&
            phase.phase === "protected-read-ready" &&
            plan
          ) {
            protectedReaders = protection(phase, plan);
            admitCounters(phase);
            await readers.open(protectedReaders);
            state = "drain";
            acknowledge();
          } else if (
            state === "drain" &&
            phase.phase === "reader-drain" &&
            plan &&
            protectedReaders
          ) {
            const p = protection(phase, plan);
            if (
              p.readerTag !== protectedReaders.readerTag ||
              p.receiptId !== protectedReaders.receiptId
            )
              throw new Error(
                "reader protection identity changed before finalization",
              );
            await readers.drain();
            admitCounters(phase);
            state = "result";
            acknowledge();
          } else if (state === "result" && phase.phase === "result" && plan) {
            const total = admitCounters(phase);
            const counters = [
              phase.dataBytesWritten,
              phase.indexBytesWritten,
              phase.metadataBytesWritten,
              phase.verificationBytesWritten,
            ];
            if (
              !counters.every(bytes) ||
              !bytes(phase.totalBytesWritten) ||
              !Number.isSafeInteger(total) ||
              total !== phase.totalBytesWritten ||
              total > plan.totalWriteBudgetBytes ||
              phase.beforeVersion !== plan.beforeVersion ||
              !Number.isSafeInteger(phase.afterVersion) ||
              (phase.afterVersion as number) < expectedVersion ||
              (action === "recover" &&
                phase.afterVersion !== expectedVersion) ||
              phase.planId !== plan.planId ||
              !bytes(phase.rowsVerified) ||
              !bytes(phase.remainingDeletedRows) ||
              (phase.recoveryPending !== undefined &&
                typeof phase.recoveryPending !== "boolean") ||
              (action === "recover" &&
                plan.status === "no-work" &&
                phase.recoveryPending !== false) ||
              (plan.status === "qualified" &&
                typeof phase.aborted !== "boolean") ||
              (phase.aborted === true &&
                (action !== "recover" || phase.rowsVerified !== 0)) ||
              (phase.verifiedCopyVersion !== undefined &&
                phase.verifiedCopyVersion !== null &&
                (!bytes(phase.verifiedCopyVersion) ||
                  phase.verifiedCopyVersion < plan.beforeVersion ||
                  phase.verifiedCopyVersion >
                    (phase.afterVersion as number))) ||
              (action === "recover" &&
                phase.aborted !== true &&
                bytes(phase.verifiedCopyVersion) &&
                phase.verifiedCopyVersion < expectedVersion &&
                phase.acceptedFinalization !== true) ||
              (phase.acceptedFinalization !== undefined &&
                typeof phase.acceptedFinalization !== "boolean") ||
              typeof phase.receiptId !== "string" ||
              (protectedReaders &&
                phase.receiptId !== protectedReaders.receiptId) ||
              (plan.status === "qualified" &&
                phase.status !==
                  (action === "recover" ? "recovered" : "committed")) ||
              (plan.status === "no-work" &&
                (phase.status !== "no-work" ||
                  phase.afterVersion !== expectedVersion))
            )
              throw new Error(
                "bounded cleanup final ledger or commit verification is invalid",
              );
            result = {
              status:
                plan.status === "no-work"
                  ? "skipped"
                  : phase.recoveryPending === true
                    ? "failed"
                    : "completed",
              at: Date.now(),
              attempts: 1,
              elapsedMs: Date.now() - started,
              reason:
                plan.status === "no-work"
                  ? action === "recover"
                    ? "no native recovery is pending"
                    : "no deleted-row cleanup work"
                  : phase.aborted === true
                    ? phase.recoveryPending === true
                      ? "copy abandoned; owned-file cleanup remains pending and deleted rows remain"
                      : "unfinished copy discarded; deleted rows remain in the current table"
                    : action === "recover"
                      ? "previously verified copy finalized under its original write ledger"
                      : "deleted rows reclaimed within shared native write cap",
              rewritten: action === "run" && plan.status !== "no-work",
              beforeVersion: plan.beforeVersion,
              protectedVersion: plan.protectedVersion,
              afterVersion: phase.afterVersion as number,
              totalBytesWritten: total,
              dataBytesWritten: phase.dataBytesWritten as number,
              indexBytesWritten: phase.indexBytesWritten as number,
              metadataBytesWritten: phase.metadataBytesWritten as number,
              verificationBytesWritten:
                phase.verificationBytesWritten as number,
              rowsVerified: phase.rowsVerified as number,
              remainingDeletedRows: phase.remainingDeletedRows as number,
              aborted: phase.aborted === true,
              ...(typeof phase.recoveryPending === "boolean"
                ? { recoveryPending: phase.recoveryPending }
                : {}),
              ...(bytes(phase.verifiedCopyVersion)
                ? { verifiedCopyVersion: phase.verifiedCopyVersion }
                : {}),
              ...(typeof phase.acceptedFinalization === "boolean"
                ? { acceptedFinalization: phase.acceptedFinalization }
                : {}),
              ...(bytes(phase.freeBytesBefore)
                ? { freeBytesBefore: phase.freeBytesBefore }
                : {}),
              ...(bytes(phase.freeBytesAfter)
                ? { freeBytesAfter: phase.freeBytesAfter }
                : {}),
              ...(bytes(phase.allocatedBytesBefore)
                ? { diskBytesBefore: phase.allocatedBytesBefore }
                : {}),
              ...(bytes(phase.allocatedBytesAfter)
                ? { diskBytesAfter: phase.allocatedBytesAfter }
                : {}),
              planId: plan.planId,
              receiptId: phase.receiptId,
            };
            state = "done";
          } else throw new Error("unexpected bounded cleanup phase");
        };
        signal?.addEventListener("abort", abort, { once: true });
        child.stdout.on("data", (data: Buffer) => {
          outputBytes += data.length;
          if (outputBytes > 128 * 1024)
            return stop("Bounded cleanup output exceeded limit");
          buffer += data.toString("utf8");
          let end = buffer.indexOf("\n");
          while (end >= 0) {
            const line = buffer.slice(0, end);
            buffer = buffer.slice(end + 1);
            phases = phases
              .then(() => handle(line))
              .catch((error: unknown) =>
                stop(
                  error instanceof NativeMaintenanceRefusal
                    ? error.message
                    : "Bounded cleanup phase admission refused",
                  error,
                ),
              );
            end = buffer.indexOf("\n");
          }
        });
        child.stderr.on("data", (data: Buffer) => {
          outputBytes += data.length;
          if (outputBytes > 128 * 1024)
            stop("Bounded cleanup output exceeded limit");
        });
        child.stdin.on("error", () =>
          stop("Bounded cleanup admission pipe failed"),
        );
        child.once("error", (error: NodeJS.ErrnoException) => {
          failure ??= new Error(
            `Bounded cleanup launch failed (${error.code ?? "unknown"})`,
          );
        });
        child.once("exit", () => {
          clearTimeout(deadline);
          clearInterval(monitor);
        });
        child.once("close", (code, exitSignal) => {
          void phases.then(() => {
            clearTimeout(deadline);
            clearInterval(monitor);
            if (killTimer) clearTimeout(killTimer);
            signal?.removeEventListener("abort", abort);
            try {
              unpin?.();
            } catch {
              failure ??= new Error(
                "bounded cleanup helper ownership close failed",
              );
            }
            if (failure) reject(failure);
            else if (
              code !== 0 ||
              exitSignal ||
              state !== "done" ||
              !result ||
              buffer.trim()
            )
              reject(
                new Error(
                  "bounded cleanup exited without verified receipt; completion is uncertain",
                ),
              );
            else resolve(result);
          });
        });
        try {
          if (!child.pid) throw new Error("helper PID unavailable");
          unpin = lease.pinExclusiveHelper(child.pid);
          reservation.attach(child.pid);
          child.stdin.write(
            `${JSON.stringify({
              protocolVersion: 2,
              action,
              store: path.join(storeDir, "chunks.lance"),
              expectedVersion,
              totalWriteBudgetBytes: MAX_BOUNDED_TOTAL_WRITE_BYTES,
              freeSpaceMarginBytes: BOUNDED_FREE_SPACE_MARGIN_BYTES,
              sourceLimitBytes: 512 * 1024 ** 2,
              leaseOwner: storeLeasePaths(storeDir).intentOwnerFile,
              leaseNonce: lease.owner.nonce,
            })}\n`,
          );
          if (signal?.aborted) abort();
        } catch {
          stop("Bounded cleanup helper ownership/resource admission refused");
        }
      });
    });
  } finally {
    reservation.release();
  }
}
