import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveEmbeddingGeneration } from "../src/lib/index/embedding-generation";
import type { ProjectEntry } from "../src/lib/utils/project-registry";

const mocks = vi.hoisted(() => ({
  project: undefined as ProjectEntry | undefined,
}));

vi.mock("../src/lib/utils/project-registry", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../src/lib/utils/project-registry")
  >()),
  getProject: vi.fn(() => mocks.project),
}));

import { Daemon } from "../src/lib/daemon/daemon";

function project(overrides: Partial<ProjectEntry> = {}): ProjectEntry {
  return {
    root: "/work/app",
    name: "app",
    modelTier: "small",
    vectorDim: 384,
    embedMode: "gpu",
    lastIndexed: "2026-07-13T00:00:00.000Z",
    status: "indexed",
    ...overrides,
  };
}

describe("Daemon watcher embedding admission", () => {
  let daemon: any;
  let watchProject: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mocks.project = undefined;
    daemon = new Daemon();
    daemon.activeGeneration = resolveEmbeddingGeneration({
      modelTier: "small",
    });
    watchProject = vi
      .spyOn(daemon.watcherManager, "watchProject")
      .mockResolvedValue(undefined);
  });

  it("admits a compatible legacy project", async () => {
    mocks.project = project();

    await daemon.watchProjectWithinOperation("/work/app");

    expect(watchProject).toHaveBeenCalledWith("/work/app");
  });

  it("rejects a stale generation before watcher catchup", async () => {
    mocks.project = project({ modelTier: "standard", vectorDim: 768 });

    expect(() => daemon.watchProjectWithinOperation("/work/app")).toThrow(
      /gmax repair --rebuild/i,
    );
    expect(watchProject).not.toHaveBeenCalled();
  });
});
