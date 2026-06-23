import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Override PATHS.globalRoot to a temp dir so tests don't touch the real
// registry. Spreads `...actual` so CONFIG / CHUNKER_VERSION_HISTORY /
// describeChunkerGap stay real.
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "gmax-stalehint-test-"));

vi.mock("../src/config", async () => {
  const actual = await vi.importActual<typeof import("../src/config")>(
    "../src/config",
  );
  return {
    ...actual,
    PATHS: { ...actual.PATHS, globalRoot: tmpRoot },
  };
});

const REGISTRY_FILE = path.join(tmpRoot, "projects.json");
const CONFIG_FILE = path.join(tmpRoot, "config.json");

function writeRegistry(
  entries: Array<{
    name: string;
    root: string;
    chunkerVersion?: number;
    status?: string;
    vectorDim?: number;
    modelTier?: string;
  }>,
) {
  const full = entries.map((e) => ({
    vectorDim: 384,
    modelTier: "small",
    embedMode: "auto",
    lastIndexed: "2026-01-01T00:00:00Z",
    status: "indexed",
    ...e,
  }));
  fs.writeFileSync(REGISTRY_FILE, JSON.stringify(full, null, 2));
}

/** Set the current global config (what the next index would produce). Absence
 * of the file makes readGlobalConfig fall back to the default tier (small/384). */
function writeGlobalConfig(modelTier: string, vectorDim: number) {
  fs.writeFileSync(
    CONFIG_FILE,
    JSON.stringify({ modelTier, vectorDim, embedMode: "cpu" }, null, 2),
  );
}

function clearGlobalConfig() {
  if (fs.existsSync(CONFIG_FILE)) fs.unlinkSync(CONFIG_FILE);
}

describe("describeChunkerGap", () => {
  it("returns null when the index is current", async () => {
    const { describeChunkerGap, CONFIG } = await import("../src/config");
    expect(describeChunkerGap(CONFIG.CHUNKER_VERSION)).toBeNull();
  });

  it("flags an additive-only gap (v2 -> current) as additive", async () => {
    const { describeChunkerGap, CONFIG } = await import("../src/config");
    const gap = describeChunkerGap(2);
    expect(gap).not.toBeNull();
    expect(gap?.severity).toBe("additive");
    expect(gap?.fromVersion).toBe(2);
    expect(gap?.toVersion).toBe(CONFIG.CHUNKER_VERSION);
    expect(gap?.notes.join(" ")).toMatch(/type-position/);
    // Must not include the v2 note — that version is already present.
    expect(gap?.notes.join(" ")).not.toMatch(/overcounted/);
  });

  it("flags a gap that crosses a breaking version as breaking", async () => {
    const { describeChunkerGap } = await import("../src/config");
    const gap = describeChunkerGap(1);
    expect(gap?.severity).toBe("breaking");
    // Renders every missed version's note.
    expect(gap?.notes.length).toBeGreaterThanOrEqual(2);
  });

  it("treats an unstamped index as version 1", async () => {
    const { describeChunkerGap } = await import("../src/config");
    expect(describeChunkerGap(undefined)?.fromVersion).toBe(1);
  });

  it("keeps CONFIG.CHUNKER_VERSION in sync with the history's latest entry", async () => {
    const { CONFIG, CHUNKER_VERSION_HISTORY } = await import("../src/config");
    const latest = Math.max(...CHUNKER_VERSION_HISTORY.map((h) => h.v));
    expect(CONFIG.CHUNKER_VERSION).toBe(latest);
  });
});

describe("maybeWarnStaleChunker", () => {
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    if (fs.existsSync(REGISTRY_FILE)) fs.unlinkSync(REGISTRY_FILE);
    delete process.env.GMAX_NO_STALE_HINT;
    const { _resetStaleHintForTests } = await import(
      "../src/lib/utils/stale-hint"
    );
    _resetStaleHintForTests();
    errSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    errSpy.mockRestore();
    if (fs.existsSync(REGISTRY_FILE)) fs.unlinkSync(REGISTRY_FILE);
  });

  const emitted = () =>
    errSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("");

  it("warns on STDERR for a stale, indexed project", async () => {
    writeRegistry([{ name: "foo", root: "/proj/foo", chunkerVersion: 2 }]);
    const { maybeWarnStaleChunker } = await import("../src/lib/utils/stale-hint");
    maybeWarnStaleChunker("/proj/foo");
    const out = emitted();
    expect(out).toMatch(/foo/);
    expect(out).toMatch(/v2/);
    expect(out).toMatch(/index --reset/);
  });

  it("stays silent for a current index", async () => {
    const { CONFIG } = await import("../src/config");
    writeRegistry([
      { name: "foo", root: "/proj/foo", chunkerVersion: CONFIG.CHUNKER_VERSION },
    ]);
    const { maybeWarnStaleChunker } = await import("../src/lib/utils/stale-hint");
    maybeWarnStaleChunker("/proj/foo");
    expect(emitted()).toBe("");
  });

  it("respects GMAX_NO_STALE_HINT=1", async () => {
    process.env.GMAX_NO_STALE_HINT = "1";
    writeRegistry([{ name: "foo", root: "/proj/foo", chunkerVersion: 2 }]);
    const { maybeWarnStaleChunker } = await import("../src/lib/utils/stale-hint");
    maybeWarnStaleChunker("/proj/foo");
    expect(emitted()).toBe("");
  });

  it("emits at most once per process", async () => {
    writeRegistry([{ name: "foo", root: "/proj/foo", chunkerVersion: 2 }]);
    const { maybeWarnStaleChunker } = await import("../src/lib/utils/stale-hint");
    maybeWarnStaleChunker("/proj/foo");
    maybeWarnStaleChunker("/proj/foo");
    expect(errSpy.mock.calls.length).toBe(1);
  });

  it("stays silent for a pending project", async () => {
    writeRegistry([
      { name: "foo", root: "/proj/foo", chunkerVersion: 2, status: "pending" },
    ]);
    const { maybeWarnStaleChunker } = await import("../src/lib/utils/stale-hint");
    maybeWarnStaleChunker("/proj/foo");
    expect(emitted()).toBe("");
  });

  it("stays silent for an unregistered root", async () => {
    writeRegistry([{ name: "foo", root: "/proj/foo", chunkerVersion: 2 }]);
    const { maybeWarnStaleChunker } = await import("../src/lib/utils/stale-hint");
    maybeWarnStaleChunker("/proj/other");
    expect(emitted()).toBe("");
  });

  it("renders a parseable TSV record in --agent mode", async () => {
    writeRegistry([{ name: "foo", root: "/proj/foo", chunkerVersion: 2 }]);
    const { maybeWarnStaleChunker } = await import("../src/lib/utils/stale-hint");
    maybeWarnStaleChunker("/proj/foo", { agent: true });
    const out = emitted();
    expect(out).toMatch(/^stale_chunker\t/);
    expect(out).toMatch(/severity=additive/);
    expect(out).toMatch(/indexed_v=2/);
    expect(out).toMatch(/fix=gmax index --reset/);
  });
});

describe("describeEmbeddingGap", () => {
  it("returns null when model + dim match", async () => {
    const { describeEmbeddingGap } = await import("../src/config");
    expect(
      describeEmbeddingGap(
        { modelTier: "small", vectorDim: 384 },
        { modelTier: "small", vectorDim: 384 },
      ),
    ).toBeNull();
  });

  it("flags a same-dim model swap as additive", async () => {
    const { describeEmbeddingGap } = await import("../src/config");
    const gap = describeEmbeddingGap(
      { modelTier: "small", vectorDim: 384 },
      { modelTier: "standard", vectorDim: 384 },
    );
    expect(gap).not.toBeNull();
    expect(gap?.dimChanged).toBe(false);
    expect(gap?.severity).toBe("additive");
    expect(gap?.fromModel).toBe("small");
    expect(gap?.toModel).toBe("standard");
  });

  it("flags a dimension change as breaking", async () => {
    const { describeEmbeddingGap } = await import("../src/config");
    const gap = describeEmbeddingGap(
      { modelTier: "small", vectorDim: 384 },
      { modelTier: "standard", vectorDim: 768 },
    );
    expect(gap?.dimChanged).toBe(true);
    expect(gap?.severity).toBe("breaking");
    expect(gap?.fromDim).toBe(384);
    expect(gap?.toDim).toBe(768);
  });

  it("derives dim from the model tier when vectorDim is omitted", async () => {
    const { describeEmbeddingGap } = await import("../src/config");
    const gap = describeEmbeddingGap(
      { modelTier: "small" },
      { modelTier: "standard" },
    );
    // small=384, standard=768 per MODEL_TIERS → breaking dim change.
    expect(gap?.fromDim).toBe(384);
    expect(gap?.toDim).toBe(768);
    expect(gap?.severity).toBe("breaking");
  });

  it("defaults a missing modelTier to the default tier", async () => {
    const { describeEmbeddingGap, DEFAULT_MODEL_TIER } = await import(
      "../src/config"
    );
    const gap = describeEmbeddingGap(
      {},
      { modelTier: "standard", vectorDim: 768 },
    );
    expect(gap?.fromModel).toBe(DEFAULT_MODEL_TIER);
  });
});

describe("maybeWarnStaleEmbedding", () => {
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    if (fs.existsSync(REGISTRY_FILE)) fs.unlinkSync(REGISTRY_FILE);
    clearGlobalConfig();
    delete process.env.GMAX_NO_STALE_HINT;
    const { _resetStaleHintForTests } = await import(
      "../src/lib/utils/stale-hint"
    );
    _resetStaleHintForTests();
    errSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    errSpy.mockRestore();
    if (fs.existsSync(REGISTRY_FILE)) fs.unlinkSync(REGISTRY_FILE);
    clearGlobalConfig();
  });

  const emitted = () =>
    errSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("");

  it("warns on STDERR for a dim-changed (breaking) index", async () => {
    writeGlobalConfig("standard", 768);
    writeRegistry([
      { name: "foo", root: "/proj/foo", modelTier: "small", vectorDim: 384 },
    ]);
    const { maybeWarnStaleEmbedding } = await import(
      "../src/lib/utils/stale-hint"
    );
    maybeWarnStaleEmbedding("/proj/foo");
    const out = emitted();
    expect(out).toMatch(/foo/);
    expect(out).toMatch(/384/);
    expect(out).toMatch(/768/);
    expect(out).toMatch(/index --reset/);
    expect(out).toMatch(/^WARN/);
  });

  it("uses a 'hint' label for an additive same-dim model swap", async () => {
    // Current config defaults to small/384; project tagged standard but still
    // 384d → same dim, model changed → additive.
    writeRegistry([
      { name: "foo", root: "/proj/foo", modelTier: "standard", vectorDim: 384 },
    ]);
    const { maybeWarnStaleEmbedding } = await import(
      "../src/lib/utils/stale-hint"
    );
    maybeWarnStaleEmbedding("/proj/foo");
    const out = emitted();
    expect(out).toMatch(/^hint/);
    expect(out).toMatch(/mix models/);
  });

  it("stays silent for a current index", async () => {
    writeRegistry([
      { name: "foo", root: "/proj/foo", modelTier: "small", vectorDim: 384 },
    ]);
    const { maybeWarnStaleEmbedding } = await import(
      "../src/lib/utils/stale-hint"
    );
    maybeWarnStaleEmbedding("/proj/foo");
    expect(emitted()).toBe("");
  });

  it("respects GMAX_NO_STALE_HINT=1", async () => {
    process.env.GMAX_NO_STALE_HINT = "1";
    writeGlobalConfig("standard", 768);
    writeRegistry([
      { name: "foo", root: "/proj/foo", modelTier: "small", vectorDim: 384 },
    ]);
    const { maybeWarnStaleEmbedding } = await import(
      "../src/lib/utils/stale-hint"
    );
    maybeWarnStaleEmbedding("/proj/foo");
    expect(emitted()).toBe("");
  });

  it("emits at most once per process", async () => {
    writeGlobalConfig("standard", 768);
    writeRegistry([
      { name: "foo", root: "/proj/foo", modelTier: "small", vectorDim: 384 },
    ]);
    const { maybeWarnStaleEmbedding } = await import(
      "../src/lib/utils/stale-hint"
    );
    maybeWarnStaleEmbedding("/proj/foo");
    maybeWarnStaleEmbedding("/proj/foo");
    expect(errSpy.mock.calls.length).toBe(1);
  });

  it("stays silent for a pending project", async () => {
    writeGlobalConfig("standard", 768);
    writeRegistry([
      {
        name: "foo",
        root: "/proj/foo",
        modelTier: "small",
        vectorDim: 384,
        status: "pending",
      },
    ]);
    const { maybeWarnStaleEmbedding } = await import(
      "../src/lib/utils/stale-hint"
    );
    maybeWarnStaleEmbedding("/proj/foo");
    expect(emitted()).toBe("");
  });

  it("stays silent for an unregistered root", async () => {
    writeGlobalConfig("standard", 768);
    writeRegistry([
      { name: "foo", root: "/proj/foo", modelTier: "small", vectorDim: 384 },
    ]);
    const { maybeWarnStaleEmbedding } = await import(
      "../src/lib/utils/stale-hint"
    );
    maybeWarnStaleEmbedding("/proj/other");
    expect(emitted()).toBe("");
  });

  it("renders a parseable TSV record in --agent mode", async () => {
    writeGlobalConfig("standard", 768);
    writeRegistry([
      { name: "foo", root: "/proj/foo", modelTier: "small", vectorDim: 384 },
    ]);
    const { maybeWarnStaleEmbedding } = await import(
      "../src/lib/utils/stale-hint"
    );
    maybeWarnStaleEmbedding("/proj/foo", { agent: true });
    const out = emitted();
    expect(out).toMatch(/^stale_embedding\t/);
    expect(out).toMatch(/dim_changed=true/);
    expect(out).toMatch(/severity=breaking/);
    expect(out).toMatch(/indexed_dim=384/);
    expect(out).toMatch(/current_dim=768/);
    expect(out).toMatch(/fix=gmax index --reset/);
  });

  it("fires independently of the chunker latch", async () => {
    // A project stale on BOTH concerns must surface both hints — the latches
    // are independent.
    writeGlobalConfig("standard", 768);
    writeRegistry([
      {
        name: "foo",
        root: "/proj/foo",
        chunkerVersion: 2,
        modelTier: "small",
        vectorDim: 384,
      },
    ]);
    const { maybeWarnStaleChunker, maybeWarnStaleEmbedding } = await import(
      "../src/lib/utils/stale-hint"
    );
    maybeWarnStaleChunker("/proj/foo");
    maybeWarnStaleEmbedding("/proj/foo");
    const out = emitted();
    expect(out).toMatch(/chunker v2/);
    expect(out).toMatch(/embedding/);
  });
});

describe("maybeWarnCrossProjectDim", () => {
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    if (fs.existsSync(REGISTRY_FILE)) fs.unlinkSync(REGISTRY_FILE);
    clearGlobalConfig();
    delete process.env.GMAX_NO_STALE_HINT;
    const { _resetStaleHintForTests } = await import(
      "../src/lib/utils/stale-hint"
    );
    _resetStaleHintForTests();
    errSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    errSpy.mockRestore();
    if (fs.existsSync(REGISTRY_FILE)) fs.unlinkSync(REGISTRY_FILE);
    clearGlobalConfig();
  });

  const emitted = () =>
    errSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("");

  const roots = [
    { root: "/proj/foo", name: "foo" },
    { root: "/proj/bar", name: "bar" },
  ];

  it("warns when in-scope projects span mixed dims", async () => {
    // Query dim defaults to 384 (no config.json). bar is 768d → mismatch.
    writeRegistry([
      { name: "foo", root: "/proj/foo", vectorDim: 384, modelTier: "small" },
      { name: "bar", root: "/proj/bar", vectorDim: 768, modelTier: "standard" },
    ]);
    const { maybeWarnCrossProjectDim } = await import(
      "../src/lib/utils/stale-hint"
    );
    maybeWarnCrossProjectDim(roots);
    const out = emitted();
    expect(out).toMatch(/^WARN/);
    expect(out).toMatch(/bar/);
    expect(out).toMatch(/768/);
  });

  it("stays silent when all in-scope projects share the query dim", async () => {
    writeRegistry([
      { name: "foo", root: "/proj/foo", vectorDim: 384, modelTier: "small" },
      { name: "bar", root: "/proj/bar", vectorDim: 384, modelTier: "small" },
    ]);
    const { maybeWarnCrossProjectDim } = await import(
      "../src/lib/utils/stale-hint"
    );
    maybeWarnCrossProjectDim(roots);
    expect(emitted()).toBe("");
  });

  it("renders a parseable TSV record in --agent mode", async () => {
    writeRegistry([
      { name: "foo", root: "/proj/foo", vectorDim: 384, modelTier: "small" },
      { name: "bar", root: "/proj/bar", vectorDim: 768, modelTier: "standard" },
    ]);
    const { maybeWarnCrossProjectDim } = await import(
      "../src/lib/utils/stale-hint"
    );
    maybeWarnCrossProjectDim(roots, { agent: true });
    const out = emitted();
    expect(out).toMatch(/^stale_embedding_crossdim\t/);
    expect(out).toMatch(/query_dim=384/);
    expect(out).toMatch(/mismatched=bar:768/);
  });

  it("respects GMAX_NO_STALE_HINT=1", async () => {
    process.env.GMAX_NO_STALE_HINT = "1";
    writeRegistry([
      { name: "foo", root: "/proj/foo", vectorDim: 384, modelTier: "small" },
      { name: "bar", root: "/proj/bar", vectorDim: 768, modelTier: "standard" },
    ]);
    const { maybeWarnCrossProjectDim } = await import(
      "../src/lib/utils/stale-hint"
    );
    maybeWarnCrossProjectDim(roots);
    expect(emitted()).toBe("");
  });
});
