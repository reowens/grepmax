import { describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/utils/project-registry", () => ({
  getProject: () => ({ status: "indexed" }),
}));

import { Daemon } from "../src/lib/daemon/daemon";
import { formatIndexStateFooter } from "../src/lib/output/index-state-footer";

function daemon(progress: Record<string, unknown>, health = {}) {
  const fake = Object.create(Daemon.prototype);
  fake.processors = new Map([["/repo", { progress }]]);
  fake.indexProgress = new Map();
  fake.watcherManager = { health: () => health };
  return fake as Daemon;
}

describe("daemon index health", () => {
  it("retains failed-file warnings once queued work settles", () => {
    const d = daemon({ pendingFiles: 0, processing: false, failedFiles: 3 });
    const state = d.indexState("/repo");
    expect(state).toMatchObject({ indexing: false, failedFiles: 3 });
    expect(formatIndexStateFooter(state, { agent: true })).toContain(
      "3 files failed",
    );
    expect(d.listProjects()[0]).toMatchObject({
      status: "degraded",
      indexState: { failedFiles: 3 },
    });
  });
  it("never claims current results while failures coexist with cache hits", () => {
    const d = daemon({
      pendingFiles: 1,
      processing: false,
      failedFiles: 3,
      recentFiles: 50,
      recentReindexed: 0,
    });
    expect(
      formatIndexStateFooter(d.indexState("/repo"), { agent: true }),
    ).toContain("3 files failed");
  });
  it("carries polling and reconciliation independently from queued files", () => {
    const d = daemon(
      { pendingFiles: 0, processing: false, failedFiles: 0 },
      { watcherMode: "polling", lastReconciledAt: 123, overflowCount: 9 },
    );
    expect(d.listProjects()[0].indexState).toMatchObject({
      watcherMode: "polling",
      lastReconciledAt: 123,
      overflowCount: 9,
    });
    expect(
      formatIndexStateFooter(d.indexState("/repo"), { agent: true }),
    ).toContain("polling");
  });
});
