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

function writeRegistry(
  entries: Array<{
    name: string;
    root: string;
    chunkerVersion?: number;
    status?: string;
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
