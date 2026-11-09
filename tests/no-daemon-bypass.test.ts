import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  sendDaemonCommand: vi.fn(),
  spawnDaemon: vi.fn(),
  spawn: vi.fn(),
  sendSearchCommand: vi.fn(),
  launchWatcher: vi.fn(),
  search: vi.fn(),
}));

vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
  spawn: h.spawn,
}));
vi.mock("../src/lib/utils/daemon-client", () => ({
  sendDaemonCommand: h.sendDaemonCommand,
}));
vi.mock("../src/lib/utils/daemon-launcher", () => ({
  spawnDaemon: h.spawnDaemon,
}));
vi.mock("../src/lib/utils/autostart", async (original) => ({
  ...(await original<typeof import("../src/lib/utils/autostart")>()),
  autostartDisabledNotice: () => null,
}));
vi.mock("../src/lib/utils/store-access", async (original) => ({
  ...(await original<typeof import("../src/lib/utils/store-access")>()),
  storeWriteDeniedNotice: () => null,
}));
vi.mock("../src/lib/utils/project-registry", () => ({
  getProject: (root: string) => ({ root, name: "fixture" }),
  listProjects: () => [],
  stampProjectFullSync: vi.fn(),
}));
vi.mock("../src/lib/utils/daemon-search", () => ({
  sendSearchCommand: h.sendSearchCommand,
}));
vi.mock("../src/lib/utils/watcher-launcher", async (original) => ({
  ...(await original<typeof import("../src/lib/utils/watcher-launcher")>()),
  launchWatcher: h.launchWatcher,
}));
vi.mock("../src/lib/index/embedding-status", () => ({
  assertEmbeddingSearchCompatible: () => {},
}));
vi.mock("../src/lib/index/index-config", () => ({
  readGlobalConfig: () => ({}),
}));
vi.mock("../src/lib/index/syncer", () => ({ initialSync: vi.fn() }));
vi.mock("../src/lib/setup/setup-helpers", () => ({
  ensureSetup: async () => {},
}));
vi.mock("../src/lib/utils/lock", () => ({ isLocked: () => false }));
vi.mock("../src/lib/store/vector-db", () => ({
  VectorDB: class {
    hasRowsForPath = async () => true;
    hasAnyRows = async () => true;
    close = async () => {};
  },
}));
vi.mock("../src/lib/search/searcher", () => ({
  Searcher: class {
    search = h.search;
  },
}));

import { runSearch } from "../src/commands/search-run";

const launchWatcher: typeof import("../src/lib/utils/watcher-launcher").launchWatcher = async (...args) => {
  const actual = await vi.importActual<typeof import("../src/lib/utils/watcher-launcher")>("../src/lib/utils/watcher-launcher");
  return actual.launchWatcher(...args);
};

describe("GMAX_NO_DAEMON=1", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.sendDaemonCommand.mockResolvedValue({ ok: false, error: "ENOENT" });
    h.spawnDaemon.mockResolvedValue(4242);
    h.sendSearchCommand.mockResolvedValue({ ok: false, error: "ENOENT" });
    h.search.mockResolvedValue({ data: [] });
    vi.stubEnv("GMAX_NO_DAEMON", "1");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("starts no daemon or watcher from the watcher launcher", async () => {
    const result = await launchWatcher("/synthetic/project", {
      holder: "fixture",
    });
    expect(result).toMatchObject({ ok: false, reason: "daemon-bypassed" });
    expect(h.spawnDaemon).not.toHaveBeenCalled();
    expect(h.spawn).not.toHaveBeenCalled();
  });

  it("keeps a search off the daemon and launches no watcher", async () => {
    // The watcher launch is skipped under vitest; clear both markers so the
    // search reaches it as a shell command would.
    vi.stubEnv("VITEST", "");
    vi.stubEnv("NODE_ENV", "");
    const result = await runSearch({
      pattern: "query",
      options: { m: "5" } as never,
      projectRoot: "/synthetic/project",
      effectiveRoot: "/synthetic/project",
      paths: { lancedbDir: "/synthetic/lancedb", dataDir: "/synthetic" },
      projectStatus: "indexed",
      searchFilters: {},
      pathFilter: undefined,
      seeds: undefined,
    } as never);
    expect(result.kind).toBe("result");
    expect(h.search).toHaveBeenCalledOnce();
    expect(h.sendSearchCommand).not.toHaveBeenCalled();
    expect(h.launchWatcher).not.toHaveBeenCalled();
  });

  it("still starts the daemon when the variable is unset", async () => {
    vi.stubEnv("GMAX_NO_DAEMON", "");
    h.sendDaemonCommand
      .mockResolvedValueOnce({ ok: false, error: "ENOENT" })
      .mockResolvedValue({ ok: true, pid: 4242 });
    const result = await launchWatcher("/synthetic/project", {
      holder: "fixture",
    });
    expect(h.spawnDaemon).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ ok: true, pid: 4242 });
  });
});
