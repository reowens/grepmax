/**
 * A daemon (or per-project watcher) spawned from a sandboxed shell inherits the
 * sandbox for its whole life: it dies on its own lock mkdir under ~/.gmax and
 * leaves a confusing crash in daemon.log. Both implicit spawn paths probe
 * writability first and decline instead.
 *
 * The sandbox is reproduced with a chmod 0500 temp dir rather than
 * `sandbox-exec` so this runs on Linux CI too. See scripts/sandbox-smoke.sh for
 * the real seatbelt profiles.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const spawnDaemon = vi.fn(async (): Promise<number | null> => 4242);
vi.mock("../src/lib/utils/daemon-launcher", () => ({
  spawnDaemon: () => spawnDaemon(),
}));

const childSpawn = vi.fn((..._args: unknown[]) => ({ pid: 1, unref() {} }));
vi.mock("node:child_process", () => ({
  spawn: (...args: unknown[]) => childSpawn(...args),
}));

const getProject = vi.fn((_root: string) => ({
  root: "/work/api",
  name: "api",
}));
vi.mock("../src/lib/utils/project-registry", () => ({
  getProject: (root: string) => getProject(root),
}));

vi.mock("../src/lib/utils/watcher-store", () => ({
  getWatcherForProject: () => undefined,
  getWatcherCoveringPath: () => undefined,
  isProcessRunning: () => false,
}));

import { PATHS } from "../src/config";
import { ensureDaemonRunning } from "../src/lib/utils/daemon-client";
import { resetStoreWriteDeniedNotice } from "../src/lib/utils/store-access";
import { launchWatcher } from "../src/lib/utils/watcher-launcher";

const isRoot = process.getuid?.() === 0;

let home: string;
let originalPaths: typeof PATHS;

beforeEach(() => {
  originalPaths = { ...PATHS };
  home = fs.mkdtempSync(path.join(os.tmpdir(), "gmax-spawn-guard-"));
  PATHS.globalRoot = home;
  // Nothing listening, no kill switch file: the only thing that can stop a
  // spawn in this setup is the writability probe.
  PATHS.daemonSocket = path.join(home, "daemon.sock");
  PATHS.daemonPidFile = path.join(home, "daemon.pid");
  PATHS.daemonLockFile = path.join(home, "daemon.lock");
  PATHS.autostartDisabledFile = path.join(home, "autostart-disabled");
  delete process.env.GMAX_NO_AUTOSTART;
  resetStoreWriteDeniedNotice();
  spawnDaemon.mockClear();
  childSpawn.mockClear();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  Object.assign(PATHS, originalPaths);
  try {
    fs.chmodSync(home, 0o700);
    fs.rmSync(home, { recursive: true, force: true });
  } catch {}
  vi.restoreAllMocks();
});

describe.skipIf(isRoot)("spawn guard: ~/.gmax is not writable", () => {
  beforeEach(() => fs.chmodSync(home, 0o500));

  it("ensureDaemonRunning declines instead of spawning", async () => {
    await expect(ensureDaemonRunning()).resolves.toBe(false);
    expect(spawnDaemon).not.toHaveBeenCalled();
  });

  it("ensureDaemonRunning prints the filesystem hint once", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    await ensureDaemonRunning();
    await ensureDaemonRunning();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(String(spy.mock.calls[0][0])).toContain("allowWrite");
  });

  it("launchWatcher reports the sandboxed reason and spawns nothing", async () => {
    const result = await launchWatcher("/work/api");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("sandboxed");
    expect(result.message).toContain("allowWrite");
    expect(spawnDaemon).not.toHaveBeenCalled();
    expect(childSpawn).not.toHaveBeenCalled();
  });
});

describe("spawn guard: ~/.gmax is writable", () => {
  it("ensureDaemonRunning still attempts a spawn", async () => {
    // A null pid short-circuits the readiness poll; the point is only that the
    // probe let the spawn through.
    spawnDaemon.mockResolvedValueOnce(null);
    await expect(ensureDaemonRunning()).resolves.toBe(false);
    expect(spawnDaemon).toHaveBeenCalledOnce();
  });
});
