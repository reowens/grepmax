import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import lockfile from "proper-lockfile";

export interface StoreLeaseOwner {
  pid: number;
  processStart: string;
  nonce: string;
  role: string;
  acquiredAt: number;
}

export type OwnerProbeResult = "same" | "dead" | "reused" | "unknown";

export interface StoreLeaseOptions {
  storeDir: string;
  timeoutMs?: number;
  pollMs?: number;
  signal?: AbortSignal;
  pid?: number;
  processStart?: string;
  nonce?: string;
  role?: string;
  ignoreNonces?: ReadonlySet<string>;
  probeOwner?: (owner: StoreLeaseOwner) => OwnerProbeResult;
}

export interface StoreLeasePaths {
  root: string;
  readersDir: string;
  intentDir: string;
  intentOwnerFile: string;
}

export function storeLeasePaths(storeDir: string): StoreLeasePaths {
  const root = `${path.resolve(storeDir)}.lease`;
  const intentDir = path.join(root, "exclusive-intent");
  return {
    root,
    readersDir: path.join(root, "readers"),
    intentDir,
    intentOwnerFile: path.join(intentDir, "owner.json"),
  };
}

export class StoreLeaseTimeoutError extends Error {
  constructor(
    message: string,
    readonly blockers: StoreLeaseOwner[],
  ) {
    super(message);
    this.name = "StoreLeaseTimeoutError";
  }
}

function abortError(): Error {
  const error = new Error("Aborted");
  error.name = "AbortError";
  return error;
}

let cachedCurrentProcessStart: string | null = null;

function currentProcessStart(pid: number): string {
  if (pid === process.pid && cachedCurrentProcessStart) {
    return cachedCurrentProcessStart;
  }
  try {
    const start = execFileSync("ps", ["-p", String(pid), "-o", "lstart="], {
      encoding: "utf8",
      timeout: 1000,
    }).trim();
    if (pid === process.pid) cachedCurrentProcessStart = start;
    return start;
  } catch {
    const fallback = `pid:${pid}:started:${Math.trunc(Date.now() - process.uptime() * 1000)}`;
    if (pid === process.pid) cachedCurrentProcessStart = fallback;
    return fallback;
  }
}

function defaultProbeOwner(owner: StoreLeaseOwner): OwnerProbeResult {
  try {
    process.kill(owner.pid, 0);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH"
      ? "dead"
      : "unknown";
  }
  if (owner.processStart.startsWith(`pid:${owner.pid}:started:`)) return "same";
  try {
    const start = execFileSync(
      "ps",
      ["-p", String(owner.pid), "-o", "lstart="],
      { encoding: "utf8", timeout: 1000 },
    ).trim();
    if (!start) return "unknown";
    return start === owner.processStart ? "same" : "reused";
  } catch {
    return "unknown";
  }
}

function readOwner(filePath: string): StoreLeaseOwner | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    const owner = parsed as StoreLeaseOwner;
    return typeof owner.pid === "number" &&
      typeof owner.processStart === "string" &&
      typeof owner.nonce === "string" &&
      typeof owner.role === "string" &&
      typeof owner.acquiredAt === "number"
      ? owner
      : null;
  } catch {
    return null;
  }
}

function writeOwnerAtomic(filePath: string, owner: StoreLeaseOwner): void {
  const temp = `${filePath}.${owner.nonce}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(owner)}\n`, { flag: "wx" });
  fs.renameSync(temp, filePath);
}

async function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw abortError();
  await new Promise<void>((resolve, reject) => {
    const finish = () => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(abortError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    timer.unref();
  });
}

export class StoreLease {
  private released = false;
  private claimedBy: object | null = null;

  private constructor(
    readonly mode: "shared" | "exclusive",
    readonly owner: StoreLeaseOwner,
    private readonly markerPath: string,
    private readonly paths: StoreLeasePaths,
    private readonly storeDir: string,
  ) {}

  static async acquireShared(options: StoreLeaseOptions): Promise<StoreLease> {
    const context = StoreLease.context(options);
    fs.mkdirSync(context.paths.readersDir, { recursive: true });
    const markerPath = path.join(
      context.paths.readersDir,
      `${context.owner.nonce}.json`,
    );

    while (Date.now() <= context.deadline) {
      if (options.signal?.aborted) throw abortError();
      StoreLease.withIntentLock(context, () =>
        StoreLease.removeStaleIntent(context),
      );
      if (!fs.existsSync(context.paths.intentDir)) {
        writeOwnerAtomic(markerPath, context.owner);
        if (!fs.existsSync(context.paths.intentDir)) {
          return new StoreLease(
            "shared",
            context.owner,
            markerPath,
            context.paths,
            options.storeDir,
          );
        }
        fs.rmSync(markerPath, { force: true });
      }
      await delay(context.pollMs, options.signal);
    }
    throw new StoreLeaseTimeoutError(
      "Timed out waiting for exclusive store intent to clear",
      StoreLease.intentBlockers(context.paths),
    );
  }

  static async acquireExclusive(
    options: StoreLeaseOptions,
  ): Promise<StoreLease> {
    const context = StoreLease.context(options);
    fs.mkdirSync(context.paths.readersDir, { recursive: true });
    let ownsIntent = false;
    try {
      while (Date.now() <= context.deadline) {
        if (options.signal?.aborted) throw abortError();
        StoreLease.withIntentLock(context, () => {
          StoreLease.removeStaleIntent(context);
          if (fs.existsSync(context.paths.intentDir)) return;
          const tempIntent = `${context.paths.intentDir}.${context.owner.nonce}.tmp`;
          try {
            fs.mkdirSync(tempIntent);
            writeOwnerAtomic(
              path.join(tempIntent, "owner.json"),
              context.owner,
            );
            fs.renameSync(tempIntent, context.paths.intentDir);
            ownsIntent = true;
          } finally {
            fs.rmSync(tempIntent, { recursive: true, force: true });
          }
        });
        if (ownsIntent) break;
        await delay(context.pollMs, options.signal);
      }
      if (!ownsIntent) {
        throw new StoreLeaseTimeoutError(
          "Timed out waiting to acquire exclusive store intent",
          StoreLease.intentBlockers(context.paths),
        );
      }

      while (Date.now() <= context.deadline) {
        if (options.signal?.aborted) throw abortError();
        const blockers = StoreLease.liveReaders(context);
        if (blockers.length === 0) {
          const current = readOwner(context.paths.intentOwnerFile);
          if (current?.nonce !== context.owner.nonce) {
            throw new Error("Exclusive store lease ownership was lost");
          }
          return new StoreLease(
            "exclusive",
            context.owner,
            context.paths.intentDir,
            context.paths,
            options.storeDir,
          );
        }
        await delay(context.pollMs, options.signal);
      }
      throw new StoreLeaseTimeoutError(
        "Timed out waiting for shared store owners to close",
        StoreLease.liveReaders(context),
      );
    } catch (error) {
      if (ownsIntent) {
        await StoreLease.releaseIntentWithRetry(
          context.paths,
          context.owner,
          1_000,
          context.pollMs,
        );
      }
      throw error;
    }
  }

  async release(
    options: { timeoutMs?: number; pollMs?: number } = {},
  ): Promise<void> {
    if (this.released) return;
    if (this.mode === "shared") {
      const current = readOwner(this.markerPath);
      if (current?.nonce === this.owner.nonce) {
        fs.rmSync(this.markerPath, { force: true });
      }
      this.released = true;
      this.claimedBy = null;
      return;
    }
    await StoreLease.releaseIntentWithRetry(
      this.paths,
      this.owner,
      options.timeoutMs,
      options.pollMs,
    );
    this.released = true;
    this.claimedBy = null;
  }

  claim(holder: object, storeDir: string): void {
    if (path.resolve(storeDir) !== path.resolve(this.storeDir)) {
      throw new Error("Store lease belongs to a different store");
    }
    if (this.released) throw new Error("Store lease has already been released");
    if (this.claimedBy && this.claimedBy !== holder) {
      throw new Error("Store lease is already attached to another owner");
    }
    const current =
      this.mode === "shared"
        ? readOwner(this.markerPath)
        : readOwner(this.paths.intentOwnerFile);
    if (current?.nonce !== this.owner.nonce) {
      throw new Error("Store lease ownership could not be verified");
    }
    this.claimedBy = holder;
  }

  relinquish(holder: object): void {
    if (this.claimedBy === holder) this.claimedBy = null;
  }

  /** Atomically replace this shared lease with an exclusive lease. */
  async upgrade(
    options: Omit<StoreLeaseOptions, "storeDir" | "ignoreNonces"> = {},
  ): Promise<StoreLease> {
    if (this.mode !== "shared") {
      throw new Error("Only a shared store lease can be upgraded");
    }
    if (this.released) throw new Error("Store lease has already been released");

    const exclusive = await StoreLease.acquireExclusive({
      ...options,
      storeDir: this.storeDir,
      pid: this.owner.pid,
      processStart: this.owner.processStart,
      ignoreNonces: new Set([this.owner.nonce]),
    });
    try {
      await this.release();
      return exclusive;
    } catch (error) {
      await exclusive.release();
      throw error;
    }
  }

  /** Replace this exclusive lease with a shared lease without an ownership gap. */
  async downgrade(
    options: Omit<StoreLeaseOptions, "storeDir" | "ignoreNonces"> = {},
  ): Promise<StoreLease> {
    if (this.mode !== "exclusive") {
      throw new Error("Only an exclusive store lease can be downgraded");
    }
    if (this.released) throw new Error("Store lease has already been released");

    const current = readOwner(this.paths.intentOwnerFile);
    if (current?.nonce !== this.owner.nonce) {
      throw new Error("Exclusive store lease ownership could not be verified");
    }

    const context = StoreLease.context({
      ...options,
      storeDir: this.storeDir,
      pid: this.owner.pid,
      processStart: this.owner.processStart,
    });
    fs.mkdirSync(context.paths.readersDir, { recursive: true });
    const markerPath = path.join(
      context.paths.readersDir,
      `${context.owner.nonce}.json`,
    );
    writeOwnerAtomic(markerPath, context.owner);
    try {
      const stillCurrent = readOwner(this.paths.intentOwnerFile);
      if (stillCurrent?.nonce !== this.owner.nonce) {
        throw new Error(
          "Exclusive store lease ownership changed during downgrade",
        );
      }
      while (
        !StoreLease.withIntentLock(context, () =>
          StoreLease.releaseIntent(this.paths, this.owner, true),
        )
      ) {
        if (Date.now() > context.deadline) {
          throw new Error(
            "Timed out waiting to release exclusive store intent during downgrade",
          );
        }
        await delay(context.pollMs, options.signal);
      }
      this.released = true;
      this.claimedBy = null;
      return new StoreLease(
        "shared",
        context.owner,
        markerPath,
        context.paths,
        this.storeDir,
      );
    } catch (error) {
      fs.rmSync(markerPath, { force: true });
      throw error;
    }
  }

  private static context(options: StoreLeaseOptions) {
    const pid = options.pid ?? process.pid;
    const nonce = options.nonce ?? randomUUID();
    if (!/^[A-Za-z0-9._-]+$/.test(nonce)) {
      throw new Error("Store lease nonce contains invalid characters");
    }
    const owner: StoreLeaseOwner = {
      pid,
      processStart: options.processStart ?? currentProcessStart(pid),
      nonce,
      role: options.role ?? process.title ?? "gmax",
      acquiredAt: Date.now(),
    };
    return {
      owner,
      paths: storeLeasePaths(options.storeDir),
      deadline: Date.now() + (options.timeoutMs ?? 10_000),
      pollMs: options.pollMs ?? 50,
      ignoreNonces: options.ignoreNonces ?? new Set<string>(),
      probeOwner: options.probeOwner ?? defaultProbeOwner,
    };
  }

  private static removeStaleIntent(
    context: ReturnType<typeof StoreLease.context>,
  ): void {
    if (!fs.existsSync(context.paths.intentDir)) return;
    const owner = readOwner(context.paths.intentOwnerFile);
    if (!owner) return;
    const status = context.probeOwner(owner);
    if (status === "dead" || status === "reused") {
      StoreLease.releaseIntent(context.paths, owner, true);
    }
  }

  private static withIntentLock(
    context: ReturnType<typeof StoreLease.context>,
    fn: () => void,
  ): boolean {
    return StoreLease.withIntentPathsLock(context.paths, fn);
  }

  private static withIntentPathsLock(
    paths: StoreLeasePaths,
    fn: () => void,
  ): boolean {
    fs.mkdirSync(paths.root, { recursive: true });
    let release: (() => void) | undefined;
    try {
      release = lockfile.lockSync(paths.root, {
        realpath: false,
        retries: 0,
        stale: 10_000,
      });
      fn();
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ELOCKED") throw error;
      return false;
    } finally {
      release?.();
    }
  }

  private static async releaseIntentWithRetry(
    paths: StoreLeasePaths,
    owner: StoreLeaseOwner,
    timeoutMs = 1_000,
    pollMs = 10,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!StoreLease.releaseIntent(paths, owner)) {
      if (Date.now() > deadline) {
        throw new Error("Timed out waiting to release exclusive store intent");
      }
      await delay(pollMs);
    }
  }

  private static releaseIntent(
    paths: StoreLeasePaths,
    owner: StoreLeaseOwner,
    lockHeld = false,
  ): boolean {
    const remove = () => {
      const current = readOwner(paths.intentOwnerFile);
      if (current?.nonce === owner.nonce) {
        fs.rmSync(paths.intentDir, { recursive: true, force: true });
      }
    };
    if (lockHeld) {
      remove();
      return true;
    }
    return StoreLease.withIntentPathsLock(paths, remove);
  }

  private static intentBlockers(paths: StoreLeasePaths): StoreLeaseOwner[] {
    const owner = readOwner(paths.intentOwnerFile);
    return owner ? [owner] : [];
  }

  private static liveReaders(
    context: ReturnType<typeof StoreLease.context>,
  ): StoreLeaseOwner[] {
    let names: string[];
    try {
      names = fs.readdirSync(context.paths.readersDir);
    } catch {
      return [];
    }
    const blockers: StoreLeaseOwner[] = [];
    for (const name of names) {
      const markerPath = path.join(context.paths.readersDir, name);
      const owner = readOwner(markerPath);
      if (!owner) {
        blockers.push({
          pid: -1,
          processStart: "unknown",
          nonce: name,
          role: "invalid-marker",
          acquiredAt: 0,
        });
        continue;
      }
      if (
        context.ignoreNonces.has(owner.nonce) &&
        owner.pid === context.owner.pid &&
        owner.processStart === context.owner.processStart
      ) {
        continue;
      }
      const status = context.probeOwner(owner);
      if (status === "dead" || status === "reused") {
        fs.rmSync(markerPath, { force: true });
      } else {
        blockers.push(owner);
      }
    }
    return blockers;
  }
}

export function hasStoreExclusiveIntent(storeDir: string): boolean {
  return fs.existsSync(storeLeasePaths(storeDir).intentDir);
}
