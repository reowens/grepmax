import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Who wants which project watched, and until when.
 *
 * The daemon used to subscribe to every registered project at startup and keep
 * them all for its whole life. On a host with 14 registered projects — a 293k-chunk
 * monorepo, a second checkout of another repo, projects nobody had opened in weeks —
 * every build, checkout, and agent edit anywhere became indexing work: ~300 cold
 * worker spawns a day, 129 FSEvents overflows and 32 full catchup scans in one day,
 * all to keep indexes fresh for sessions that did not exist.
 *
 * Now a project is watched only while something holds a lease on it:
 * - an MCP server (one per Claude session) renews `mcp:<pid>` for its project, and
 *   the lease dies with that process;
 * - the SessionStart / CwdChanged hooks take a session lease that the MCP server
 *   normally outlives;
 * - CLI requests (`gmax add`, `gmax index`, …) take a short TTL lease.
 *
 * A project that falls out of every lease is unwatched; its vectors stay. The
 * catchup scan that runs when it is next watched picks up whatever changed.
 *
 * Leases are persisted so a recycle or crash does not drop every session's watch
 * until its next renewal.
 */

export interface WatchLease {
  root: string;
  holder: string;
  /** Lease also ends when this process exits. */
  pid?: number;
  expiresAt: number;
}

export interface LeaseRequest {
  holder: string;
  pid?: number;
  ttlMs: number;
}

export const DEFAULT_LEASE_TTL_MS = 30 * 60 * 1000;
/** Upper bound on a requested TTL — a lease must not outlive its holder by days. */
export const MAX_LEASE_TTL_MS = 12 * 60 * 60 * 1000;

function defaultIsPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: the process exists but belongs to someone else.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

export class WatchLeases {
  private readonly leases = new Map<string, WatchLease>();
  private readonly now: () => number;
  private readonly isPidAlive: (pid: number) => boolean;

  constructor(
    private readonly file: string | null,
    opts: { now?: () => number; isPidAlive?: (pid: number) => boolean } = {},
  ) {
    this.now = opts.now ?? Date.now;
    this.isPidAlive = opts.isPidAlive ?? defaultIsPidAlive;
  }

  private static key(root: string, holder: string): string {
    return `${root}\0${holder}`;
  }

  /** Take or renew a lease. Returns true if the root was not wanted before. */
  acquire(root: string, req: LeaseRequest): boolean {
    const wasWanted = this.isWanted(root);
    const ttl = Math.min(Math.max(req.ttlMs, 1000), MAX_LEASE_TTL_MS);
    this.leases.set(WatchLeases.key(root, req.holder), {
      root,
      holder: req.holder,
      pid: req.pid,
      expiresAt: this.now() + ttl,
    });
    this.persist();
    return !wasWanted;
  }

  /** Drop one holder's lease, or every lease on the root when holder is omitted. */
  release(root: string, holder?: string): void {
    let changed = false;
    for (const [key, lease] of this.leases) {
      if (lease.root !== root) continue;
      if (holder !== undefined && lease.holder !== holder) continue;
      this.leases.delete(key);
      changed = true;
    }
    if (changed) this.persist();
  }

  private isLive(lease: WatchLease): boolean {
    if (lease.expiresAt <= this.now()) return false;
    if (lease.pid !== undefined && !this.isPidAlive(lease.pid)) return false;
    return true;
  }

  isWanted(root: string): boolean {
    for (const lease of this.leases.values()) {
      if (lease.root === root && this.isLive(lease)) return true;
    }
    return false;
  }

  /** Drop dead leases. Returns roots that were wanted before and are not now. */
  sweep(): string[] {
    // Every stored lease was live when last swept or acquired, so the stored
    // roots — not the currently-live ones — are what "wanted before" means.
    const before = new Set([...this.leases.values()].map((l) => l.root));
    let changed = false;
    for (const [key, lease] of this.leases) {
      if (!this.isLive(lease)) {
        this.leases.delete(key);
        changed = true;
      }
    }
    if (!changed) return [];
    this.persist();
    const after = this.wantedRoots();
    return [...before].filter((root) => !after.has(root));
  }

  wantedRoots(): Set<string> {
    const roots = new Set<string>();
    for (const lease of this.leases.values()) {
      if (this.isLive(lease)) roots.add(lease.root);
    }
    return roots;
  }

  /** Live leases, for `gmax status`. */
  list(): WatchLease[] {
    return [...this.leases.values()].filter((lease) => this.isLive(lease));
  }

  load(): void {
    if (!this.file) return;
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(this.file, "utf-8"));
    } catch {
      return;
    }
    if (!Array.isArray(raw)) return;
    for (const entry of raw) {
      if (
        !entry ||
        typeof entry.root !== "string" ||
        typeof entry.holder !== "string" ||
        typeof entry.expiresAt !== "number"
      ) {
        continue;
      }
      const lease: WatchLease = {
        root: entry.root,
        holder: entry.holder,
        pid: typeof entry.pid === "number" ? entry.pid : undefined,
        expiresAt: Math.min(entry.expiresAt, this.now() + MAX_LEASE_TTL_MS),
      };
      if (this.isLive(lease)) {
        this.leases.set(WatchLeases.key(lease.root, lease.holder), lease);
      }
    }
  }

  private persist(): void {
    if (!this.file) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify([...this.leases.values()]));
      fs.renameSync(tmp, this.file);
    } catch {
      // Persistence only shortens the gap after a restart; the next renewal
      // re-establishes the lease either way.
    }
  }
}
