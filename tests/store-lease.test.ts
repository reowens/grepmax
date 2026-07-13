import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import lockfile from "proper-lockfile";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  StoreLease,
  type StoreLeaseOwner,
  StoreLeaseTimeoutError,
  storeLeasePaths,
} from "../src/lib/store/store-lease";

describe("StoreLease", () => {
  let root: string;
  let storeDir: string;
  const leases: StoreLease[] = [];

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "gmax-store-lease-"));
    storeDir = path.join(root, "lancedb");
  });

  afterEach(async () => {
    await Promise.allSettled(leases.splice(0).map((lease) => lease.release()));
    fs.rmSync(root, { recursive: true, force: true });
  });

  const acquireShared = async (nonce: string) => {
    const lease = await StoreLease.acquireShared({
      storeDir,
      nonce,
      pid: process.pid,
      processStart: "test-process",
      role: "test",
      timeoutMs: 100,
      pollMs: 5,
    });
    leases.push(lease);
    return lease;
  };

  it("allows multiple shared owners", async () => {
    await acquireShared("reader-a");
    await acquireShared("reader-b");

    expect(fs.readdirSync(storeLeasePaths(storeDir).readersDir)).toHaveLength(
      2,
    );
  });

  it("exclusive intent blocks new shared owners and reports blockers", async () => {
    const reader = await acquireShared("reader-a");
    const exclusivePromise = StoreLease.acquireExclusive({
      storeDir,
      nonce: "writer",
      pid: process.pid,
      processStart: "test-process",
      role: "writer",
      timeoutMs: 40,
      pollMs: 5,
      probeOwner: () => "same",
    });
    await expect(exclusivePromise).rejects.toMatchObject({
      name: "StoreLeaseTimeoutError",
      blockers: [expect.objectContaining({ nonce: "reader-a" })],
    });

    const paths = storeLeasePaths(storeDir);
    expect(fs.existsSync(paths.intentDir)).toBe(false);
    await reader.release();
  });

  it("exclusive acquisition drains readers and then blocks new readers", async () => {
    const reader = await acquireShared("reader-a");
    const pending = StoreLease.acquireExclusive({
      storeDir,
      nonce: "writer",
      pid: process.pid,
      processStart: "test-process",
      role: "writer",
      timeoutMs: 200,
      pollMs: 5,
      probeOwner: () => "same",
    });
    await new Promise((resolve) => setTimeout(resolve, 15));
    await reader.release();
    const exclusive = await pending;
    leases.push(exclusive);

    await expect(
      StoreLease.acquireShared({
        storeDir,
        nonce: "late-reader",
        pid: process.pid,
        processStart: "test-process",
        role: "test",
        timeoutMs: 25,
        pollMs: 5,
        probeOwner: () => "same",
      }),
    ).rejects.toBeInstanceOf(StoreLeaseTimeoutError);
  });

  it("removes a stale shared marker only after owner verification", async () => {
    const paths = storeLeasePaths(storeDir);
    fs.mkdirSync(paths.readersDir, { recursive: true });
    const stale: StoreLeaseOwner = {
      pid: 999_999,
      processStart: "old",
      nonce: "stale",
      role: "dead-test",
      acquiredAt: 1,
    };
    fs.writeFileSync(
      path.join(paths.readersDir, "stale.json"),
      JSON.stringify(stale),
    );

    const exclusive = await StoreLease.acquireExclusive({
      storeDir,
      nonce: "writer",
      pid: process.pid,
      processStart: "test-process",
      role: "writer",
      timeoutMs: 100,
      pollMs: 5,
      probeOwner: () => "dead",
    });
    leases.push(exclusive);
    expect(fs.existsSync(path.join(paths.readersDir, "stale.json"))).toBe(
      false,
    );
  });

  it("supports upgrading while ignoring an explicitly-owned shared marker", async () => {
    await acquireShared("daemon-reader");
    const exclusive = await StoreLease.acquireExclusive({
      storeDir,
      nonce: "writer",
      pid: process.pid,
      processStart: "test-process",
      role: "writer",
      ignoreNonces: new Set(["daemon-reader"]),
      timeoutMs: 100,
      pollMs: 5,
      probeOwner: () => "same",
    });
    leases.push(exclusive);
    expect(exclusive.mode).toBe("exclusive");
  });

  it("does not ignore a matching nonce owned by another process identity", async () => {
    await acquireShared("reader");
    await expect(
      StoreLease.acquireExclusive({
        storeDir,
        nonce: "writer",
        pid: process.pid,
        processStart: "different-process",
        role: "writer",
        ignoreNonces: new Set(["reader"]),
        timeoutMs: 25,
        pollMs: 5,
        probeOwner: () => "same",
      }),
    ).rejects.toMatchObject({
      blockers: [expect.objectContaining({ nonce: "reader" })],
    });
  });

  it("upgrades and downgrades without exposing an unowned interval", async () => {
    const shared = await acquireShared("reader");
    const exclusive = await shared.upgrade({
      nonce: "writer",
      timeoutMs: 100,
      pollMs: 5,
      probeOwner: () => "same",
    });
    leases.push(exclusive);

    const paths = storeLeasePaths(storeDir);
    expect(fs.existsSync(paths.intentDir)).toBe(true);
    expect(fs.existsSync(path.join(paths.readersDir, "reader.json"))).toBe(
      false,
    );

    const downgraded = await exclusive.downgrade({ nonce: "reader-again" });
    leases.push(downgraded);
    expect(fs.existsSync(paths.intentDir)).toBe(false);
    expect(
      fs.existsSync(path.join(paths.readersDir, "reader-again.json")),
    ).toBe(true);
  });

  it("serializes competing exclusive-intent creation", async () => {
    const contenders = ["writer-a", "writer-b"].map((nonce) =>
      StoreLease.acquireExclusive({
        storeDir,
        nonce,
        pid: process.pid,
        processStart: "test-process",
        role: nonce,
        timeoutMs: 40,
        pollMs: 5,
        probeOwner: () => "same",
      }),
    );
    const results = await Promise.allSettled(contenders);
    const fulfilled = results.filter(
      (result): result is PromiseFulfilledResult<StoreLease> =>
        result.status === "fulfilled",
    );
    const rejected = results.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toBeInstanceOf(StoreLeaseTimeoutError);
    leases.push(fulfilled[0].value);
    const owner = JSON.parse(
      fs.readFileSync(storeLeasePaths(storeDir).intentOwnerFile, "utf8"),
    );
    expect(owner.nonce).toBe(fulfilled[0].value.owner.nonce);
  });

  it("retries an exclusive release collision without losing ownership", async () => {
    const exclusive = await StoreLease.acquireExclusive({
      storeDir,
      nonce: "release-collision",
      processStart: "test-process",
    });
    leases.push(exclusive);
    const paths = storeLeasePaths(storeDir);
    const unlock = lockfile.lockSync(paths.root, {
      realpath: false,
      retries: 0,
    });

    const releasing = exclusive.release({ timeoutMs: 200, pollMs: 5 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fs.existsSync(paths.intentDir)).toBe(true);
    unlock();
    await releasing;
    expect(fs.existsSync(paths.intentDir)).toBe(false);
  });

  it("propagates a downgrade lock collision and retains the exclusive lease", async () => {
    const exclusive = await StoreLease.acquireExclusive({
      storeDir,
      nonce: "downgrade-collision",
      processStart: "test-process",
    });
    leases.push(exclusive);
    const paths = storeLeasePaths(storeDir);
    const unlock = lockfile.lockSync(paths.root, {
      realpath: false,
      retries: 0,
    });

    await expect(
      exclusive.downgrade({
        nonce: "collision-reader",
        timeoutMs: 20,
        pollMs: 5,
      }),
    ).rejects.toThrow(/release exclusive store intent/i);
    expect(fs.existsSync(paths.intentDir)).toBe(true);
    expect(
      fs.existsSync(path.join(paths.readersDir, "collision-reader.json")),
    ).toBe(false);
    unlock();

    exclusive.claim({}, storeDir);
    await exclusive.release();
  });
});
