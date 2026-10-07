import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  pruneVersions,
  runCleanupProcess,
} from "../src/lib/store/lance-cleanup";
import {
  pruneStatePath,
  readPruneState,
  writePruneState,
} from "../src/lib/store/prune-state";
import { StoreLease, storeLeasePaths } from "../src/lib/store/store-lease";

vi.mock("../src/lib/store/recovery-admission", () => ({
  admitPrune: () => ({
    start: vi.fn(),
    approve: vi.fn(),
    check: vi.fn(),
    close: vi.fn(),
  }),
}));

vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
  spawn: vi.fn(),
}));
vi.mock("node:fs", async (original) => {
  const actual = await original<typeof import("node:fs")>();
  return {
    ...actual,
    mkdirSync: vi.fn(actual.mkdirSync),
    chmodSync: vi.fn(actual.chmodSync),
    statfsSync: vi.fn(actual.statfsSync),
    lstatSync: vi.fn(actual.lstatSync),
    existsSync: vi.fn(actual.existsSync),
  };
});

function fakeChild() {
  return Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    stdin: new PassThrough(),
    pid: 123,
    kill: vi.fn(() => true),
  });
}

describe("prune helper subprocess bounds", () => {
  let child: ReturnType<typeof fakeChild>;
  beforeEach(() => {
    vi.useFakeTimers();
    child = fakeChild();
    vi.mocked(spawn)
      .mockReset()
      .mockReturnValue(child as any);
  });
  afterEach(() => vi.useRealTimers());

  it("does not inherit service credentials and sets single-thread limits", async () => {
    process.env.GMAX_FIXTURE_SECRET = "must not inherit";
    try {
      const pending = runCleanupProcess("fixture", ["-I", "fixture.py"]);
      const options = vi.mocked(spawn).mock.calls[0][2] as any;
      expect(options.env.GMAX_FIXTURE_SECRET).toBeUndefined();
      expect(options.env.RAYON_NUM_THREADS).toBe("1");
      expect(options.env.UV_PYTHON_DOWNLOADS).toBe("never");
      expect(options.stdio).toEqual(["ignore", "pipe", "pipe"]);
      child.stdout.write("fixture");
      child.emit("close", 0, null);
      await expect(pending).resolves.toBe("fixture");
    } finally {
      delete process.env.GMAX_FIXTURE_SECRET;
    }
  });

  it("cancels before launch", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      runCleanupProcess("fixture", [], { signal: controller.signal }),
    ).rejects.toThrow("before launch");
    expect(spawn).not.toHaveBeenCalled();
  });

  it("holds deletion behind launch and final admission, closing resources only after child close", async () => {
    const tokens: string[] = [];
    child.stdin.on("data", (chunk) => tokens.push(chunk.toString()));
    const admission = {
      nonce: "fixture",
      start: vi.fn(),
      approve: vi.fn(),
      check: vi.fn(),
      close: vi.fn(),
    };
    const pending = runCleanupProcess("fixture", [], { admission });
    expect(admission.start).toHaveBeenCalledWith(123);
    expect(tokens).toEqual([]);
    child.stdout.write('{"admission":"launch"}\n');
    expect(tokens).toEqual(["fixture\n"]);
    expect(admission.approve).not.toHaveBeenCalled();
    child.stdout.write('{"admission":"ready"}\n');
    expect(admission.approve).toHaveBeenCalledOnce();
    expect(tokens).toEqual(["fixture\n", "fixture\n"]);
    expect(admission.close).not.toHaveBeenCalled();
    child.stdout.write('{"verified":true}');
    child.emit("close", 0, null);
    await expect(pending).resolves.toBe('{"verified":true}');
    expect(admission.close).toHaveBeenCalledOnce();
  });

  it("refuses changed deletion admission without sending a deletion token", async () => {
    const tokens: string[] = [];
    child.stdin.on("data", (chunk) => tokens.push(chunk.toString()));
    const admission = {
      nonce: "fixture",
      start: vi.fn(),
      approve: () => {
        throw Error("unknown resources");
      },
      check: vi.fn(),
      close: vi.fn(),
    };
    const pending = runCleanupProcess("fixture", [], { admission });
    const check = expect(pending).rejects.toThrow("deletion admission refused");
    child.stdout.write('{"admission":"launch"}\n{"admission":"ready"}\n');
    expect(tokens).toEqual(["fixture\n"]);
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(admission.close).not.toHaveBeenCalled();
    child.emit("close", null, "SIGTERM");
    await check;
    expect(admission.close).toHaveBeenCalledOnce();
  });

  it("cancels an admitted helper when heartbeat resources become unknown", async () => {
    const admission = {
      nonce: "fixture",
      start: vi.fn(),
      approve: vi.fn(),
      check: () => {
        throw Error("unknown resources");
      },
      close: vi.fn(),
    };
    const pending = runCleanupProcess("fixture", [], { admission });
    const check = expect(pending).rejects.toThrow(
      "host/resource admission changed",
    );
    child.stdout.write('{"admission":"launch"}\n{"admission":"ready"}\n');
    await vi.advanceTimersByTimeAsync(5000);
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    child.emit("close", null, "SIGTERM");
    await check;
  });

  it("waits for child close after cancellation and escalates termination", async () => {
    const controller = new AbortController();
    const pending = runCleanupProcess("fixture", [], {
      signal: controller.signal,
    });
    let settled = false;
    void pending.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    controller.abort();
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    await vi.advanceTimersByTimeAsync(1000);
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    child.emit("close", null, "SIGKILL");
    await expect(pending).rejects.toThrow("completion is uncertain");
  });

  it("enforces a bounded deadline without settling before close", async () => {
    const pending = runCleanupProcess("fixture", [], { timeoutMs: 10 });
    const check = expect(pending).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(10);
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    child.emit("close", null, "SIGTERM");
    await check;
  });

  it("caps combined output and does not expose child stderr", async () => {
    const pending = runCleanupProcess("fixture", []);
    const check = expect(pending).rejects.toThrow("output exceeded limit");
    child.stderr.write("PRIVATE_TOKEN");
    child.stdout.write(Buffer.alloc(128 * 1024));
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    child.emit("close", null, "SIGTERM");
    await check;
  });

  it("reports concrete startup errors without executable paths", async () => {
    const pending = runCleanupProcess("/private/fixture", []);
    const check = expect(pending).rejects.toThrow("ENOENT");
    child.emit(
      "error",
      Object.assign(new Error("secret path"), { code: "ENOENT" }),
    );
    child.emit("close", -2, null);
    await check;
  });

  it("classifies a stale lock without exposing private stderr", async () => {
    const pending = runCleanupProcess("fixture", []);
    const check = expect(pending).rejects.toThrow(
      "locked project/runtime mismatch",
    );
    child.stderr.write(
      "The lockfile at /private/fixture needs to be updated; PRIVATE_TOKEN",
    );
    child.emit("close", 2, null);
    await check;
    await expect(pending).rejects.not.toThrow("PRIVATE_TOKEN");
  });
});

describe("exclusive prune admission and verification", () => {
  let root: string;
  let store: string;
  let table: string;
  let lease: StoreLease | undefined;
  let child: ReturnType<typeof fakeChild>;
  const runtime = { python: "fixture", script: "fixture.py" };
  const output = {
    engine: "12.0.0",
    version: 5,
    fragments: 2,
    bytesRemoved: 100,
    versionsRemoved: 1,
    rewritten: false,
    fileBytesBefore: 200,
    fileBytesAfter: 100,
    allocatedBytesBefore: 8192,
    allocatedBytesAfter: 4096,
    freeBytesBefore: 1000,
    freeBytesAfter: 5096,
  };
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "gmax-prune-guard-"));
    store = fs.realpathSync(root);
    table = path.join(store, "chunks.lance");
    vi.spyOn(StoreLease.prototype, "pinExclusiveHelper").mockReturnValue(
      () => {},
    );
    fs.mkdirSync(table);
    child = fakeChild();
    vi.mocked(spawn)
      .mockReset()
      .mockReturnValue(child as any);
  });
  afterEach(async () => {
    await lease?.release();
    lease = undefined;
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(`${store}.lease`, { recursive: true, force: true });
  });

  it("rejects a missing lease before any subprocess", async () => {
    await expect(
      pruneVersions(runtime, table, 5, new Date(), {} as any),
    ).rejects.toThrow("StoreLease token");
    expect(spawn).not.toHaveBeenCalled();
  });

  it("rejects a shared lease", async () => {
    lease = await StoreLease.acquireShared({ storeDir: store });
    await expect(
      pruneVersions(runtime, table, 5, new Date(), { lease }),
    ).rejects.toThrow("exclusive store lease");
    expect(spawn).not.toHaveBeenCalled();
  });

  it("holds exclusive ownership until child exit and result verification", async () => {
    lease = await StoreLease.acquireExclusive({ storeDir: store });
    const pending = pruneVersions(runtime, table, 5, new Date(), { lease });
    await expect(lease.release()).rejects.toThrow("operation must finish");
    await expect(lease.downgrade()).rejects.toThrow("operation must finish");
    expect(vi.mocked(spawn).mock.calls[0][1]).toContain("--lease-nonce");
    expect(
      JSON.parse(fs.readFileSync(pruneStatePath(store), "utf8")).outcome,
    ).toBe("running");
    expect(readPruneState(store)?.outcome).toBe("uncertain");
    child.stdout.write(' {"admission":"launch"}\n{"admission":"ready"}\n');
    child.stdout.write(JSON.stringify(output));
    child.emit("close", 0, null);
    await expect(pending).resolves.toEqual(output);
    expect(readPruneState(store)).toMatchObject({
      outcome: "completed",
      result: output,
    });
    expect(fs.statSync(pruneStatePath(store)).mode & 0o777).toBe(0o600);
  });

  it("persists uncertainty on cancellation and links an explicit verified retry", async () => {
    lease = await StoreLease.acquireExclusive({ storeDir: store });
    const controller = new AbortController();
    const pending = pruneVersions(runtime, table, 5, new Date(), {
      lease,
      signal: controller.signal,
    });
    const check = expect(pending).rejects.toThrow("uncertain");
    controller.abort();
    child.emit("close", null, "SIGTERM");
    await check;
    const interrupted = readPruneState(store)!;
    expect(interrupted.outcome).toBe("uncertain");
    child = fakeChild();
    vi.mocked(spawn).mockReturnValueOnce(child as any);
    const retry = pruneVersions(runtime, table, 5, new Date(), {
      lease,
      acknowledgeUncertain: interrupted.attemptId,
    });
    child.stdout.write(' {"admission":"launch"}\n{"admission":"ready"}\n');
    child.stdout.write(JSON.stringify(output));
    child.emit("close", 0, null);
    await retry;
    expect(readPruneState(store)).toMatchObject({
      outcome: "completed",
      previousUncertainAttemptId: interrupted.attemptId,
    });
  });

  it("treats a prior parent's running receipt as uncertain across restart", async () => {
    writePruneState({
      schemaVersion: 1,
      storeIdentity: store,
      attemptId: "old-parent",
      version: 5,
      cutoffMs: Date.now() - 1000,
      startedAt: Date.now() - 1000,
      outcome: "running",
    });
    lease = await StoreLease.acquireExclusive({ storeDir: store });
    const pending = pruneVersions(runtime, table, 5, new Date(), {
      lease,
      acknowledgeUncertain: "old-parent",
    });
    child.stdout.write(' {"admission":"launch"}\n{"admission":"ready"}\n');
    child.stdout.write(JSON.stringify(output));
    child.emit("close", 0, null);
    await pending;
    expect(readPruneState(store)?.previousUncertainAttemptId).toBe(
      "old-parent",
    );
  });

  it("refuses corrupt or symlinked state before launching deletion", async () => {
    lease = await StoreLease.acquireExclusive({ storeDir: store });
    fs.writeFileSync(pruneStatePath(store), "invalid json");
    await expect(
      pruneVersions(runtime, table, 5, new Date(), { lease }),
    ).rejects.toThrow();
    expect(spawn).not.toHaveBeenCalled();
    fs.unlinkSync(pruneStatePath(store));
    const untouched = path.join(store, "outside.json");
    fs.writeFileSync(untouched, "untouched");
    fs.symlinkSync(untouched, pruneStatePath(store));
    await expect(
      pruneVersions(runtime, table, 5, new Date(), { lease }),
    ).rejects.toThrow("unverified");
    expect(spawn).not.toHaveBeenCalled();
    expect(fs.readFileSync(untouched, "utf8")).toBe("untouched");
  });

  it("rejects unknown shared markers even under an exclusive token", async () => {
    lease = await StoreLease.acquireExclusive({ storeDir: store });
    fs.writeFileSync(
      path.join(storeLeasePaths(store).readersDir, "unknown.json"),
      "invalid",
    );
    await expect(
      pruneVersions(runtime, table, 5, new Date(), { lease }),
    ).rejects.toThrow("shared store owners");
    expect(spawn).not.toHaveBeenCalled();
  });

  it("reports ownership lost after helper completion without claiming success", async () => {
    lease = await StoreLease.acquireExclusive({ storeDir: store });
    const pending = pruneVersions(runtime, table, 5, new Date(), { lease });
    const check = expect(pending).rejects.toThrow(
      "ownership could not be verified",
    );
    const owner = storeLeasePaths(store).intentOwnerFile;
    const original = fs.readFileSync(owner, "utf8");
    fs.writeFileSync(owner, JSON.stringify({ ...lease.owner, nonce: "lost" }));
    child.stdout.write(' {"admission":"launch"}\n{"admission":"ready"}\n');
    child.stdout.write(JSON.stringify(output));
    child.emit("close", 0, null);
    await check;
    expect(readPruneState(store)?.outcome).toBe("uncertain");
    fs.writeFileSync(owner, original);
  });

  it("rejects future cutoffs and invalid results", async () => {
    lease = await StoreLease.acquireExclusive({ storeDir: store });
    await expect(
      pruneVersions(runtime, table, 5, new Date(Date.now() + 100_000), {
        lease,
      }),
    ).rejects.toThrow("future cutoff");
    expect(spawn).not.toHaveBeenCalled();
    const pending = pruneVersions(runtime, table, 5, new Date(), { lease });
    const check = expect(pending).rejects.toThrow("completion is uncertain");
    child.stdout.write(' {"admission":"launch"}\n{"admission":"ready"}\n');
    child.stdout.write(JSON.stringify({ ...output, allocatedBytesAfter: -1 }));
    child.emit("close", 0, null);
    await check;
    expect(readPruneState(store)?.outcome).toBe("uncertain");
  });
});

describe("locked runtime setup without installing anything", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.mocked(spawn).mockReset();
    vi.mocked(fs.mkdirSync).mockImplementation(() => undefined);
    vi.mocked(fs.chmodSync).mockImplementation(() => undefined);
    vi.mocked(fs.statfsSync).mockReturnValue({
      bavail: 1024 ** 2,
      bsize: 4096,
    } as any);
    vi.mocked(fs.lstatSync).mockReturnValue({
      isSymbolicLink: () => false,
      isDirectory: () => true,
    } as any);
    vi.mocked(fs.existsSync).mockReturnValue(false);
  });
  afterEach(() => vi.restoreAllMocks());

  it("uses a locked wheel-only existing interpreter and private runtime", async () => {
    const version = fakeChild();
    const sync = fakeChild();
    vi.mocked(spawn)
      .mockReturnValueOnce(version as any)
      .mockReturnValueOnce(sync as any);
    const { prepareCleanupRuntime } = await import(
      "../src/lib/store/lance-cleanup"
    );
    const pending = prepareCleanupRuntime();
    version.stdout.write("uv 0.12.23\n");
    version.emit("close", 0, null);
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(2));
    const args = vi.mocked(spawn).mock.calls[1][1];
    expect(args).toContain("--locked");
    expect(args).toContain("--no-build");
    expect(args).toContain("--no-python-downloads");
    expect(
      (vi.mocked(spawn).mock.calls[1][2] as any).env.UV_PROJECT_ENVIRONMENT,
    ).toContain("lance-cleanup-");
    sync.emit("close", 0, null);
    await expect(pending).resolves.toMatchObject({
      script: expect.stringContaining("prune.py"),
    });
    expect(fs.chmodSync).toHaveBeenCalledWith(expect.any(String), 0o700);
  });

  it("refuses unknown disk before sync", async () => {
    vi.mocked(fs.statfsSync).mockReturnValue({
      bavail: Number.NaN,
      bsize: 4096,
    } as any);
    const version = fakeChild();
    vi.mocked(spawn).mockReturnValueOnce(version as any);
    const { prepareCleanupRuntime } = await import(
      "../src/lib/store/lance-cleanup"
    );
    const pending = prepareCleanupRuntime();
    const check = expect(pending).rejects.toThrow("setup refused");
    version.stdout.write("uv 0.12.23\n");
    version.emit("close", 0, null);
    await check;
    expect(spawn).toHaveBeenCalledOnce();
  });

  it("verifies an existing locked runtime without requiring download headroom", async () => {
    vi.mocked(fs.existsSync).mockImplementation((file) =>
      String(file).includes("lance-cleanup-"),
    );
    vi.mocked(fs.statfsSync).mockClear();
    const version = fakeChild();
    const verify = fakeChild();
    vi.mocked(spawn)
      .mockReturnValueOnce(version as any)
      .mockReturnValueOnce(verify as any);
    const { prepareCleanupRuntime } = await import(
      "../src/lib/store/lance-cleanup"
    );
    const pending = prepareCleanupRuntime();
    version.stdout.write("uv 0.12.23\n");
    version.emit("close", 0, null);
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(2));
    const args = vi.mocked(spawn).mock.calls[1][1]!;
    expect(args).toContain("--check");
    expect(args).toContain("--locked");
    expect(args).toContain("--offline");
    verify.emit("close", 0, null);
    await pending;
    expect(fs.statfsSync).not.toHaveBeenCalled();
  });

  it("preserves a specific setup exit failure and permits an explicit retry", async () => {
    const version = fakeChild();
    const sync = fakeChild();
    vi.mocked(spawn)
      .mockReturnValueOnce(version as any)
      .mockReturnValueOnce(sync as any);
    const { prepareCleanupRuntime } = await import(
      "../src/lib/store/lance-cleanup"
    );
    const pending = prepareCleanupRuntime();
    const check = expect(pending).rejects.toThrow("exited (2)");
    version.stdout.write("uv 0.12.23\n");
    version.emit("close", 0, null);
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(2));
    sync.stderr.write("fixture cache missing or stale lock");
    sync.emit("close", 2, null);
    await check;
    const retry = fakeChild();
    vi.mocked(spawn).mockReturnValueOnce(retry as any);
    const next = prepareCleanupRuntime();
    const nextCheck = expect(next).rejects.toThrow("uv >=0.12.18");
    retry.stdout.write("uv 0.11.0\n");
    retry.emit("close", 0, null);
    await nextCheck;
  });
});
