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
}));
vi.mock("node:fs", async (original) => ({
  ...(await original<typeof import("node:fs")>()),
  lstatSync: vi.fn(() => {
    throw Object.assign(new Error("missing"), { code: "ENOENT" });
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
vi.mock("proper-lockfile", () => ({ default: { lock: h.lock } }));
vi.mock("../src/lib/utils/process", () => ({ killProcess: h.kills }));
vi.mock("../src/lib/utils/autostart", () => ({
  daemonStartDeniedReason: () => null,
}));
vi.mock("../src/lib/utils/daemon-client", () => ({
  isDaemonDraining: () => false,
  isDaemonHeartbeatFresh: () => false,
  isDaemonRunning: async () => false,
  waitForDaemonDrain: async () => false,
}));
vi.mock("../src/lib/utils/watcher-store", async (original) => ({
  ...(await original<typeof import("../src/lib/utils/watcher-store")>()),
  listWatchers: () => h.watchers,
  unregisterWatcher: h.unregister,
}));

import { Daemon } from "../src/lib/daemon/daemon";

describe("startup never terminates processes discovered outside its ownership", () => {
  const title = process.title;
  beforeEach(() => {
    vi.clearAllMocks();
    h.daemons = [910001];
    h.watchers = [];
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
});
