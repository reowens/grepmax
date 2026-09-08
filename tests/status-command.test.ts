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

import { status } from "../src/commands/status";

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
});
