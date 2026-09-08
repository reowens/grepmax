import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  clearReadVerbs,
  getReadVerb,
  readVerbNames,
} from "../src/lib/daemon/read-verbs";
import {
  clampInt,
  handleRowsLocate,
  handleRowsProject,
  handleRowsSkeleton,
  handleRowsSymbols,
  handleRowsTests,
  MAX_LOCATE_ROWS,
  ReadVerbError,
  registerRowsVerbs,
  resolveWireScope,
  runLocate,
  runProject,
  runSkeleton,
  runSymbols,
  type StoreReadDeps,
} from "../src/lib/daemon/rows-handler";
import {
  handleVectorSimilar,
  handleVectorSurprises,
  registerVectorVerbs,
  runSimilar,
} from "../src/lib/daemon/vector-handler";
import type { VectorRecord } from "../src/lib/store/types";
import { VectorDB } from "../src/lib/store/vector-db";

// The registry gate every verb runs first. Two projects: one usable, one
// marked `error` (the daemon ignores those, and so must a read verb).
const PROJECT = "/repo/app";
const ERRORED = "/repo/broken";
vi.mock("../src/lib/utils/project-registry", () => ({
  listProjects: () => [
    { root: "/repo/app", status: "indexed" },
    { root: "/repo/broken", status: "error" },
  ],
}));

const DIM = 8;

function record(over: Partial<VectorRecord> & { id: string }): VectorRecord {
  return {
    hash: "h",
    content: "",
    display_text: "",
    start_line: 0,
    end_line: 0,
    chunk_index: 0,
    is_anchor: false,
    context_prev: "",
    context_next: "",
    chunk_type: "",
    complexity: 0,
    is_exported: false,
    vector: Array(DIM).fill(0),
    colbert: Buffer.alloc(0),
    colbert_scale: 1,
    pooled_colbert_48d: Array(48).fill(0),
    doc_token_ids: [],
    defined_symbols: [],
    referenced_symbols: [],
    type_referenced_symbols: [],
    member_referenced_symbols: [],
    imports: [],
    exports: [],
    role: "IMPLEMENTATION",
    parent_symbol: "",
    file_skeleton: "",
    summary: "",
    path: "",
    ...over,
  } as VectorRecord;
}

let tmp: string;
let db: VectorDB;
let deps: StoreReadDeps;

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gmax-read-verbs-"));
  db = new VectorDB(path.join(tmp, "lancedb"), DIM);
  deps = { vectorDb: db };
  await db.insertBatch([
    record({
      id: "1",
      path: `${PROJECT}/src/auth.ts`,
      content: "export function login() { return session(); }",
      start_line: 10,
      end_line: 20,
      role: "ORCHESTRATION",
      is_exported: true,
      complexity: 7,
      defined_symbols: ["login", "logout"],
      referenced_symbols: ["session"],
      is_anchor: true,
      file_skeleton: "function login(): void",
      vector: [1, 0, 0, 0, 0, 0, 0, 0],
    }),
    record({
      id: "2",
      path: `${PROJECT}/src/session.ts`,
      content: "export function session() { return 1; }",
      start_line: 3,
      end_line: 8,
      defined_symbols: ["session"],
      referenced_symbols: ["login"],
      vector: [0.9, 0.1, 0, 0, 0, 0, 0, 0],
    }),
    record({
      id: "3",
      path: `${PROJECT}/vendor/copy.ts`,
      content: "function login() {}",
      start_line: 1,
      end_line: 2,
      defined_symbols: ["login"],
      vector: [0, 1, 0, 0, 0, 0, 0, 0],
    }),
    record({
      id: "4",
      path: "/repo/other/far.ts",
      content: "function login() {}",
      defined_symbols: ["login"],
      vector: [0, 0, 1, 0, 0, 0, 0, 0],
    }),
  ]);
});

afterAll(async () => {
  await db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("payload validation", () => {
  it("rejects an unregistered or errored project", async () => {
    await expect(
      handleRowsSymbols(deps, { projectRoot: "/nope" }),
    ).resolves.toMatchObject({ ok: false, error: "project not registered" });
    await expect(
      handleRowsSymbols(deps, { projectRoot: ERRORED }),
    ).resolves.toMatchObject({ ok: false, error: "project not registered" });
    await expect(handleRowsSymbols(deps, {})).resolves.toMatchObject({
      ok: false,
      error: "missing projectRoot",
    });
  });

  it("refuses a scope prefix that escapes the project", () => {
    expect(() =>
      resolveWireScope(PROJECT, { pathPrefix: "/repo/other/" }),
    ).toThrow(/outside project root/);
    expect(() =>
      resolveWireScope(PROJECT, {
        pathPrefix: `${PROJECT}/`,
        excludePrefixes: ["../other/"],
      }),
    ).toThrow(/outside project root/);
  });

  it("keeps a trailing slash only where the caller had one", () => {
    const scope = resolveWireScope(PROJECT, {
      pathPrefix: `${PROJECT}/src`,
      inPrefixes: [`${PROJECT}/src/`],
    });
    expect(scope.pathPrefix).toBe(`${PROJECT}/src`);
    expect(scope.inPrefixes).toEqual([`${PROJECT}/src/`]);
  });

  it("clamps integers instead of trusting them", () => {
    expect(clampInt(5, 20, 1, 100)).toBe(5);
    expect(clampInt(-3, 20, 1, 100)).toBe(1);
    expect(clampInt(1e9, 20, 1, 100)).toBe(100);
    expect(clampInt("nope", 20, 1, 100)).toBe(20);
    expect(clampInt(undefined, 20, 1, 100)).toBe(20);
  });

  it("reports a missing store as not-ready rather than throwing", async () => {
    await expect(
      handleRowsSymbols({ vectorDb: null }, { projectRoot: PROJECT }),
    ).resolves.toMatchObject({ ok: false, error: "daemon not ready" });
  });
});

describe("rows.symbols", () => {
  it("aggregates symbols by count and scopes to the prefix", async () => {
    const entries = await runSymbols(deps, {
      projectRoot: PROJECT,
      pathPrefix: PROJECT,
      limit: 20,
    });
    const bySymbol = new Map(entries.map((e) => [e.symbol, e]));
    expect(bySymbol.get("login")?.count).toBe(2); // auth.ts + vendor/copy.ts
    expect(bySymbol.get("logout")?.count).toBe(1);
    // /repo/other/far.ts is outside the prefix and must not be counted.
    expect(bySymbol.get("login")?.count).not.toBe(3);
  });

  it("narrows to a sub-prefix and honours the pattern filter", async () => {
    const scoped = await runSymbols(deps, {
      projectRoot: PROJECT,
      pathPrefix: `${PROJECT}/src`,
      limit: 20,
    });
    expect(scoped.map((e) => e.symbol).sort()).toEqual([
      "login",
      "logout",
      "session",
    ]);

    const filtered = await runSymbols(deps, {
      projectRoot: PROJECT,
      pathPrefix: PROJECT,
      pattern: "log",
      limit: 20,
    });
    expect(filtered.map((e) => e.symbol).sort()).toEqual(["login", "logout"]);
  });

  it("returns entries over the verb, not raw rows", async () => {
    const resp = await handleRowsSymbols(deps, {
      projectRoot: PROJECT,
      pathPrefix: PROJECT,
      limit: 1,
    });
    expect(resp.ok).toBe(true);
    expect(resp.entries).toHaveLength(1);
    expect(resp).not.toHaveProperty("rows");
  });
});

describe("rows.project", () => {
  it("returns the aggregated overview, not the scanned rows", async () => {
    const overview = await runProject(deps, PROJECT);
    expect(overview.chunks).toBe(3);
    expect(overview.files).toBe(3);
    expect(overview.extEntries).toEqual([[".ts", 3]]);
    expect(overview.roleEntries).toEqual([
      ["IMPLEMENTATION", 2],
      ["ORCHESTRATION", 1],
    ]);
    // session is defined in the project and referenced once; `login` is too.
    expect(new Map(overview.topSymbols).get("session")).toBe(1);
    // Exported ORCHESTRATION with complexity >= 5 and a defined symbol.
    expect(overview.entryPoints).toEqual([
      { symbol: "login", path: "src/auth.ts" },
    ]);
    const resp = await handleRowsProject(deps, { projectRoot: PROJECT });
    expect(resp.ok).toBe(true);
    expect(resp).not.toHaveProperty("rows");
  });

  it("reports an empty project as zero chunks", async () => {
    const overview = await runProject(deps, "/repo/app/nothing-here");
    expect(overview.chunks).toBe(0);
  });
});

describe("rows.locate", () => {
  const scope = () => resolveWireScope(PROJECT, { pathPrefix: `${PROJECT}/` });

  it("returns one result array per matcher, in order", async () => {
    const rows = await runLocate(deps, {
      projectRoot: PROJECT,
      scope: scope(),
      select: ["path", "start_line", "end_line"],
      matches: [
        { kind: "definedSymbol", symbol: "logout" },
        { kind: "definedSymbol", symbol: "session" },
        { kind: "definedSymbol", symbol: "nothing" },
      ],
      limit: 10,
    });
    expect(rows).toHaveLength(3);
    expect(rows[0][0].path).toBe(`${PROJECT}/src/auth.ts`);
    expect(rows[0][0].start_line).toBe(10);
    expect(rows[1][0].path).toBe(`${PROJECT}/src/session.ts`);
    expect(rows[2]).toEqual([]);
  });

  it("normalizes Arrow list columns into plain arrays", async () => {
    const [rows] = await runLocate(deps, {
      projectRoot: PROJECT,
      scope: scope(),
      select: ["path", "defined_symbols", "is_exported"],
      matches: [{ kind: "definedSymbol", symbol: "logout" }],
      limit: 10,
    });
    expect(Array.isArray(rows[0].defined_symbols)).toBe(true);
    expect(rows[0].defined_symbols).toEqual(["login", "logout"]);
    expect(rows[0].is_exported).toBe(true);
    expect(JSON.parse(JSON.stringify(rows[0])).defined_symbols).toEqual([
      "login",
      "logout",
    ]);
  });

  it("applies the scope by default and drops it when asked", async () => {
    const narrow = resolveWireScope(PROJECT, {
      pathPrefix: `${PROJECT}/`,
      excludePrefixes: [`${PROJECT}/vendor/`],
    });
    const [scoped] = await runLocate(deps, {
      projectRoot: PROJECT,
      scope: narrow,
      select: ["path"],
      matches: [{ kind: "definedSymbol", symbol: "login" }],
      limit: 10,
    });
    expect(scoped.map((r) => r.path)).toEqual([`${PROJECT}/src/auth.ts`]);

    const [unscoped] = await runLocate(deps, {
      projectRoot: PROJECT,
      scope: narrow,
      select: ["path"],
      matches: [{ kind: "path", path: `${PROJECT}/vendor/copy.ts` }],
      scoped: false,
    });
    expect(unscoped.map((r) => r.path)).toEqual([`${PROJECT}/vendor/copy.ts`]);
  });

  it("supports referencedSymbol and contentLike matchers", async () => {
    const rows = await runLocate(deps, {
      projectRoot: PROJECT,
      scope: scope(),
      select: ["path"],
      matches: [
        { kind: "referencedSymbol", symbol: "session" },
        { kind: "contentLike", value: "return session()" },
      ],
    });
    expect(rows[0].map((r) => r.path)).toEqual([`${PROJECT}/src/auth.ts`]);
    expect(rows[1].map((r) => r.path)).toEqual([`${PROJECT}/src/auth.ts`]);
  });

  it("rejects columns outside the allowlist and unknown matchers", async () => {
    await expect(
      handleRowsLocate(deps, {
        projectRoot: PROJECT,
        select: ["content", "vector"],
        matches: [{ kind: "definedSymbol", symbol: "login" }],
      }),
    ).resolves.toMatchObject({ ok: false, error: "invalid select" });

    await expect(
      handleRowsLocate(deps, {
        projectRoot: PROJECT,
        select: ["path"],
        matches: [{ kind: "sqlInjection", where: "1=1" }],
      }),
    ).resolves.toMatchObject({ ok: false, error: "invalid match" });

    await expect(
      handleRowsLocate(deps, {
        projectRoot: PROJECT,
        select: ["path"],
        matches: [],
      }),
    ).resolves.toMatchObject({ ok: false, error: "missing matches" });
  });

  it("clamps the per-matcher limit and keeps the unlimited cap bounded", async () => {
    const resp = await handleRowsLocate(deps, {
      projectRoot: PROJECT,
      select: ["path"],
      matches: [{ kind: "definedSymbol", symbol: "login" }],
      limit: 10_000_000,
    });
    expect(resp.ok).toBe(true);
    expect(MAX_LOCATE_ROWS).toBe(5000);
  });

  it("contains a path matcher inside the project", async () => {
    await expect(
      handleRowsLocate(deps, {
        projectRoot: PROJECT,
        select: ["path"],
        matches: [{ kind: "path", path: "/repo/other/far.ts" }],
        scoped: false,
      }),
    ).rejects.toThrow(/outside project root/);
  });

  it("escapes quotes in a symbol instead of splicing them into SQL", async () => {
    const [rows] = await runLocate(deps, {
      projectRoot: PROJECT,
      scope: scope(),
      select: ["path"],
      matches: [{ kind: "definedSymbol", symbol: "x') OR ('1'='1" }],
      limit: 10,
    });
    expect(rows).toEqual([]);
  });
});

describe("rows.skeleton", () => {
  it("returns the stored skeleton for a path", async () => {
    const result = await runSkeleton(deps, {
      projectRoot: PROJECT,
      path: `${PROJECT}/src/auth.ts`,
    });
    expect(result).toEqual({
      path: `${PROJECT}/src/auth.ts`,
      skeleton: "function login(): void",
    });
  });

  it("returns a null skeleton for a file with none stored", async () => {
    const result = await runSkeleton(deps, {
      projectRoot: PROJECT,
      path: `${PROJECT}/src/session.ts`,
    });
    expect(result.skeleton).toBeNull();
  });

  it("requires a path or a symbol", async () => {
    await expect(
      handleRowsSkeleton(deps, { projectRoot: PROJECT }),
    ).resolves.toMatchObject({ ok: false, error: "missing path or symbol" });
  });

  it("contains the requested path inside the project", async () => {
    await expect(
      handleRowsSkeleton(deps, {
        projectRoot: PROJECT,
        path: "/repo/other/far.ts",
      }),
    ).rejects.toThrow(/outside project root/);
  });

  it("resolves a symbol to null when the FTS lookup finds nothing", async () => {
    const result = await runSkeleton(deps, {
      projectRoot: PROJECT,
      symbol: "definitelyNotIndexedAnywhere",
    });
    expect(result.path).toBeNull();
    expect(result.skeleton).toBeNull();
  });
});

describe("vector.similar", () => {
  it("ranks neighbours of a file and excludes the source chunk", async () => {
    const result = await runSimilar(deps, {
      projectRoot: PROJECT,
      absPath: `${PROJECT}/src/auth.ts`,
      scope: resolveWireScope(PROJECT, { pathPrefix: `${PROJECT}/` }),
      limit: 5,
      threshold: 0,
    });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.results.map((r) => r.path)).not.toContain(
      `${PROJECT}/src/auth.ts`,
    );
    // Nearest by L2 to [1,0,...] is session.ts at [0.9,0.1,...].
    expect(result.results[0].path).toBe(`${PROJECT}/src/session.ts`);
    expect(Array.isArray(result.results[0].defined_symbols)).toBe(true);
    // `content` is queried but never rendered, so it stays off the wire.
    expect(result.results[0]).not.toHaveProperty("content");
  });

  it("resolves a symbol target and reports a miss as not-found", async () => {
    const hit = await runSimilar(deps, {
      projectRoot: PROJECT,
      symbol: "logout",
      scope: resolveWireScope(PROJECT, { pathPrefix: `${PROJECT}/` }),
      limit: 5,
      threshold: 0,
    });
    expect(hit.status).toBe("ok");

    const miss = await runSimilar(deps, {
      projectRoot: PROJECT,
      symbol: "noSuchSymbol",
      scope: resolveWireScope(PROJECT, { pathPrefix: `${PROJECT}/` }),
      limit: 5,
      threshold: 0,
    });
    expect(miss.status).toBe("not-found");
  });

  it("requires a target and validates it against the project", async () => {
    await expect(
      handleVectorSimilar(deps, { projectRoot: PROJECT }),
    ).resolves.toMatchObject({ ok: false, error: "missing target" });
    await expect(
      handleVectorSimilar(deps, {
        projectRoot: PROJECT,
        absPath: "/repo/other/far.ts",
      }),
    ).rejects.toThrow(/outside project root/);
  });

  it("drops everything below the similarity threshold", async () => {
    const result = await runSimilar(deps, {
      projectRoot: PROJECT,
      absPath: `${PROJECT}/src/auth.ts`,
      scope: resolveWireScope(PROJECT, { pathPrefix: `${PROJECT}/` }),
      limit: 5,
      threshold: 0.99,
    });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.results).toEqual([]);
  });
});

describe("vector.surprises", () => {
  it("returns the summary and findings but never the raw pairs", async () => {
    const resp = await handleVectorSurprises(deps, {
      projectRoot: PROJECT,
      options: { sample: 10, neighbors: 5, maxRows: 100 },
      top: 5,
    });
    expect(resp.ok).toBe(true);
    expect(resp).not.toHaveProperty("pairs");
    const summary = resp.summary as { projectRoot: string; rows: number };
    expect(summary.projectRoot).toBe(PROJECT);
    expect(summary.rows).toBe(3);
    expect(Array.isArray(resp.findings)).toBe(true);
    expect((resp.findings as unknown[]).length).toBeLessThanOrEqual(5);
  });

  it("validates --in/--exclude prefixes against the project", async () => {
    await expect(
      handleVectorSurprises(deps, {
        projectRoot: PROJECT,
        options: { in: ["/repo/other/"] },
        top: 5,
      }),
    ).rejects.toThrow(/outside project root/);
  });
});

describe("rows.tests", () => {
  it("returns the tests footer hits for a symbol", async () => {
    const resp = await handleRowsTests(deps, {
      projectRoot: PROJECT,
      symbol: "session",
      scope: { pathPrefix: `${PROJECT}/` },
    });
    expect(resp.ok).toBe(true);
    // No test files in the fixture, so the footer is empty — the point is that
    // the verb ran findTests daemon-side and answered.
    expect(resp.tests).toEqual([]);
  });

  it("requires a symbol", async () => {
    await expect(
      handleRowsTests(deps, { projectRoot: PROJECT }),
    ).resolves.toMatchObject({ ok: false, error: "missing symbol" });
  });
});

describe("verb registration", () => {
  it("registers every rows and vector verb, and pulls deps from the daemon", async () => {
    clearReadVerbs();
    try {
      registerRowsVerbs();
      registerVectorVerbs();
      expect(readVerbNames()).toEqual([
        "rows.locate",
        "rows.project",
        "rows.skeleton",
        "rows.symbols",
        "rows.tests",
        "vector.similar",
        "vector.surprises",
      ]);

      // Registration is only useful if the handler reaches the daemon's store
      // through the one shared accessor.
      const storeReadDeps = vi.fn(() => deps);
      const handler = getReadVerb("rows.symbols");
      const resp = await handler?.(
        { cmd: "rows.symbols", projectRoot: PROJECT, limit: 3 },
        {
          daemon: { storeReadDeps } as never,
          conn: {} as never,
          signal: new AbortController().signal,
        },
      );
      expect(storeReadDeps).toHaveBeenCalledOnce();
      expect(resp?.ok).toBe(true);
    } finally {
      clearReadVerbs();
    }
  });
});

describe("ReadVerbError", () => {
  it("carries an actionable hint through to the response", async () => {
    const resp = await handleRowsProject(deps, { projectRoot: "/nope" });
    expect(resp.hint).toBe("run: gmax add /nope");
    expect(new ReadVerbError("x").hint).toBeUndefined();
  });
});
