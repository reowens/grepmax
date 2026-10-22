import * as fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  daemons: [910001] as number[],
  watchers: [] as Array<{ pid: number; projectRoot: string }>,
  kills: vi.fn(async () => true),
  unregister: vi.fn(),
  lock: vi.fn(async () => {
    throw new Error("fixture-lock-checkpoint");
  }),
  discovery: vi.fn(),
  files: new Map<string, string>(),
  markerError: null as string | null,
  draining: false,
  drainWait: vi.fn(async () => false),
  unregisterDaemon: vi.fn(),
  writeDrain: vi.fn(),
  clearDrain: vi.fn(),
  socketArrival: null as (() => void) | null,
  socketClosed: vi.fn(),
  resourceOpens: vi.fn(),
  allowResource: false,
  markIndexOwner: vi.fn(),
}));
vi.mock("node:fs", async (original) => ({
  ...(await original<typeof import("node:fs")>()),
  lstatSync: vi.fn((file: string) => {
    if (h.markerError)
      throw Object.assign(new Error("denied"), { code: h.markerError });
    if (!h.files.has(file))
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    return { isFile: () => true, isSymbolicLink: () => false };
  }),
  readFileSync: vi.fn((file: string) => h.files.get(file) ?? ""),
  unlinkSync: vi.fn((file: string) => {
    h.files.delete(file);
  }),
  mkdirSync: vi.fn(),
  chmodSync: vi.fn(),
  writeFileSync: vi.fn(),
}));
vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
  execSync: (cmd: string) => {
    h.discovery(cmd);
    if (cmd === 'pgrep -x "gmax-daemon"') return h.daemons.join("\n");
    if (cmd === 'pgrep -x "gmax-worker"') return "910002";
    throw new Error(`Host command forbidden: ${cmd}`);
  },
  spawn: () => {
    throw new Error("spawn forbidden");
  },
  fork: () => {
    throw new Error("fork forbidden");
  },
}));
vi.mock("node:net", () => ({
  createServer: vi.fn(() => {
    if (!h.socketArrival) throw new Error("fixture-socket-failure");
    return {
      listening: true,
      on() {},
      listen(_file: string, callback: () => void) {
        h.socketArrival!();
        callback();
      },
      close(callback?: () => void) {
        h.socketClosed();
        callback?.();
      },
    };
  }),
}));
vi.mock("../src/lib/store/vector-db", () => ({
  VectorDB: class {
    constructor() {
      h.resourceOpens();
      if (!h.allowResource) throw new Error("fixture-resource-open-checkpoint");
    }
    markIndexOwner = h.markIndexOwner;
    abortLeaseWaits() {}
    async close() {}
  },
}));
vi.mock("proper-lockfile", () => ({ default: { lock: h.lock } }));
vi.mock("../src/lib/utils/process", () => ({ killProcess: h.kills }));
vi.mock("../src/lib/utils/autostart", () => ({
  daemonStartDeniedReason: () => null,
}));
vi.mock("../src/lib/utils/daemon-client", () => ({
  isDaemonDraining: () => h.draining,
  isDaemonHeartbeatFresh: () => false,
  isDaemonRunning: async () => false,
  waitForDaemonDrain: h.drainWait,
  writeDrainingMarker: (...args: unknown[]) => {
    h.writeDrain(...args);
  },
  clearDrainingMarker: () => {
    h.clearDrain();
  },
}));
vi.mock("../src/lib/utils/watcher-store", async (original) => ({
  ...(await original<typeof import("../src/lib/utils/watcher-store")>()),
  listWatchers: () => h.watchers,
  unregisterWatcher: h.unregister,
  unregisterDaemon: h.unregisterDaemon,
}));

import { PATHS } from "../src/config";
import { Daemon } from "../src/lib/daemon/daemon";

describe("startup never terminates processes discovered outside its ownership", () => {
  const title = process.title;
  beforeEach(() => {
    vi.clearAllMocks();
    h.daemons = [910001];
    h.watchers = [];
    h.files.clear();
    h.markerError = null;
    h.draining = false;
    h.socketArrival = null;
    h.allowResource = false;
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(process, "kill").mockImplementation((() => {
      throw new Error("Host signal forbidden");
    }) as never);
    vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("Unexpected exit");
    }) as never);
  });
  afterEach(() => {
    process.title = title;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });
  it.each([true, false])(
    "ignores foreign daemon=%s and foreign worker",
    async (daemonExists) => {
      h.daemons = daemonExists ? [910001] : [];
      const daemon = new Daemon();
      vi.spyOn(daemon as any, "hostPressureDeniedReason").mockReturnValue(null);
      await expect(daemon.start()).rejects.toThrow("fixture-lock-checkpoint");
      expect(h.kills).not.toHaveBeenCalled();
      expect(h.discovery).not.toHaveBeenCalled();
      expect(h.lock).toHaveBeenCalledOnce();
      await daemon.shutdown();
      expect(h.writeDrain).not.toHaveBeenCalled();
      expect(h.clearDrain).not.toHaveBeenCalled();
      expect(h.unregisterDaemon).not.toHaveBeenCalled();
    },
  );
  it("refuses registry-only watcher takeover before lock, socket or shared resources", async () => {
    h.watchers = [{ pid: 910002, projectRoot: "/fixture/repo" }];
    const daemon = new Daemon();
    vi.spyOn(daemon as any, "hostPressureDeniedReason").mockReturnValue(null);
    await expect(daemon.start()).rejects.toThrow(/Standalone watchers.*910002/);
    expect(h.kills).not.toHaveBeenCalled();
    expect(h.unregister).not.toHaveBeenCalled();
    expect(h.lock).not.toHaveBeenCalled();
    await daemon.shutdown();
    expect(h.writeDrain).not.toHaveBeenCalled();
    expect(h.clearDrain).not.toHaveBeenCalled();
    expect(h.unregisterDaemon).not.toHaveBeenCalled();
  });
  it("permits definitely dead watcher entries without deleting evidence", async () => {
    h.watchers = [{ pid: 910002, projectRoot: "/fixture/repo" }];
    vi.mocked(process.kill).mockImplementation((_pid, signal) => {
      if (signal !== 0) throw new Error("Host signal forbidden");
      throw Object.assign(new Error("gone"), { code: "ESRCH" });
    });
    const daemon = new Daemon();
    vi.spyOn(daemon as any, "hostPressureDeniedReason").mockReturnValue(null);
    await expect(daemon.start()).rejects.toThrow("fixture-lock-checkpoint");
    expect(h.lock).toHaveBeenCalledOnce();
    expect(h.unregister).not.toHaveBeenCalled();
  });
  it("read-only startup leaves standalone watchers alone", async () => {
    h.watchers = [{ pid: 910002, projectRoot: "/fixture/repo" }];
    const daemon = new Daemon();
    vi.spyOn(daemon as any, "hostPressureDeniedReason").mockReturnValue(null);
    await expect(daemon.start({ readOnly: true })).rejects.toThrow(
      "fixture-lock-checkpoint",
    );
    expect(process.kill).not.toHaveBeenCalled();
    expect(h.kills).not.toHaveBeenCalled();
    expect(h.unregister).not.toHaveBeenCalled();
  });
  it.each(["healthy", "draining", "malformed", "permission"] as const)(
    "preserves %s predecessor evidence through startup refusal and CLI cleanup",
    async (kind) => {
      const marker =
        kind === "draining" ? PATHS.daemonDrainingFile : PATHS.daemonPidFile;
      h.files.set(
        marker,
        kind === "malformed"
          ? "invalid-pid"
          : kind === "draining"
            ? JSON.stringify({ pid: 910001, ts: 1 })
            : "910001",
      );
      h.files.set(PATHS.daemonSocket, "predecessor-socket");
      h.markerError = kind === "permission" ? "EACCES" : null;
      h.draining = kind === "draining";
      vi.mocked(process.kill).mockImplementation((_pid, signal) => {
        if (signal !== 0) throw new Error("Host signal forbidden");
        return true;
      });
      const before = [...h.files];
      const daemon = new Daemon();
      vi.spyOn(daemon as any, "hostPressureDeniedReason").mockReturnValue(null);
      await expect(daemon.start()).rejects.toThrow(/startup refused/);
      // Mirror watch.ts's catch: perform real cleanup after startup rejects.
      await daemon.shutdown();
      expect([...h.files]).toEqual(before);
      expect(fs.unlinkSync).not.toHaveBeenCalled();
      expect(h.writeDrain).not.toHaveBeenCalled();
      expect(h.clearDrain).not.toHaveBeenCalled();
      expect(h.unregisterDaemon).not.toHaveBeenCalled();
      expect(h.lock).not.toHaveBeenCalled();
      expect(h.kills).not.toHaveBeenCalled();
      expect(h.discovery).not.toHaveBeenCalled();
      if (kind === "draining") expect(h.drainWait).toHaveBeenCalledWith(910001);
      const successor = new Daemon();
      vi.spyOn(successor as any, "hostPressureDeniedReason").mockReturnValue(
        null,
      );
      await expect(successor.start()).rejects.toThrow(/startup refused/);
      await successor.shutdown();
      expect([...h.files]).toEqual(before);
    },
  );
  it("cleans resources and control state after acquiring the startup lock", async () => {
    const release = vi.fn(async () => {});
    h.lock.mockResolvedValueOnce(release as never);
    const daemon: any = new Daemon();
    vi.spyOn(daemon, "hostPressureDeniedReason").mockReturnValue(null);
    await expect(daemon.start()).rejects.toThrow("fixture-socket-failure");
    const close = vi.fn(async () => {});
    daemon.metaCache = { close };
    await daemon.shutdown();
    expect(release).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
    expect(h.writeDrain).toHaveBeenCalledWith(process.pid);
    expect(h.clearDrain).toHaveBeenCalledOnce();
    expect(h.unregisterDaemon).toHaveBeenCalledOnce();
  });

  it("revokes control cleanup when the startup lock is compromised", async () => {
    vi.useFakeTimers();
    let compromised!: () => void;
    const release = vi.fn(async () => {});
    h.lock.mockImplementationOnce(((
      _file: string,
      options: { onCompromised: () => void },
    ) => {
      compromised = options.onCompromised;
      return Promise.resolve(release);
    }) as never);
    const daemon: any = new Daemon();
    vi.spyOn(daemon, "hostPressureDeniedReason").mockReturnValue(null);
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(process.exit).mockImplementation((() => undefined) as never);
    await expect(daemon.start()).rejects.toThrow("fixture-socket-failure");
    h.files.set(PATHS.daemonSocket, "replacement-socket");
    h.files.set(PATHS.daemonPidFile, "910004");
    const before = [...h.files];
    const unlinks = vi.mocked(fs.unlinkSync).mock.calls.length;
    compromised();
    await daemon.shutdown();
    expect([...h.files]).toEqual(before);
    expect(fs.unlinkSync).toHaveBeenCalledTimes(unlinks);
    expect(h.writeDrain).not.toHaveBeenCalled();
    expect(h.clearDrain).not.toHaveBeenCalled();
    expect(h.unregisterDaemon).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledOnce();
  });
  it.each(["draining", "unknown", "malformed"] as const)(
    "rechecks %s predecessor evidence published during lock acquisition",
    async (kind) => {
      const release = vi.fn(async () => {});
      let before!: Array<[string, string]>;
      h.lock.mockImplementationOnce((async () => {
        h.files.set(
          PATHS.daemonDrainingFile,
          kind === "malformed"
            ? "bad-json"
            : JSON.stringify({ pid: 910001, ts: 1 }),
        );
        before = [...h.files];
        return release;
      }) as never);
      h.draining = true;
      vi.mocked(process.kill).mockImplementation((_pid, signal) => {
        if (signal !== 0) throw new Error("Host signal forbidden");
        if (kind === "unknown")
          throw Object.assign(new Error("denied"), { code: "EPERM" });
        return true;
      });
      const daemon: any = new Daemon();
      vi.spyOn(daemon, "hostPressureDeniedReason").mockReturnValue(null);
      await expect(daemon.start()).rejects.toThrow(/startup refused/);
      await daemon.shutdown();
      expect(release).toHaveBeenCalledOnce();
      expect([...h.files]).toEqual(before);
      expect(fs.unlinkSync).not.toHaveBeenCalled();
      expect(h.writeDrain).not.toHaveBeenCalled();
      expect(h.clearDrain).not.toHaveBeenCalled();
      expect(h.unregisterDaemon).not.toHaveBeenCalled();
      expect(h.kills).not.toHaveBeenCalled();
      expect(h.discovery).not.toHaveBeenCalled();
      const successor: any = new Daemon();
      vi.spyOn(successor, "hostPressureDeniedReason").mockReturnValue(null);
      await expect(successor.start()).rejects.toThrow(/startup refused/);
      await successor.shutdown();
      expect([...h.files]).toEqual(before);
      expect(h.lock).toHaveBeenCalledOnce();
    },
  );
  it.each([
    ["lock", "live"],
    ["lock", "unknown"],
    ["lock", "malformed"],
    ["socket", "live"],
    ["socket", "unknown"],
    ["socket", "malformed"],
  ] as const)(
    "refuses %s-time %s watcher before shared resources",
    async (boundary, kind) => {
      const watcher = {
        pid: kind === "malformed" ? NaN : 910002,
        projectRoot: "/fixture/repo",
      };
      const arrive = () => {
        h.watchers = [watcher];
      };
      const release = vi.fn(async () => {});
      h.lock.mockImplementationOnce((async () => {
        if (boundary === "lock") arrive();
        return release;
      }) as never);
      h.socketArrival = boundary === "socket" ? arrive : () => {};
      vi.mocked(process.kill).mockImplementation((_pid, signal) => {
        if (signal !== 0) throw new Error("Host signal forbidden");
        if (kind === "unknown")
          throw Object.assign(new Error("denied"), { code: "EPERM" });
        return true;
      });
      const daemon: any = new Daemon();
      vi.spyOn(daemon, "hostPressureDeniedReason").mockReturnValue(null);
      await expect(daemon.start()).rejects.toThrow(
        /Standalone watchers.*startup refused/,
      );
      await daemon.shutdown();
      expect(h.resourceOpens).not.toHaveBeenCalled();
      expect(h.watchers).toEqual([watcher]);
      expect(h.unregister).not.toHaveBeenCalled();
      expect(h.kills).not.toHaveBeenCalled();
      expect(h.discovery).not.toHaveBeenCalled();
      expect(release).toHaveBeenCalledOnce();
      if (boundary === "socket") expect(h.socketClosed).toHaveBeenCalledOnce();
      const successor: any = new Daemon();
      vi.spyOn(successor, "hostPressureDeniedReason").mockReturnValue(null);
      await expect(successor.start()).rejects.toThrow(
        /Standalone watchers.*startup refused/,
      );
      await successor.shutdown();
      expect(h.watchers).toEqual([watcher]);
      expect(h.lock).toHaveBeenCalledOnce();
    },
  );
  it("rechecks watcher evidence after awaited maintenance recovery before writer admission", async () => {
    const release = vi.fn(async () => {});
    h.lock.mockResolvedValueOnce(release as never);
    h.socketArrival = () => {};
    h.allowResource = true;
    const watcher = { pid: 910002, projectRoot: "/fixture/repo" };
    const daemon: any = new Daemon();
    vi.spyOn(daemon, "hostPressureDeniedReason").mockReturnValue(null);
    vi.spyOn(
      daemon,
      "recoverBoundedMaintenanceBeforeWriters",
    ).mockImplementation(async () => {
      h.watchers = [watcher];
    });
    vi.mocked(process.kill).mockImplementation((_pid, signal) => {
      if (signal !== 0) throw new Error("Host signal forbidden");
      return true;
    });
    await expect(daemon.start()).rejects.toThrow(
      /Standalone watchers.*startup refused/,
    );
    await daemon.shutdown();
    expect(h.resourceOpens).toHaveBeenCalledOnce();
    expect(h.markIndexOwner).not.toHaveBeenCalled();
    expect(h.watchers).toEqual([watcher]);
    expect(h.unregister).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledOnce();
  });
  it.each(["read-only", "dead"] as const)(
    "preserves %s policy at the final watcher check",
    async (kind) => {
      const release = vi.fn(async () => {});
      h.lock.mockResolvedValueOnce(release as never);
      h.socketArrival = () => {
        h.watchers = [{ pid: 910002, projectRoot: "/fixture/repo" }];
      };
      vi.mocked(process.kill).mockImplementation((_pid, signal) => {
        if (signal !== 0) throw new Error("Host signal forbidden");
        throw Object.assign(new Error("gone"), { code: "ESRCH" });
      });
      const daemon: any = new Daemon();
      vi.spyOn(daemon, "hostPressureDeniedReason").mockReturnValue(null);
      await expect(
        daemon.start({ readOnly: kind === "read-only" }),
      ).rejects.toThrow("fixture-resource-open-checkpoint");
      await daemon.shutdown();
      expect(h.resourceOpens).toHaveBeenCalledOnce();
      expect(h.watchers).toHaveLength(1);
      expect(h.unregister).not.toHaveBeenCalled();
      if (kind === "read-only") expect(process.kill).not.toHaveBeenCalled();
    },
  );
});
