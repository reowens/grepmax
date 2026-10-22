import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  projects: new Map<string, Record<string, unknown>>(),
  initialSync: vi.fn(),
  registerProject: vi.fn((project: Record<string, unknown>) => {
    mocks.projects.set(String(project.root), { ...project });
  }),
}));

vi.mock("../src/lib/index/syncer", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/index/syncer")>()),
  initialSync: mocks.initialSync,
}));

vi.mock("../src/lib/utils/project-registry", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../src/lib/utils/project-registry")
  >()),
  getProject: (root: string) => mocks.projects.get(root),
  registerProject: mocks.registerProject,
}));

import { Daemon } from "../src/lib/daemon/daemon";

describe("daemon background index status", () => {
  const root = "/existing/pending-project";

  afterEach(() => {
    mocks.projects.clear();
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  function fixture(status: "pending" | "error") {
    mocks.projects.set(root, { root, name: "pending-project", status });
    const daemon = new Daemon() as any;
    daemon.metaCache = {};
    daemon.vectorDb = {
      pauseMaintenanceLoop: vi.fn(),
      resumeMaintenanceLoop: vi.fn(),
      countRowsForPath: vi.fn(async () => 0),
    };
    const retry = vi
      .spyOn(daemon, "schedulePendingIndexRetry")
      .mockImplementation(() => {});
    const rewatch = vi
      .spyOn(daemon, "watchProjectWithinOperation")
      .mockImplementation(async () => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    return { daemon, retry, rewatch };
  }

  it.each(["pending", "error"] as const)(
    "leaves a %s project's status alone when shutdown stops the sync",
    async (status) => {
      const { daemon, retry, rewatch } = fixture(status);
      mocks.initialSync.mockImplementationOnce(async () => {
        // Shutdown aborts every in-flight background operation.
        daemon.shuttingDown = true;
        for (const ac of daemon.shutdownAbortControllers) ac.abort();
        throw Object.assign(new Error("Aborted"), { name: "AbortError" });
      });

      await daemon.indexPendingProject(root);

      expect(mocks.initialSync).toHaveBeenCalledOnce();
      expect(mocks.registerProject).not.toHaveBeenCalled();
      expect(mocks.projects.get(root)?.status).toBe(status);
      expect(retry).not.toHaveBeenCalled();
      expect(rewatch).not.toHaveBeenCalled();
      expect(daemon.vectorDb.resumeMaintenanceLoop).toHaveBeenCalledOnce();
    },
  );

  it("still marks a genuine failure as error and schedules a retry", async () => {
    const { daemon, retry, rewatch } = fixture("pending");
    mocks.initialSync.mockRejectedValueOnce(new Error("embed backend broke"));

    await daemon.indexPendingProject(root);

    expect(mocks.projects.get(root)?.status).toBe("error");
    expect(retry).toHaveBeenCalledWith(root);
    expect(rewatch).toHaveBeenCalledWith(root);
  });
});
