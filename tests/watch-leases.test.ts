import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MAX_LEASE_TTL_MS, WatchLeases } from "../src/lib/daemon/watch-leases";

describe("WatchLeases", () => {
  let now: number;
  let alive: Set<number>;
  const make = (file: string | null = null) =>
    new WatchLeases(file, {
      now: () => now,
      isPidAlive: (pid) => alive.has(pid),
    });

  beforeEach(() => {
    now = 1_000_000;
    alive = new Set([100, 200]);
  });

  it("reports a root as newly wanted only on its first lease", () => {
    const leases = make();
    expect(
      leases.acquire("/a", { holder: "mcp:100", pid: 100, ttlMs: 60_000 }),
    ).toBe(true);
    expect(
      leases.acquire("/a", { holder: "mcp:200", pid: 200, ttlMs: 60_000 }),
    ).toBe(false);
    expect(
      leases.acquire("/a", { holder: "mcp:100", pid: 100, ttlMs: 60_000 }),
    ).toBe(false);
    expect(leases.wantedRoots()).toEqual(new Set(["/a"]));
  });

  it("keeps a root while any holder lives and drops it when the last goes", () => {
    const leases = make();
    leases.acquire("/a", { holder: "mcp:100", pid: 100, ttlMs: 60_000 });
    leases.acquire("/a", { holder: "mcp:200", pid: 200, ttlMs: 60_000 });

    alive.delete(100);
    expect(leases.sweep()).toEqual([]);
    expect(leases.isWanted("/a")).toBe(true);

    alive.delete(200);
    expect(leases.isWanted("/a")).toBe(false);
    expect(leases.sweep()).toEqual(["/a"]);
    expect(leases.sweep()).toEqual([]);
  });

  it("expires TTL leases and renewal extends them", () => {
    const leases = make();
    leases.acquire("/a", { holder: "cli", ttlMs: 60_000 });
    now += 50_000;
    leases.acquire("/a", { holder: "cli", ttlMs: 60_000 });
    now += 50_000;
    expect(leases.isWanted("/a")).toBe(true);
    now += 20_000;
    expect(leases.sweep()).toEqual(["/a"]);
  });

  it("caps requested TTLs", () => {
    const leases = make();
    leases.acquire("/a", { holder: "cli", ttlMs: MAX_LEASE_TTL_MS * 10 });
    now += MAX_LEASE_TTL_MS + 1;
    expect(leases.isWanted("/a")).toBe(false);
  });

  it("releases one holder, or every holder when none is named", () => {
    const leases = make();
    leases.acquire("/a", { holder: "session:x", ttlMs: 60_000 });
    leases.acquire("/a", { holder: "mcp:100", pid: 100, ttlMs: 60_000 });
    leases.acquire("/b", { holder: "session:x", ttlMs: 60_000 });

    leases.release("/a", "session:x");
    expect(leases.isWanted("/a")).toBe(true);
    expect(leases.isWanted("/b")).toBe(true);

    leases.release("/a");
    expect(leases.isWanted("/a")).toBe(false);
    expect(leases.isWanted("/b")).toBe(true);
  });

  describe("persistence", () => {
    let dir: string;
    beforeEach(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), "gmax-leases-"));
    });
    afterEach(() => {
      fs.rmSync(dir, { recursive: true, force: true });
    });

    it("restores live leases and skips dead or expired ones", () => {
      const file = path.join(dir, "watch-leases.json");
      const first = make(file);
      first.acquire("/live", { holder: "mcp:100", pid: 100, ttlMs: 60_000 });
      first.acquire("/dead", { holder: "mcp:300", pid: 300, ttlMs: 60_000 });
      first.acquire("/short", { holder: "cli", ttlMs: 1_000 });

      now += 5_000;
      const second = make(file);
      second.load();
      expect(second.wantedRoots()).toEqual(new Set(["/live"]));
    });

    it("ignores a corrupt file", () => {
      const file = path.join(dir, "watch-leases.json");
      fs.writeFileSync(file, "{not json");
      const leases = make(file);
      leases.load();
      expect(leases.wantedRoots().size).toBe(0);
    });
  });
});
