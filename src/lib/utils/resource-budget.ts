import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import lockfile from "proper-lockfile";
import { PATHS } from "../../config";
import { daemonStartDeniedReason } from "./autostart";
import {
  type HostGuardPolicy,
  hostGuardPolicy,
  sampleCriticalPressure,
} from "./host-guard-policy";
import {
  type HostResourceSnapshot,
  type ResourceSamplerDeps,
  sampleHostResources,
} from "./host-resource";
import {
  resourceStopDiagnostics,
  type SafetyStopDiagnostics,
} from "./pressure-diagnostics";
import { latchSafetyStop } from "./safety-latch";

/** Admission thresholds, not an OS-enforced memory cap. Keep enough room for
 * a worker's measured 1536MiB recycle threshold, and charge pending launches
 * before another session can admit work. Actual footprint can exceed a reserve;
 * subsequent admission/heartbeat then pauses heavy work. */
export const DEFAULT_RESOURCE_BUDGET_MB = 6144;
export const WORKER_RESOURCE_RESERVE_MB = 1536;
export const EMBEDDING_RESOURCE_RESERVE_MB = 1024;
export const HELPER_RESOURCE_RESERVE_MB = 512;

export class ResourceAdmissionError extends Error {
  readonly code = "HOST_RESOURCE";
  constructor(
    message: string,
    readonly critical = false,
    public diagnostics?: SafetyStopDiagnostics,
  ) {
    super(message);
    this.name = "ResourceAdmissionError";
  }
}
interface ReservationRecord {
  version: 1;
  pid: number;
  start: string;
  nonce: string;
  mb: number;
  kind: string;
  groupPid?: number;
  unverified?: boolean;
}
export interface ResourceReservation {
  /** Transfer the pending launch charge from its parent to the child. */
  attach: (pid: number, processGroup?: boolean) => void;
  /** Call only after the native connection or child has actually closed. */
  release: () => void;
}
interface BudgetDeps {
  root: string;
  platform: string;
  pid: number;
  now: () => number;
  sample: (extraPids?: readonly number[]) => HostResourceSnapshot;
  signal: (pid: number) => void;
  quarantine: () => string | null;
  latch: (reason: string, diagnostics?: SafetyStopDiagnostics) => void;
  processStart: () => string;
  policy: () => HostGuardPolicy;
  criticalSample: () => HostResourceSnapshot;
  requireClientRegistration: boolean;
  allowMemoryWarning: () => boolean;
  samplerOverrides: Partial<ResourceSamplerDeps>;
  sampleMaxAgeMs: number;
}

export function resolveResourceBudgetMb(
  raw = process.env.GMAX_RESOURCE_BUDGET_MB,
): number {
  if (raw === undefined) return DEFAULT_RESOURCE_BUDGET_MB;
  const n = Number(raw);
  // A malformed/disabled budget must not silently become unlimited.
  if (!Number.isInteger(n) || n < 256 || n > DEFAULT_RESOURCE_BUDGET_MB)
    throw new ResourceAdmissionError("resource budget must be 256..6144 MiB");
  return n;
}

export function assertResourceSnapshot(
  snapshot: HostResourceSnapshot,
  chargedMb: number,
  budgetMb: number,
  now = Date.now(),
  sampleMaxAgeMs = 5000,
  allowMemoryWarning = false,
): void {
  if (
    snapshot.memoryPressure === "critical" ||
    snapshot.kernelPressure === "critical"
  )
    throw new ResourceAdmissionError(
      "critical host pressure; heavy work refused",
      true,
    );
  if (
    (snapshot.memoryPressure === "warn" && !allowMemoryWarning) ||
    snapshot.kernelPressure === "warn"
  )
    throw new ResourceAdmissionError(
      "warning host pressure; heavy work paused",
    );
  if (snapshot.platform !== "darwin") return;
  if (
    now < snapshot.at ||
    now - snapshot.at > sampleMaxAgeMs ||
    snapshot.completedAt < snapshot.at ||
    snapshot.completedAt > now
  )
    throw new ResourceAdmissionError(
      "resource sample stale or clock changed; heavy work paused",
    );
  if (
    snapshot.incompleteReasons.length ||
    snapshot.aggregateFootprintMb === null ||
    (snapshot.memoryPressure !== "normal" &&
      !(allowMemoryWarning && snapshot.memoryPressure === "warn")) ||
    snapshot.kernelPressure !== "ok"
  )
    throw new ResourceAdmissionError(
      `unknown aggregate resources; heavy work paused: ${snapshot.incompleteReasons.join(", ") || "incomplete sample"}`,
    );
  if (
    !Number.isFinite(chargedMb) ||
    chargedMb < 0 ||
    !Number.isFinite(budgetMb) ||
    budgetMb <= 0 ||
    chargedMb > budgetMb
  )
    throw new ResourceAdmissionError(
      `aggregate resource budget exceeded (${Math.ceil(chargedMb)}/${budgetMb} MiB); heavy work paused`,
    );
}

/** One ledger under the shared home, independent of which store a client uses.
 * Reservations survive parent failure and installation; only a verified dead
 * or reused PID may be reaped. Unknown/corrupt owners refuse expansion. */
export class ResourceBudget {
  private readonly deps: BudgetDeps;
  constructor(overrides: Partial<BudgetDeps> = {}) {
    this.deps = {
      root: path.join(PATHS.sharedRoot, "resource-budget"),
      platform: process.platform,
      pid: process.pid,
      now: Date.now,
      sample: (extraPids = []) => {
        const records = this.readExistingRecords();
        return sampleHostResources(
          [...records.map((r) => r.pid), ...extraPids],
          this.deps.samplerOverrides,
          records.flatMap((r) => (r.groupPid ? [r.groupPid] : [])),
        );
      },
      signal: (pid) => process.kill(pid, 0),
      policy: hostGuardPolicy,
      requireClientRegistration: true,
      allowMemoryWarning: () => false,
      samplerOverrides: {},
      sampleMaxAgeMs: 5000,
      criticalSample: sampleCriticalPressure,
      quarantine: daemonStartDeniedReason,
      latch: (reason, diagnostics) =>
        latchSafetyStop(reason, undefined, diagnostics),
      processStart: () =>
        execFileSync("ps", ["-p", String(process.pid), "-o", "lstart="], {
          encoding: "utf8",
          timeout: 500,
          maxBuffer: 1024,
          stdio: ["ignore", "pipe", "ignore"],
        })
          .trim()
          .replace(/\s+/g, " "),
      ...overrides,
    };
  }

  private withLock<T>(fn: () => T): T {
    const { root } = this.deps;
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    const stat = fs.lstatSync(root);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new ResourceAdmissionError("unverified resource budget directory");
    fs.chmodSync(root, 0o700);
    const file = path.join(root, "admission");
    const fd = fs.openSync(
      file,
      fs.constants.O_CREAT | fs.constants.O_NOFOLLOW | fs.constants.O_WRONLY,
      0o600,
    );
    fs.closeSync(fd);
    let release: () => void;
    try {
      // Synchronous sections contain only a <=3s sample and bounded metadata.
      // Competing sessions refuse immediately instead of blocking their tools.
      release = lockfile.lockSync(file, {
        retries: 0,
        stale: 30_000,
        realpath: false,
      });
    } catch {
      throw new ResourceAdmissionError(
        "resource admission busy or unavailable; retry later",
      );
    }
    try {
      return fn();
    } finally {
      release();
    }
  }

  /** Existing-only reads may encounter a critical-only home with no ledger. */
  private readExistingRecords(): ReservationRecord[] {
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(this.deps.root);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new ResourceAdmissionError("unverified resource budget directory");
    return this.readRecords();
  }

  private readRecords(): ReservationRecord[] {
    const entries = fs.readdirSync(this.deps.root);
    if (entries.some((name) => name.endsWith(".tmp")))
      throw new ResourceAdmissionError(
        "interrupted resource reservation; heavy work paused",
      );
    const files = entries.filter((name) => name.endsWith(".json"));
    if (files.length > 128)
      throw new ResourceAdmissionError("resource reservation limit exceeded");
    const records: ReservationRecord[] = [];
    for (const name of files) {
      const file = path.join(this.deps.root, name);
      let record: ReservationRecord;
      try {
        const stat = fs.lstatSync(file);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096)
          throw Error();
        record = JSON.parse(fs.readFileSync(file, "utf8"));
        if (
          record.version !== 1 ||
          !Number.isSafeInteger(record.pid) ||
          record.pid < 1 ||
          typeof record.start !== "string" ||
          !record.start ||
          typeof record.nonce !== "string" ||
          name !== `${record.nonce}.json` ||
          !Number.isFinite(record.mb) ||
          record.mb <= 0 ||
          record.mb > DEFAULT_RESOURCE_BUDGET_MB ||
          (record.unverified !== undefined &&
            typeof record.unverified !== "boolean") ||
          typeof record.kind !== "string"
        )
          throw Error();
      } catch {
        throw new ResourceAdmissionError(
          "unverified resource reservation; heavy work paused",
        );
      }
      if (record.groupPid !== undefined && record.groupPid !== record.pid)
        throw new ResourceAdmissionError("unverified resource process group");
      records.push(record);
    }
    return records;
  }

  private records(snapshot: HostResourceSnapshot): ReservationRecord[] {
    const records: ReservationRecord[] = [];
    for (const record of this.readRecords()) {
      const file = path.join(this.deps.root, `${record.nonce}.json`);
      const live = snapshot.processes.find((p) => p.pid === record.pid);
      if (record.unverified) {
        try {
          this.deps.signal(record.groupPid ? -record.groupPid : record.pid);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ESRCH") {
            fs.unlinkSync(file);
            continue;
          }
        }
        throw new ResourceAdmissionError(
          "unverified launched process; heavy work paused",
        );
      }
      if (live && live.start !== record.start) {
        fs.unlinkSync(file);
        continue;
      }
      if (!live) {
        try {
          this.deps.signal(record.groupPid ? -record.groupPid : record.pid);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ESRCH") {
            fs.unlinkSync(file);
            continue;
          }
        }
        throw new ResourceAdmissionError(
          "resource reservation owner missing or unknown; heavy work paused",
        );
      }
      records.push(record);
    }
    return records;
  }

  private charge(
    snapshot: HostResourceSnapshot,
    records: ReservationRecord[],
  ): number {
    return snapshot.processes.reduce(
      (sum, p) =>
        sum +
        Math.max(
          p.footprintMb ?? Number.NaN,
          records.filter((r) => r.pid === p.pid).reduce((n, r) => n + r.mb, 0),
        ),
      0,
    );
  }

  private persist(record: ReservationRecord): void {
    const file = path.join(this.deps.root, `${record.nonce}.json`);
    const temporary = `${file}.tmp`;
    const fd = fs.openSync(temporary, "wx", 0o600);
    try {
      fs.writeFileSync(fd, JSON.stringify(record));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(temporary, file);
    const dir = fs.openSync(this.deps.root, "r");
    try {
      fs.fsyncSync(dir);
    } finally {
      fs.closeSync(dir);
    }
  }

  private checked(
    snapshot: HostResourceSnapshot,
    records: ReservationRecord[],
    kind?: string,
    mb?: number,
  ): void {
    try {
      assertResourceSnapshot(
        snapshot,
        this.charge(snapshot, records),
        resolveResourceBudgetMb(),
        this.deps.now(),
        this.deps.sampleMaxAgeMs,
        this.deps.allowMemoryWarning(),
      );
      const legacy = snapshot.processes.filter(
        (p) =>
          p.role === "mcp" &&
          !records.some((r) => r.pid === p.pid && r.kind === "client"),
      );
      if (legacy.length && this.deps.requireClientRegistration)
        throw new ResourceAdmissionError(
          `${legacy.length} MCP client(s) need to reconnect after upgrading; heavy work paused`,
        );
    } catch (error) {
      if (error instanceof ResourceAdmissionError && error.critical) {
        error.diagnostics = resourceStopDiagnostics(
          snapshot,
          "strict",
          kind ? "reserve" : "check",
          this.deps.pid,
          kind,
          mb,
        );
        try {
          this.deps.latch(error.message, error.diagnostics);
        } catch {
          error.message += "; safety stop persistence failed";
        }
      }
      throw error;
    }
    const denied = this.deps.quarantine();
    if (denied)
      throw new ResourceAdmissionError(`heavy work refused: ${denied}`);
  }

  /** Registration is metadata-only and must preserve STDIO availability under
   * warning/unknown pressure. It proves this client participates in reservation
   * admission; old clients cannot silently bypass the cross-session budget. */
  registerClient(): ResourceReservation {
    if (this.deps.platform !== "darwin")
      return { attach: () => {}, release: () => {} };
    const start = this.deps.processStart();
    if (!start)
      throw new ResourceAdmissionError("MCP process identity unavailable");
    const record: ReservationRecord = {
      version: 1,
      pid: this.deps.pid,
      start,
      nonce: randomUUID(),
      mb: 128,
      kind: "client",
    };
    this.withLock(() => {
      if (this.readRecords().length >= 128)
        throw new ResourceAdmissionError("resource reservation limit exceeded");
      this.persist(record);
    });
    return {
      attach: () => {
        throw new ResourceAdmissionError("client registration cannot transfer");
      },
      release: () => {
        try {
          fs.unlinkSync(path.join(this.deps.root, `${record.nonce}.json`));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      },
    };
  }

  /** Read-only admission for existing inference, honoring the selected host policy.
   * Never seed/lock/prune the ledger or latch. */
  checkExisting(): HostResourceSnapshot | null {
    if (this.deps.quarantine())
      throw new ResourceAdmissionError("host containment");
    if (this.deps.platform !== "darwin") return null;
    if (this.deps.policy() === "critical-only") {
      const snapshot = this.deps.criticalSample();
      if (
        snapshot.memoryPressure === "critical" ||
        snapshot.kernelPressure === "critical"
      )
        throw new ResourceAdmissionError(
          "critical host pressure; existing inference refused",
          true,
        );
      if (this.deps.quarantine())
        throw new ResourceAdmissionError("host containment");
      return snapshot;
    }
    const records = this.readExistingRecords();
    const snapshot = this.deps.sample();
    assertResourceSnapshot(
      snapshot,
      this.charge(snapshot, records),
      resolveResourceBudgetMb(),
      this.deps.now(),
      this.deps.sampleMaxAgeMs,
      this.deps.allowMemoryWarning(),
    );
    if (this.deps.quarantine())
      throw new ResourceAdmissionError("host containment");
    return snapshot;
  }

  check(
    requiredPid?: number | null,
    reservation?: { kind: string; mb: number },
  ): HostResourceSnapshot | null {
    if (this.deps.platform !== "darwin") return null;
    if (
      requiredPid !== undefined &&
      (!Number.isSafeInteger(requiredPid) ||
        requiredPid === null ||
        requiredPid < 1)
    )
      throw new ResourceAdmissionError(
        "adopted model process identity unavailable; heavy work paused",
      );
    if (this.deps.policy() === "critical-only") {
      const denied = this.deps.quarantine();
      if (denied)
        throw new ResourceAdmissionError(`heavy work refused: ${denied}`);
      if (requiredPid) this.deps.signal(requiredPid);
      const snapshot = this.deps.criticalSample();
      if (
        snapshot.memoryPressure === "critical" ||
        snapshot.kernelPressure === "critical"
      ) {
        const error = new ResourceAdmissionError(
          "critical host pressure; heavy work refused",
          true,
          resourceStopDiagnostics(
            snapshot,
            "critical-only",
            reservation ? "reserve" : "check",
            this.deps.pid,
            reservation?.kind,
            reservation?.mb,
          ),
        );
        try {
          this.deps.latch(error.message, error.diagnostics);
        } catch {
          error.message += "; safety stop persistence failed";
        }
        throw error;
      }
      const after = this.deps.quarantine();
      if (after)
        throw new ResourceAdmissionError(`heavy work refused: ${after}`);
      return snapshot;
    }
    return this.withLock(() => {
      const snapshot = this.deps.sample(requiredPid ? [requiredPid] : []);
      if (requiredPid && !snapshot.processes.some((p) => p.pid === requiredPid))
        throw new ResourceAdmissionError(
          "adopted model process missing; heavy work paused",
        );
      this.checked(snapshot, this.records(snapshot));
      return snapshot;
    });
  }

  reserve(mb: number, kind: string): ResourceReservation {
    if (!Number.isFinite(mb) || mb <= 0 || mb > DEFAULT_RESOURCE_BUDGET_MB)
      throw new ResourceAdmissionError("invalid resource reservation");
    if (this.deps.platform !== "darwin")
      return { attach: () => {}, release: () => {} };
    if (this.deps.policy() === "critical-only") {
      this.check(undefined, { kind, mb });
      return { attach: () => {}, release: () => {} };
    }
    let record = this.withLock(() => {
      const denied = this.deps.quarantine();
      if (denied)
        throw new ResourceAdmissionError(`heavy work refused: ${denied}`);
      const snapshot = this.deps.sample();
      const owner = snapshot.processes.find((p) => p.pid === this.deps.pid);
      if (!owner)
        throw new ResourceAdmissionError("resource owner identity unavailable");
      const records = this.records(snapshot);
      const reserved = records
        .filter((r) => r.pid === owner.pid)
        .reduce((sum, r) => sum + r.mb, 0);
      // Preserve the current working set as well as each new allocation. A
      // large parent must not make a pending child appear free.
      const charge =
        mb + Math.max(0, (owner.footprintMb ?? Number.NaN) - reserved);
      const next: ReservationRecord = {
        version: 1,
        pid: owner.pid,
        start: owner.start,
        nonce: randomUUID(),
        mb: charge,
        kind,
      };
      this.checked(snapshot, [...records, next], kind, mb);
      this.persist(next);
      return next;
    });
    let released = false;
    return {
      attach: (pid, processGroup = false) => {
        if (released)
          throw new ResourceAdmissionError("resource reservation released");
        if (!Number.isSafeInteger(pid) || pid < 1)
          throw new ResourceAdmissionError("resource child PID unavailable");
        // Publish uncertainty before probing/locking. This is our own nonce;
        // moving its existing pending charge cannot grant any new capacity.
        // A failed lock or killed parent must still account for the child.
        record = {
          ...record,
          pid,
          start: "unverified",
          mb,
          unverified: true,
          ...(processGroup ? { groupPid: pid } : {}),
        };
        this.persist(record);
        this.withLock(() => {
          const snapshot = this.deps.sample();
          const child = snapshot.processes.find((p) => p.pid === pid);
          if (
            !child ||
            child.parentPid !== this.deps.pid ||
            (processGroup && child.groupPid !== child.pid)
          ) {
            // The child was forked, even if the identity probe failed. Retain
            // a durable uncertain charge across parent failure until it is
            // confirmed dead; do not revert to a parent-only reservation.
            record = {
              ...record,
              pid,
              start: "unverified",
              mb,
              unverified: true,
              ...(processGroup ? { groupPid: pid } : {}),
            };
            this.persist(record);
            throw new ResourceAdmissionError(
              "resource child identity unavailable",
            );
          }
          // Transfer does not admit more work. Preserve the charge even if
          // pressure changed; the caller owns termination of its new child.
          record = {
            ...record,
            pid: child.pid,
            start: child.start,
            mb,
            unverified: false,
            ...(processGroup ? { groupPid: child.pid } : {}),
          };
          this.persist(record);
        });
      },
      release: () => {
        if (released) return;
        // Only the holder removes its nonce, after actual native/process close.
        // Concurrent admission can overcharge or refuse a disappearing file,
        // but removal never grants capacity before resources have been freed.
        try {
          fs.unlinkSync(path.join(this.deps.root, `${record.nonce}.json`));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        released = true;
      },
    };
  }
}

export const resourceBudget = new ResourceBudget();
