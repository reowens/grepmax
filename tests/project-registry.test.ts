import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fsFailure = vi.hoisted(() => ({ readErrorPath: null as string | null }));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    readFileSync: (...args: Parameters<typeof actual.readFileSync>) => {
      if (String(args[0]) === fsFailure.readErrorPath) {
        const error = new Error("permission denied") as NodeJS.ErrnoException;
        error.code = "EACCES";
        throw error;
      }
      return (actual.readFileSync as (...input: unknown[]) => unknown)(...args);
    },
  };
});

describe("stampProjectFullSync", () => {
  it("atomically stamps the exact generation used by a successful sync", async () => {
    const { resolveEmbeddingGeneration } = await import(
      "../src/lib/index/embedding-generation"
    );
    const { getProject, registerProject, stampProjectFullSync } = await import(
      "../src/lib/utils/project-registry"
    );
    const generation = resolveEmbeddingGeneration({ modelTier: "small" });
    registerProject({
      root: "/tmp/exact-stamp",
      name: "exact-stamp",
      vectorDim: 384,
      modelTier: "small",
      embedMode: "cpu",
      lastIndexed: "",
      status: "pending",
    });

    stampProjectFullSync({
      root: "/tmp/exact-stamp",
      generation,
      embedMode: "gpu",
      chunkCount: 42,
      chunkerVersion: 4,
      indexedAt: "2026-07-11T00:00:00.000Z",
    });

    expect(getProject("/tmp/exact-stamp")).toMatchObject({
      modelTier: generation.tier,
      vectorDim: generation.vectorDim,
      embedModel: generation.onnxModel,
      mlxModel: generation.mlxModel,
      colbertModel: generation.colbertModel,
      embeddingFingerprint: generation.fingerprint,
      embedMode: "gpu",
      chunkCount: 42,
      status: "indexed",
    });
  });

  it("does not overwrite a project reserved by another rebuild", async () => {
    const { resolveEmbeddingGeneration } = await import(
      "../src/lib/index/embedding-generation"
    );
    const { getProject, registerProject, stampProjectFullSync } = await import(
      "../src/lib/utils/project-registry"
    );
    const generation = resolveEmbeddingGeneration({ modelTier: "small" });
    registerProject({
      root: "/tmp/rebuild-stamp",
      name: "rebuild-stamp",
      vectorDim: 384,
      modelTier: "small",
      embedMode: "cpu",
      lastIndexed: "old",
      status: "pending",
      rebuildId: "other-rebuild",
    });

    expect(() =>
      stampProjectFullSync({
        root: "/tmp/rebuild-stamp",
        generation,
        embedMode: "cpu",
        chunkCount: 1,
        chunkerVersion: 4,
      }),
    ).toThrow(/active rebuild/i);
    expect(getProject("/tmp/rebuild-stamp")?.lastIndexed).toBe("old");
  });
});

describe("project rebuild reservations", () => {
  it("atomically reserves every project with one complete target identity", async () => {
    const { resolveEmbeddingGeneration } = await import(
      "../src/lib/index/embedding-generation"
    );
    const { listProjects, registerProject, reserveProjectsForRebuild } =
      await import("../src/lib/utils/project-registry");
    const generation = resolveEmbeddingGeneration({ modelTier: "small" });
    for (const root of ["/tmp/reserve-a", "/tmp/reserve-b"]) {
      registerProject({
        root,
        name: path.basename(root),
        vectorDim: 384,
        modelTier: "small",
        embedMode: "cpu",
        lastIndexed: "old",
        status: "indexed",
      });
    }

    const reservation = reserveProjectsForRebuild(generation);

    expect(Object.isFrozen(reservation)).toBe(true);
    expect(Object.isFrozen(reservation.previous)).toBe(true);
    expect(Object.isFrozen(reservation.previous[0])).toBe(true);
    expect(Object.isFrozen(reservation.reserved)).toBe(true);
    expect(Object.isFrozen(reservation.reserved[0])).toBe(true);
    expect(reservation.previous).toHaveLength(2);
    expect(reservation.reserved).toEqual(listProjects());
    expect(
      reservation.reserved.every(
        (entry) =>
          entry.rebuildId === reservation.rebuildId &&
          entry.status === "pending" &&
          entry.modelTier === generation.tier &&
          entry.vectorDim === generation.vectorDim &&
          entry.embedModel === generation.onnxModel &&
          entry.mlxModel === generation.mlxModel &&
          entry.colbertModel === generation.colbertModel &&
          entry.embeddingFingerprint === generation.fingerprint,
      ),
    ).toBe(true);
  });

  it("restores only entries still carrying the matching rebuild identity", async () => {
    const { resolveEmbeddingGeneration } = await import(
      "../src/lib/index/embedding-generation"
    );
    const {
      getProject,
      registerProject,
      reserveProjectsForRebuild,
      restoreProjectsAfterRebuild,
    } = await import("../src/lib/utils/project-registry");
    const generation = resolveEmbeddingGeneration({ modelTier: "small" });
    registerProject({
      root: "/tmp/restore-matching",
      name: "restore-matching",
      vectorDim: 384,
      modelTier: "small",
      embedMode: "cpu",
      lastIndexed: "old",
      status: "indexed",
    });
    const reservation = reserveProjectsForRebuild(generation);

    restoreProjectsAfterRebuild({ ...reservation, rebuildId: "not-matching" });
    expect(getProject("/tmp/restore-matching")?.status).toBe("pending");

    restoreProjectsAfterRebuild(reservation);
    expect(getProject("/tmp/restore-matching")).toEqual(
      reservation.previous[0],
    );
  });

  it("preserves a competing project mutation during restore", async () => {
    const { resolveEmbeddingGeneration } = await import(
      "../src/lib/index/embedding-generation"
    );
    const {
      getProject,
      registerProject,
      reserveProjectsForRebuild,
      restoreProjectsAfterRebuild,
    } = await import("../src/lib/utils/project-registry");
    const generation = resolveEmbeddingGeneration({ modelTier: "small" });
    registerProject({
      root: "/tmp/restore-competing",
      name: "before",
      vectorDim: 384,
      modelTier: "small",
      embedMode: "cpu",
      lastIndexed: "old",
      status: "indexed",
    });
    const reservation = reserveProjectsForRebuild(generation);
    registerProject({
      ...reservation.reserved[0],
      name: "concurrent",
      lastIndexed: "new",
      status: "error",
      rebuildId: undefined,
    });

    restoreProjectsAfterRebuild(reservation);

    expect(getProject("/tmp/restore-competing")).toMatchObject({
      name: "concurrent",
      lastIndexed: "new",
      status: "error",
    });
  });

  it("rejects a stale full-sync stamp after reservation", async () => {
    const { resolveEmbeddingGeneration } = await import(
      "../src/lib/index/embedding-generation"
    );
    const {
      getProject,
      registerProject,
      reserveProjectsForRebuild,
      stampProjectFullSync,
    } = await import("../src/lib/utils/project-registry");
    const generation = resolveEmbeddingGeneration({ modelTier: "small" });
    registerProject({
      root: "/tmp/stale-reservation-stamp",
      name: "stale-reservation-stamp",
      vectorDim: 384,
      modelTier: "small",
      embedMode: "cpu",
      lastIndexed: "old",
      status: "indexed",
    });
    const reservation = reserveProjectsForRebuild(generation);

    expect(() =>
      stampProjectFullSync({
        root: "/tmp/stale-reservation-stamp",
        generation,
        embedMode: "cpu",
        chunkCount: 1,
        chunkerVersion: 4,
        expectedRebuildId: "stale-rebuild",
      }),
    ).toThrow(/rebuild identity changed/i);
    expect(getProject("/tmp/stale-reservation-stamp")?.rebuildId).toBe(
      reservation.rebuildId,
    );
  });

  it("keeps completed projects indexed while restoring unfinished projects", async () => {
    const { resolveEmbeddingGeneration } = await import(
      "../src/lib/index/embedding-generation"
    );
    const {
      getProject,
      registerProject,
      reserveProjectsForRebuild,
      restoreProjectsAfterRebuild,
      stampProjectFullSync,
    } = await import("../src/lib/utils/project-registry");
    const generation = resolveEmbeddingGeneration({ modelTier: "small" });
    for (const root of ["/tmp/complete", "/tmp/unfinished"]) {
      registerProject({
        root,
        name: path.basename(root),
        vectorDim: 384,
        modelTier: "small",
        embedMode: "cpu",
        lastIndexed: "old",
        status: "indexed",
      });
    }
    const reservation = reserveProjectsForRebuild(generation);
    stampProjectFullSync({
      root: "/tmp/complete",
      generation,
      embedMode: "gpu",
      chunkCount: 12,
      chunkerVersion: 4,
      indexedAt: "new",
      expectedRebuildId: reservation.rebuildId,
    });

    restoreProjectsAfterRebuild(reservation);

    expect(getProject("/tmp/complete")).toMatchObject({
      status: "indexed",
      lastIndexed: "new",
      chunkCount: 12,
    });
    expect(getProject("/tmp/unfinished")).toEqual(
      reservation.previous.find((entry) => entry.root === "/tmp/unfinished"),
    );
  });

  it("durably resumes an unfinished rebuild with the same identity", async () => {
    const { resolveEmbeddingGeneration } = await import(
      "../src/lib/index/embedding-generation"
    );
    const {
      getProject,
      registerProject,
      reserveProjectsForRebuild,
      stampProjectFullSync,
    } = await import("../src/lib/utils/project-registry");
    const generation = resolveEmbeddingGeneration({ modelTier: "small" });
    for (const root of ["/tmp/resume-a", "/tmp/resume-b"]) {
      registerProject({
        root,
        name: path.basename(root),
        vectorDim: 384,
        modelTier: "small",
        embedMode: "cpu",
        lastIndexed: "old",
        status: "indexed",
      });
    }
    const first = reserveProjectsForRebuild(generation);
    stampProjectFullSync({
      root: "/tmp/resume-a",
      generation,
      embedMode: "cpu",
      chunkCount: 1,
      chunkerVersion: 4,
      expectedRebuildId: first.rebuildId,
    });
    registerProject({
      root: "/tmp/resume-new",
      name: "resume-new",
      vectorDim: 384,
      modelTier: "small",
      embedMode: "cpu",
      lastIndexed: "newly-added",
      status: "indexed",
    });

    const resumed = reserveProjectsForRebuild(generation);

    expect(resumed.rebuildId).toBe(first.rebuildId);
    expect(getProject("/tmp/resume-a")).toMatchObject({
      status: "pending",
      rebuildId: first.rebuildId,
    });
    expect(getProject("/tmp/resume-b")).toMatchObject({
      status: "pending",
      rebuildId: first.rebuildId,
    });
    expect(getProject("/tmp/resume-new")).toMatchObject({
      status: "pending",
      rebuildId: first.rebuildId,
    });
    expect(resumed.reserved).toHaveLength(3);
  });

  it("recovers a valid orphaned rebuild journal temp file", async () => {
    const { resolveEmbeddingGeneration } = await import(
      "../src/lib/index/embedding-generation"
    );
    const {
      hasUnfinishedProjectRebuild,
      registerProject,
      reserveProjectsForRebuild,
    } = await import("../src/lib/utils/project-registry");
    const generation = resolveEmbeddingGeneration({ modelTier: "small" });
    registerProject({
      root: "/tmp/temp-recovery",
      name: "temp-recovery",
      vectorDim: 384,
      modelTier: "small",
      embedMode: "cpu",
      lastIndexed: "old",
      status: "indexed",
    });
    const reservation = reserveProjectsForRebuild(generation);
    const temp = `${REBUILD_JOURNAL_FILE}.${reservation.rebuildId}.tmp`;
    fs.copyFileSync(REBUILD_JOURNAL_FILE, temp);
    fs.unlinkSync(REBUILD_JOURNAL_FILE);

    expect(hasUnfinishedProjectRebuild()).toBe(true);
    expect(fs.existsSync(REBUILD_JOURNAL_FILE)).toBe(true);
    expect(fs.existsSync(temp)).toBe(false);
    expect(reserveProjectsForRebuild(generation).rebuildId).toBe(
      reservation.rebuildId,
    );
  });

  it("clears the durable journal only after every reserved project completes", async () => {
    const { resolveEmbeddingGeneration } = await import(
      "../src/lib/index/embedding-generation"
    );
    const {
      completeProjectRebuild,
      registerProject,
      reserveProjectsForRebuild,
      stampProjectFullSync,
    } = await import("../src/lib/utils/project-registry");
    const generation = resolveEmbeddingGeneration({ modelTier: "small" });
    registerProject({
      root: "/tmp/journal-complete",
      name: "journal-complete",
      vectorDim: 384,
      modelTier: "small",
      embedMode: "cpu",
      lastIndexed: "old",
      status: "indexed",
    });
    const reservation = reserveProjectsForRebuild(generation);
    expect(() => completeProjectRebuild(reservation.rebuildId)).toThrow(
      /remain pending/i,
    );
    stampProjectFullSync({
      root: "/tmp/journal-complete",
      generation,
      embedMode: "cpu",
      chunkCount: 1,
      chunkerVersion: 4,
      expectedRebuildId: reservation.rebuildId,
    });

    completeProjectRebuild(reservation.rebuildId);

    expect(fs.existsSync(REBUILD_JOURNAL_FILE)).toBe(false);
  });
});

// Override PATHS.globalRoot to a temp dir so tests don't touch the real registry.
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "gmax-registry-test-"));

vi.mock("../src/config", async () => {
  const actual =
    await vi.importActual<typeof import("../src/config")>("../src/config");
  return {
    ...actual,
    PATHS: { ...actual.PATHS, globalRoot: tmpRoot },
  };
});

const REGISTRY_FILE = path.join(tmpRoot, "projects.json");
const REBUILD_JOURNAL_FILE = path.join(tmpRoot, "rebuild-journal.json");

beforeEach(() => {
  fsFailure.readErrorPath = null;
  if (fs.existsSync(REGISTRY_FILE)) fs.unlinkSync(REGISTRY_FILE);
  if (fs.existsSync(REBUILD_JOURNAL_FILE)) fs.unlinkSync(REBUILD_JOURNAL_FILE);
});

afterEach(() => {
  fsFailure.readErrorPath = null;
  if (fs.existsSync(REGISTRY_FILE)) fs.unlinkSync(REGISTRY_FILE);
  if (fs.existsSync(REBUILD_JOURNAL_FILE)) fs.unlinkSync(REBUILD_JOURNAL_FILE);
});

function writeRegistry(entries: Array<{ name: string; root: string }>) {
  const full = entries.map((e) => ({
    ...e,
    vectorDim: 384,
    modelTier: "small",
    embedMode: "auto",
    lastIndexed: "2026-01-01T00:00:00Z",
  }));
  fs.writeFileSync(REGISTRY_FILE, JSON.stringify(full, null, 2));
}

describe("resolveProjectRoot", () => {
  it("returns absolute path unchanged when arg contains a separator", async () => {
    const { resolveProjectRoot } = await import(
      "../src/lib/utils/project-registry"
    );
    expect(resolveProjectRoot("/abs/path/x")).toBe("/abs/path/x");
  });

  it("resolves a registered name to its root", async () => {
    const { resolveProjectRoot } = await import(
      "../src/lib/utils/project-registry"
    );
    writeRegistry([{ name: "my-app", root: "/Users/me/projects/my-app" }]);
    expect(resolveProjectRoot("my-app")).toBe("/Users/me/projects/my-app");
  });

  it("throws with available list when no name matches", async () => {
    const { resolveProjectRoot } = await import(
      "../src/lib/utils/project-registry"
    );
    writeRegistry([{ name: "app-a", root: "/x/app-a" }]);
    expect(() => resolveProjectRoot("nope")).toThrow(/No registered project/);
    expect(() => resolveProjectRoot("nope")).toThrow(/app-a/);
  });

  it("throws with both paths on duplicate name", async () => {
    const { resolveProjectRoot } = await import(
      "../src/lib/utils/project-registry"
    );
    writeRegistry([
      { name: "dup", root: "/a/dup" },
      { name: "dup", root: "/b/dup" },
    ]);
    expect(() => resolveProjectRoot("dup")).toThrow(/Multiple registered/);
    expect(() => resolveProjectRoot("dup")).toThrow(/\/a\/dup/);
    expect(() => resolveProjectRoot("dup")).toThrow(/\/b\/dup/);
  });

  it("treats existing directory args as paths even without a separator", async () => {
    const { resolveProjectRoot } = await import(
      "../src/lib/utils/project-registry"
    );
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gmax-existing-"));
    const basename = path.basename(dir);
    writeRegistry([{ name: basename, root: "/some/other/place" }]);
    // Run from the parent so basename resolves to the real dir.
    const cwd = process.cwd();
    process.chdir(path.dirname(dir));
    try {
      expect(resolveProjectRoot(basename)).toBe(path.resolve(basename));
    } finally {
      process.chdir(cwd);
      fs.rmdirSync(dir);
    }
  });
});

// getParentProject is the resolver behind the MCP search-scope fix: a session
// launched inside an umbrella project (which may have no .git of its own) must
// resolve UP to the registered umbrella instead of falling back to a global
// search. These cases mirror the qsys leak table from the triage plan.
describe("getParentProject", () => {
  it("resolves a subdirectory to its registered umbrella", async () => {
    const { getParentProject } = await import(
      "../src/lib/utils/project-registry"
    );
    writeRegistry([{ name: "qsys", root: "/Users/me/projects/qsys" }]);
    expect(
      getParentProject("/Users/me/projects/qsys/qsys-training")?.name,
    ).toBe("qsys");
    // Deeper nesting still resolves to the umbrella.
    expect(getParentProject("/Users/me/projects/qsys/docs/guides")?.name).toBe(
      "qsys",
    );
  });

  it("returns undefined for the umbrella root itself (no self-match)", async () => {
    const { getParentProject } = await import(
      "../src/lib/utils/project-registry"
    );
    writeRegistry([{ name: "qsys", root: "/Users/me/projects/qsys" }]);
    expect(getParentProject("/Users/me/projects/qsys")).toBeUndefined();
  });

  it("returns undefined for a path outside any registered project", async () => {
    const { getParentProject } = await import(
      "../src/lib/utils/project-registry"
    );
    writeRegistry([{ name: "qsys", root: "/Users/me/projects/qsys" }]);
    expect(getParentProject("/Users/me/projects/platform")).toBeUndefined();
  });

  it("does not match a sibling that shares a name prefix", async () => {
    const { getParentProject } = await import(
      "../src/lib/utils/project-registry"
    );
    writeRegistry([{ name: "qsys", root: "/Users/me/projects/qsys" }]);
    // /qsys-other is NOT inside /qsys — the path-boundary guard must reject it.
    expect(
      getParentProject("/Users/me/projects/qsys-other/src"),
    ).toBeUndefined();
  });
});

describe("strict registry reads", () => {
  it.each([
    ["malformed JSON", "[{"],
    ["truncated JSON", '[{"root":"/work/app"'],
    ["non-array JSON", '{"projects":[]}'],
    [
      "invalid entry shape",
      JSON.stringify([{ root: "/work/app", name: "app" }]),
    ],
  ])("rejects %s", async (_label, bytes) => {
    const { listProjects } = await import("../src/lib/utils/project-registry");
    fs.writeFileSync(REGISTRY_FILE, bytes);

    expect(() => listProjects()).toThrow(/invalid project registry/i);
  });

  it("does not overwrite malformed bytes during register or remove", async () => {
    const { registerProject, removeProject } = await import(
      "../src/lib/utils/project-registry"
    );
    const bytes = "[{";
    fs.writeFileSync(REGISTRY_FILE, bytes);
    const entry = {
      root: "/work/app",
      name: "app",
      vectorDim: 384,
      modelTier: "small",
      embedMode: "cpu",
      lastIndexed: "",
    };

    expect(() => registerProject(entry)).toThrow(/invalid project registry/i);
    expect(fs.readFileSync(REGISTRY_FILE, "utf8")).toBe(bytes);
    expect(() => removeProject(entry.root)).toThrow(
      /invalid project registry/i,
    );
    expect(fs.readFileSync(REGISTRY_FILE, "utf8")).toBe(bytes);
  });

  it("surfaces EACCES and leaves the original registry unchanged", async () => {
    const { listProjects, registerProject } = await import(
      "../src/lib/utils/project-registry"
    );
    writeRegistry([{ name: "app", root: "/work/app" }]);
    const bytes = fs.readFileSync(REGISTRY_FILE, "utf8");
    fsFailure.readErrorPath = REGISTRY_FILE;

    expect(() => listProjects()).toThrow(/failed to read project registry/i);
    expect(() =>
      registerProject({
        root: "/work/new",
        name: "new",
        vectorDim: 384,
        modelTier: "small",
        embedMode: "cpu",
        lastIndexed: "",
      }),
    ).toThrow(/failed to read project registry/i);

    fsFailure.readErrorPath = null;
    expect(fs.readFileSync(REGISTRY_FILE, "utf8")).toBe(bytes);
  });

  it("rejects invalid entries before changing registry bytes", async () => {
    const { registerProject } = await import(
      "../src/lib/utils/project-registry"
    );
    writeRegistry([{ name: "app", root: "/work/app" }]);
    const bytes = fs.readFileSync(REGISTRY_FILE, "utf8");

    expect(() =>
      registerProject({
        root: "/work/bad",
        name: "bad",
        vectorDim: Number.NaN,
        modelTier: "small",
        embedMode: "cpu",
        lastIndexed: "",
      }),
    ).toThrow(/invalid project registry entry/i);
    expect(fs.readFileSync(REGISTRY_FILE, "utf8")).toBe(bytes);
  });

  it("round-trips optional exact embedding identity fields", async () => {
    const { listProjects, registerProject } = await import(
      "../src/lib/utils/project-registry"
    );
    const { resolveEmbeddingGeneration } = await import(
      "../src/lib/index/embedding-generation"
    );
    const generation = resolveEmbeddingGeneration({
      modelTier: "small",
      vectorDim: 384,
      mlxModel: "mlx/model",
    });
    const exactIdentity = {
      embedModel: generation.onnxModel,
      mlxModel: generation.mlxModel,
      colbertModel: generation.colbertModel,
      embeddingFingerprint: generation.fingerprint,
      rebuildId: "rebuild-1",
    };

    registerProject({
      root: "/work/exact",
      name: "exact",
      vectorDim: 384,
      modelTier: "small",
      embedMode: "cpu",
      lastIndexed: "2026-07-10T00:00:00Z",
      ...exactIdentity,
    });

    expect(listProjects()[0]).toMatchObject(exactIdentity);
  });

  it("accepts a coherent historical identity independent of current mappings", async () => {
    const { computeEmbeddingFingerprint } = await import(
      "../src/lib/index/embedding-generation"
    );
    const { listProjects } = await import("../src/lib/utils/project-registry");
    const identity = {
      tier: "retired-tier",
      vectorDim: 512,
      onnxModel: "historical/onnx",
      mlxModel: "historical/mlx",
      colbertModel: "historical/colbert",
    };
    fs.writeFileSync(
      REGISTRY_FILE,
      JSON.stringify([
        {
          root: "/work/historical",
          name: "historical",
          vectorDim: identity.vectorDim,
          modelTier: identity.tier,
          embedMode: "gpu",
          lastIndexed: "2026-01-01T00:00:00Z",
          embedModel: identity.onnxModel,
          mlxModel: identity.mlxModel,
          colbertModel: identity.colbertModel,
          embeddingFingerprint: computeEmbeddingFingerprint(identity),
        },
      ]),
    );

    expect(listProjects()[0]).toMatchObject({
      modelTier: identity.tier,
      embedModel: identity.onnxModel,
      mlxModel: identity.mlxModel,
      colbertModel: identity.colbertModel,
    });
  });

  it("rejects an internally incoherent historical fingerprint", async () => {
    const { listProjects } = await import("../src/lib/utils/project-registry");
    fs.writeFileSync(
      REGISTRY_FILE,
      JSON.stringify([
        {
          root: "/work/historical",
          name: "historical",
          vectorDim: 512,
          modelTier: "retired-tier",
          embedMode: "gpu",
          lastIndexed: "2026-01-01T00:00:00Z",
          embedModel: "historical/onnx",
          mlxModel: "historical/mlx",
          colbertModel: "historical/colbert",
          embeddingFingerprint: "b".repeat(64),
        },
      ]),
    );

    expect(() => listProjects()).toThrow(/invalid project registry entry/i);
  });

  it.each([
    ["embedModel", ""],
    ["mlxModel", 42],
    ["colbertModel", ""],
    ["embeddingFingerprint", "not-a-fingerprint"],
    ["rebuildId", ""],
  ])("rejects invalid optional identity field %s", async (field, value) => {
    const { listProjects } = await import("../src/lib/utils/project-registry");
    fs.writeFileSync(
      REGISTRY_FILE,
      JSON.stringify([
        {
          root: "/work/bad",
          name: "bad",
          vectorDim: 384,
          modelTier: "small",
          embedMode: "cpu",
          lastIndexed: "",
          [field]: value,
        },
      ]),
    );

    expect(() => listProjects()).toThrow(/invalid project registry entry/i);
  });

  it("rejects a persisted tier and dimension contradiction", async () => {
    const { listProjects } = await import("../src/lib/utils/project-registry");
    fs.writeFileSync(
      REGISTRY_FILE,
      JSON.stringify([
        {
          root: "/work/bad",
          name: "bad",
          vectorDim: 768,
          modelTier: "small",
          embedMode: "cpu",
          lastIndexed: "",
        },
      ]),
    );

    expect(() => listProjects()).toThrow(/invalid project registry entry/i);
  });

  it.each([
    ["embedModel", "other/onnx"],
    ["colbertModel", "other/colbert"],
    ["embeddingFingerprint", "b".repeat(64)],
  ])("rejects contradictory exact identity field %s", async (field, value) => {
    const { listProjects } = await import("../src/lib/utils/project-registry");
    fs.writeFileSync(
      REGISTRY_FILE,
      JSON.stringify([
        {
          root: "/work/bad",
          name: "bad",
          vectorDim: 384,
          modelTier: "small",
          embedMode: "cpu",
          lastIndexed: "",
          [field]: value,
        },
      ]),
    );

    expect(() => listProjects()).toThrow(/invalid project registry entry/i);
  });

  it("rejects a second lexical root for the same canonical directory", async () => {
    const { registerProject } = await import(
      "../src/lib/utils/project-registry"
    );
    const project = fs.mkdtempSync(
      path.join(os.tmpdir(), "gmax-project-real-"),
    );
    const alias = `${project}-alias`;
    fs.symlinkSync(project, alias);
    const makeEntry = (root: string, name: string) => ({
      root,
      name,
      vectorDim: 384,
      modelTier: "small",
      embedMode: "cpu",
      lastIndexed: "",
    });
    try {
      registerProject(makeEntry(project, "real"));
      expect(() => registerProject(makeEntry(alias, "alias"))).toThrow(
        /already registered project/i,
      );
    } finally {
      fs.rmSync(alias, { force: true });
      fs.rmSync(project, { recursive: true, force: true });
    }
  });
});
