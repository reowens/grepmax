import { EventEmitter } from "node:events";
import type * as net from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveEmbeddingGeneration } from "../src/lib/index/embedding-generation";

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

class FakeConnection extends EventEmitter {
  writable = true;
  writes: Array<Record<string, unknown>> = [];

  write(bytes: string): boolean {
    this.writes.push(JSON.parse(bytes.trim()));
    return true;
  }

  end(): this {
    return this;
  }
}

describe("daemon degraded first add", () => {
  afterEach(() => {
    mocks.projects.clear();
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  it.each(["degraded", "failed"])(
    "drains an existing watcher before full sync and restores it after a %s add",
    async (outcome) => {
      const root = "/existing/watched-project";
      const generation = resolveEmbeddingGeneration({ modelTier: "small" });
      const project = { root, name: "watched-project", status: "indexed" };
      mocks.projects.set(root, project);
      const events: string[] = [];
      const daemon = new Daemon() as any;
      daemon.activeConfig = { modelTier: "small", embedMode: "cpu" };
      daemon.activeGeneration = generation;
      daemon.metaCache = {};
      daemon.vectorDb = {
        pauseMaintenanceLoop: vi.fn(),
        resumeMaintenanceLoop: vi.fn(),
        countRowsForPath: vi.fn(async () => 0),
      };
      daemon.processors.set(root, {});
      vi.spyOn(daemon, "schedulePendingIndexRetry").mockImplementation(
        () => {},
      );
      vi.spyOn(daemon, "unwatchProjectWithinOperation").mockImplementation(
        async () => {
          events.push("drained");
          daemon.processors.delete(root);
        },
      );
      vi.spyOn(daemon, "watchProjectWithinOperation").mockImplementation(
        async () => {
          events.push("restored");
          daemon.processors.set(root, {});
        },
      );
      mocks.initialSync.mockImplementation(async () => {
        events.push("sync");
        expect(daemon.processors.has(root)).toBe(false);
        if (outcome === "failed") throw new Error("fixture sync failure");
        return {
          processed: 1,
          indexed: 0,
          total: 1,
          failedFiles: 1,
          degraded: true,
          scanErrors: [],
          generation,
          embedMode: "cpu",
        };
      });
      const conn = new FakeConnection();
      await daemon.addProjectLocked(
        root,
        conn,
        new AbortController().signal,
        project,
      );
      expect(events).toEqual(["drained", "sync", "restored"]);
      expect(daemon.processors.has(root)).toBe(true);
      expect(conn.writes.at(-1)).toMatchObject({
        type: "done",
        ok: outcome !== "failed",
      });
      expect(daemon.vectorDb.resumeMaintenanceLoop).toHaveBeenCalledOnce();
    },
  );

  it("durably registers a first-time degraded add as pending", async () => {
    const root = "/new/degraded-project";
    const generation = resolveEmbeddingGeneration({ modelTier: "small" });
    mocks.initialSync.mockImplementation(async () => {
      expect(mocks.projects.get(root)).toMatchObject({ status: "pending" });
      return {
        processed: 1,
        indexed: 0,
        total: 1,
        failedFiles: 1,
        degraded: true,
        scanErrors: ["unreadable"],
        generation,
        embedMode: "cpu",
        registryExpectation: {
          embeddingFingerprint: generation.fingerprint,
          rebuildId: null,
        },
      };
    });
    const daemon = new Daemon() as any;
    daemon.activeConfig = {
      modelTier: "small",
      vectorDim: generation.vectorDim,
      embedMode: "cpu",
    };
    daemon.activeGeneration = generation;
    daemon.metaCache = {};
    daemon.vectorDb = {
      pauseMaintenanceLoop: vi.fn(),
      resumeMaintenanceLoop: vi.fn(),
      countRowsForPath: vi.fn(async () => 0),
    };
    vi.spyOn(daemon, "watchProjectWithinOperation").mockResolvedValue(
      undefined,
    );
    const conn = new FakeConnection();

    await daemon.addProjectLocked(
      root,
      conn as unknown as net.Socket,
      new AbortController().signal,
      undefined,
    );

    expect(mocks.registerProject).toHaveBeenCalledWith(
      expect.objectContaining({ root, status: "pending" }),
    );
    expect(mocks.projects.get(root)).toMatchObject({ status: "pending" });
    expect(
      (daemon.pendingIndexRetryTimers as Map<string, unknown>).has(root),
    ).toBe(true);
    expect(conn.writes[conn.writes.length - 1]).toMatchObject({
      type: "done",
      ok: true,
      degraded: true,
    });
    daemon.clearPendingIndexRetry(root);
  });
});
