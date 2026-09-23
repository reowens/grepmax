import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sendDaemonCommand = vi.fn();
const listWatchers = vi.fn();
const getWatcherForProject = vi.fn();

vi.mock("../src/lib/utils/daemon-client", () => ({
  sendDaemonCommand: (...args: unknown[]) => sendDaemonCommand(...args),
}));

vi.mock("../src/lib/utils/watcher-store", () => ({
  listWatchers: (...args: unknown[]) => listWatchers(...args),
  getWatcherForProject: (...args: unknown[]) => getWatcherForProject(...args),
}));

vi.mock("../src/lib/utils/project-registry", () => ({
  listProjects: () => [
    {
      root: "/work/api",
      name: "api",
      vectorDim: 384,
      modelTier: "small",
      embedMode: "cpu",
      lastIndexed: "2026-01-01T00:00:00.000Z",
      chunkCount: 11,
      status: "indexed",
    },
  ],
}));

vi.mock("../src/lib/index/index-config", () => ({
  readGlobalConfig: () => ({
    modelTier: "small",
    vectorDim: 384,
    embedMode: "cpu",
  }),
}));

vi.mock("../src/lib/utils/lock", () => ({ isLocked: () => false }));
vi.mock("../src/lib/utils/project-root", () => ({
  findProjectRoot: () => "/work/api",
}));
vi.mock("../src/lib/utils/exit", () => ({
  gracefulExit: vi.fn(async () => {}),
}));

// The in-process path must never be reached in the daemon tests below; if it
// is, this mock makes the failure loud instead of silently querying a store.
const vectorDbCtor = vi.fn();
vi.mock("../src/lib/store/vector-db", () => ({
  VectorDB: class {
    constructor(...args: unknown[]) {
      vectorDbCtor(...args);
    }
    async ensureTable() {
      return {
        query: () => ({
          select: () => ({
            where: () => ({ toArray: async () => [{ id: 1 }, { id: 2 }] }),
          }),
        }),
      };
    }
    async close() {}
  },
}));

import { buildStatusJson, status } from "../src/commands/status";

const originalExitCode = process.exitCode;
let out: string[];
let err: string[];

beforeEach(() => {
  out = [];
  err = [];
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) =>
    out.push(a.join(" ")),
  );
  vi.spyOn(console, "error").mockImplementation((...a: unknown[]) =>
    err.push(a.join(" ")),
  );
  vi.spyOn(console, "warn").mockImplementation(() => {});
  sendDaemonCommand.mockReset();
  listWatchers.mockReset();
  getWatcherForProject.mockReset();
  vectorDbCtor.mockReset();
});

afterEach(() => {
  process.exitCode = originalExitCode;
  vi.restoreAllMocks();
});

async function runStatus(args: string[] = []): Promise<void> {
  await status.parseAsync(["node", "status", ...args]);
}

describe("gmax status", () => {
  it("uses the daemon's project list and per-project stats, never LMDB or the store", async () => {
    sendDaemonCommand.mockImplementation(async (cmd: { cmd: string }) => {
      if (cmd.cmd === "status") {
        return {
          ok: true,
          projects: [{ root: "/work/api", status: "watching" }],
        };
      }
      if (cmd.cmd === "project-stats") return { ok: true, chunks: 4321 };
      return { ok: false, error: "unexpected" };
    });

    await runStatus(["--agent"]);

    expect(listWatchers).not.toHaveBeenCalled();
    expect(getWatcherForProject).not.toHaveBeenCalled();
    expect(vectorDbCtor).not.toHaveBeenCalled();
    expect(out.join("\n")).toContain("api\t4k\t");
    expect(out.join("\n")).toContain("watching");
  });

  it("falls back to the registry count when project-stats fails", async () => {
    sendDaemonCommand.mockImplementation(async (cmd: { cmd: string }) => {
      if (cmd.cmd === "status") return { ok: true, projects: [] };
      return { ok: false, error: "project not registered" };
    });

    await runStatus(["--agent"]);
    expect(out.join("\n")).toContain("api\t11\t");
    expect(out.join("\n")).toContain("idle");
  });

  it("opens the watcher store and VectorDB only when no daemon is listening", async () => {
    sendDaemonCommand.mockResolvedValue({ ok: false, error: "ENOENT" });
    getWatcherForProject.mockReturnValue({ status: "syncing" });

    await runStatus(["--agent"]);

    expect(listWatchers).toHaveBeenCalledOnce();
    expect(vectorDbCtor).toHaveBeenCalledOnce();
    expect(out.join("\n")).toContain("api\t2\t");
    expect(out.join("\n")).toContain("indexing");
  });

  it("refuses with the socket hint and exit 2 when the sandbox blocks the socket", async () => {
    sendDaemonCommand.mockResolvedValue({ ok: false, error: "EPERM" });

    await runStatus(["--agent"]);

    expect(listWatchers).not.toHaveBeenCalled();
    expect(vectorDbCtor).not.toHaveBeenCalled();
    expect(err).toHaveLength(1);
    expect(err[0]).toContain("allowUnixSockets");
    expect(err[0]).not.toContain("\n    at ");
    expect(process.exitCode).toBe(2);
    expect(out).toEqual([]);
  });

  it("refuses with the filesystem hint when the in-process lease is denied", async () => {
    sendDaemonCommand.mockResolvedValue({ ok: false, error: "ECONNREFUSED" });
    listWatchers.mockImplementation(() => {
      throw new Error("Operation not permitted: Attempting to setup locks");
    });

    await runStatus(["--agent"]);

    expect(err).toHaveLength(1);
    expect(err[0]).toContain("allowWrite");
    expect(process.exitCode).toBe(2);
  });

  it("--json reports daemon, settings, workers and per-project state", async () => {
    sendDaemonCommand.mockImplementation(async (cmd: { cmd: string }) => {
      if (cmd.cmd === "status") {
        return {
          ok: true,
          pid: 4242,
          uptime: 60,
          workers: 2,
          workerThreads: { value: 3, source: "config" },
          projects: [{ root: "/work/api", status: "watching" }],
        };
      }
      if (cmd.cmd === "project-stats") return { ok: true, chunks: 4321 };
      return { ok: false, error: "unexpected" };
    });

    await runStatus(["--json"]);

    expect(out).toHaveLength(1);
    const json = JSON.parse(out[0]);
    expect(json.daemon).toMatchObject({
      running: true,
      pid: 4242,
      workerThreads: 3,
    });
    expect(json.daemon.since).toBeLessThanOrEqual(Date.now() - 59_000);
    expect(json.settings).toMatchObject({
      embedMode: "cpu",
      modelTier: "small",
      vectorDim: 384,
      queryLog: false,
    });
    expect(json.settings.workerThreads.value).toBeGreaterThan(0);
    expect(["env", "config", "default"]).toContain(
      json.settings.workerThreads.source,
    );
    expect(json.workersRunning).toBe(2);
    expect(json.indexing).toBe(false);
    expect(json.projects).toEqual([
      {
        name: "api",
        root: "/work/api",
        chunks: 4321,
        indexedAt: Date.parse("2026-01-01T00:00:00.000Z"),
        state: "watching",
        embedding: expect.any(String),
      },
    ]);
    expect(typeof json.at).toBe("number");
  });
});

describe("buildStatusJson", () => {
  const base = {
    projects: [],
    globalConfig: {
      modelTier: "small",
      vectorDim: 384,
      embedMode: "gpu" as const,
    },
    indexing: false,
    workerThreads: { value: 2, source: "default" as const },
    now: 1_000_000,
  };

  it("reports a down daemon with nulls", () => {
    const json = buildStatusJson({
      ...base,
      view: { watchers: new Map(), chunkCounts: new Map() },
    });
    expect(json.daemon).toEqual({
      running: false,
      pid: null,
      since: null,
      workerThreads: null,
    });
    expect(json.workersRunning).toBeNull();
  });

  it("counts worker processes when an older daemon does not report them", () => {
    const countWorkers = vi.fn(() => 1);
    const json = buildStatusJson({
      ...base,
      countWorkers,
      view: {
        watchers: new Map(),
        chunkCounts: new Map(),
        daemon: { pid: 7, uptimeSec: 10, workers: null, workerThreads: null },
      },
    });
    expect(countWorkers).toHaveBeenCalledWith(7);
    expect(json.workersRunning).toBe(1);
    expect(json.daemon.since).toBe(990_000);
  });
});
