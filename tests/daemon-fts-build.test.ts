import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  projects: [] as Array<Record<string, unknown>>,
}));

vi.mock("../src/lib/utils/project-registry", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../src/lib/utils/project-registry")
  >()),
  listProjects: () => mocks.projects,
}));

import { Daemon } from "../src/lib/daemon/daemon";

describe("daemon one-time FTS build", () => {
  afterEach(() => {
    mocks.projects = [];
    vi.restoreAllMocks();
  });

  function fixture() {
    const daemon = new Daemon() as any;
    daemon.ready = true;
    daemon.vectorDb = {
      buildMissingFTSIndex: vi.fn(async () => ({
        status: "built",
        elapsedMs: 12,
      })),
    };
    vi.spyOn(daemon, "assertHeavyOperationAdmission").mockImplementation(
      () => {},
    );
    return daemon;
  }

  it("builds through a tracked shared operation once indexing is done", async () => {
    mocks.projects = [{ root: "/a", status: "indexed" }];
    const daemon = fixture();
    const shared = vi.spyOn(daemon, "runSharedOperation");
    await expect(daemon.buildMissingFTSIndex()).resolves.toEqual({
      ok: true,
      status: "built",
      elapsedMs: 12,
    });
    expect(shared).toHaveBeenCalledWith(
      "fts-build",
      undefined,
      expect.any(Function),
    );
    expect(daemon.assertHeavyOperationAdmission).toHaveBeenCalledWith(
      "fts-build",
    );
  });

  it("drops cached searchers so the next search adopts the new index", async () => {
    mocks.projects = [{ root: "/a", status: "indexed" }];
    const daemon = fixture();
    daemon.searchers.set("/a", { stale: true });
    await daemon.buildMissingFTSIndex();
    expect(daemon.searchers.size).toBe(0);
  });

  it("keeps cached searchers when the build fails", async () => {
    mocks.projects = [{ root: "/a", status: "indexed" }];
    const daemon = fixture();
    daemon.vectorDb.buildMissingFTSIndex.mockRejectedValueOnce(
      new Error("disk pressure"),
    );
    daemon.searchers.set("/a", { stale: true });
    await expect(daemon.buildMissingFTSIndex()).rejects.toThrow(
      "disk pressure",
    );
    expect(daemon.searchers.size).toBe(1);
  });

  it("refuses while any project is still pending", async () => {
    mocks.projects = [
      { root: "/a", status: "indexed" },
      { root: "/b", status: "pending" },
    ];
    const daemon = fixture();
    await expect(daemon.buildMissingFTSIndex()).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining("1 pending"),
    });
    expect(daemon.vectorDb.buildMissingFTSIndex).not.toHaveBeenCalled();
  });

  it("refuses while a bulk index operation is running", async () => {
    mocks.projects = [{ root: "/a", status: "indexed" }];
    const daemon = fixture();
    let release!: () => void;
    const bulk = daemon.operations.runShared(
      "index-project",
      undefined,
      () => new Promise<void>((resolve) => (release = resolve)),
    );
    await expect(daemon.buildMissingFTSIndex()).resolves.toMatchObject({
      ok: false,
    });
    expect(daemon.vectorDb.buildMissingFTSIndex).not.toHaveBeenCalled();
    release();
    await bulk;
  });

  it("refuses a paused service", async () => {
    const daemon = fixture();
    daemon.pausedReason = "critical pressure";
    await expect(daemon.buildMissingFTSIndex()).resolves.toMatchObject({
      ok: false,
    });
    expect(daemon.vectorDb.buildMissingFTSIndex).not.toHaveBeenCalled();
  });
});
