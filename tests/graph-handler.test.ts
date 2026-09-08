import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  computeAudit,
  decodeSymbolFamilies,
  encodeScope,
  encodeSymbolFamilies,
  inPrefixesOf,
  runGraphAudit,
  runGraphDead,
  runGraphDependents,
  runGraphNeighbors,
  runGraphPaths,
  runGraphPeek,
  runGraphResolve,
  runGraphRisk,
  runGraphSubgraph,
  runGraphTests,
  runGraphTrace,
  scopeFromPrefixes,
} from "../src/lib/daemon/graph-handler";
import type { VectorRecord } from "../src/lib/store/types";
import { VectorDB } from "../src/lib/store/vector-db";
import { resolveScope } from "../src/lib/utils/scope-filter";

/**
 * The graph verbs against a real LanceDB on a temp dir — the same code the
 * daemon runs and the same code a daemonless CLI runs, so this is the contract
 * both paths share. A tiny hand-built fixture: one service defining `handleAuth`
 * and `helper`, one caller, one test file, and one unreferenced private symbol.
 */

const PROJECT = "/proj";
const DIM = 4;

let dir: string;
let db: VectorDB;

function record(
  id: string,
  filePath: string,
  opts: {
    startLine?: number;
    endLine?: number;
    exported?: boolean;
    defines?: string[];
    refs?: string[];
    typeRefs?: string[];
    role?: string;
    content?: string;
  } = {},
): VectorRecord {
  return {
    id,
    path: filePath,
    hash: `hash-${id}`,
    content: opts.content ?? `content of ${id}`,
    start_line: opts.startLine ?? 0,
    end_line: opts.endLine ?? (opts.startLine ?? 0) + 5,
    is_exported: opts.exported ?? false,
    defined_symbols: opts.defines ?? [],
    referenced_symbols: opts.refs ?? [],
    type_referenced_symbols: opts.typeRefs ?? [],
    member_referenced_symbols: [],
    role: opts.role ?? "function",
    vector: [1, 0, 0, 0],
    colbert: [],
    colbert_scale: 1,
    pooled_colbert_48d: new Array(48).fill(0),
    doc_token_ids: [],
  };
}

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "gmax-graph-handler-"));
  db = new VectorDB(path.join(dir, "lancedb"), DIM);
  await db.insertBatch([
    record("auth", `${PROJECT}/src/auth.ts`, {
      defines: ["handleAuth", "helper"],
      exported: true,
      startLine: 10,
      endLine: 40,
    }),
    record("private", `${PROJECT}/src/internal.ts`, {
      defines: ["privateOnly"],
      exported: false,
      startLine: 3,
    }),
    record("caller", `${PROJECT}/src/server.ts`, {
      defines: ["startServer"],
      refs: ["handleAuth"],
      exported: true,
      startLine: 7,
    }),
    record("spec", `${PROJECT}/tests/auth.test.ts`, {
      defines: ["testLogin"],
      refs: ["handleAuth"],
      startLine: 20,
    }),
    record("vendored", `${PROJECT}/vendor/copy.ts`, {
      defines: ["vendorThing"],
      refs: ["handleAuth"],
      startLine: 1,
    }),
  ]);
});

afterAll(async () => {
  await db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const wholeProject = () => resolveScope({ projectRoot: PROJECT });

describe("scope wire round trip", () => {
  it("collapses a single --in into pathPrefix and restores it", () => {
    const scope = {
      pathPrefix: `${PROJECT}/src/`,
      inPrefixes: [],
      excludePrefixes: [`${PROJECT}/vendor/`],
    };
    const wire = encodeScope(PROJECT, scope);
    expect(wire.inPrefixes).toEqual([`${PROJECT}/src/`]);
    expect(
      scopeFromPrefixes(PROJECT, wire.inPrefixes!, wire.excludePrefixes!),
    ).toEqual(scope);
  });

  it("keeps two --in prefixes uncollapsed, with pathPrefix at the root", () => {
    const scope = {
      pathPrefix: `${PROJECT}/`,
      inPrefixes: [`${PROJECT}/src/`, `${PROJECT}/tests/`],
      excludePrefixes: [],
    };
    expect(inPrefixesOf(PROJECT, scope)).toEqual(scope.inPrefixes);
    expect(scopeFromPrefixes(PROJECT, scope.inPrefixes, [])).toEqual(scope);
  });

  it("sends no --in prefixes for an unscoped project", () => {
    expect(encodeScope(PROJECT, wholeProject()).inPrefixes).toEqual([]);
  });

  it("round trips the symbol family map JSON has no type for", () => {
    const families = new Map([
      ["handleAuth", "ts"],
      ["mystery", null],
    ]);
    const wire = encodeSymbolFamilies(families);
    expect(wire).toEqual([
      ["handleAuth", "ts"],
      ["mystery", null],
    ]);
    expect(decodeSymbolFamilies(wire)).toEqual(families);
    expect(decodeSymbolFamilies(null)).toBeUndefined();
  });
});

describe("graph.resolve", () => {
  it("passes a bare symbol through unresolved", async () => {
    const result = await runGraphResolve(db, {
      target: "handleAuth",
      projectRoot: PROJECT,
    });
    expect(result).toEqual({
      symbols: ["handleAuth"],
      resolvedAsFile: false,
      symbolFamilies: null,
    });
  });

  it("expands a file target to the symbols it defines", async () => {
    const result = await runGraphResolve(db, {
      target: "src/auth.ts",
      projectRoot: PROJECT,
    });
    expect(result.resolvedAsFile).toBe(true);
    expect([...result.symbols].sort()).toEqual(["handleAuth", "helper"]);
    // Families ride the wire as pairs, one per symbol.
    expect(result.symbolFamilies?.length).toBe(2);
  });
});

describe("graph.tests", () => {
  it("finds the test file that calls the symbol", async () => {
    const hits = await runGraphTests(db, {
      symbols: ["handleAuth"],
      queryRoot: PROJECT,
      depth: 1,
      excludePrefixes: [],
    });
    expect(hits.map((h) => h.file)).toContain(`${PROJECT}/tests/auth.test.ts`);
  });

  it("honours excludePrefixes", async () => {
    const hits = await runGraphTests(db, {
      symbols: ["handleAuth"],
      queryRoot: PROJECT,
      depth: 1,
      excludePrefixes: [`${PROJECT}/tests/`],
    });
    expect(hits.map((h) => h.file)).not.toContain(
      `${PROJECT}/tests/auth.test.ts`,
    );
  });

  it("clamps depth rather than trusting the payload", async () => {
    // 99 hops would be a traversal bomb; the clamp lives in the shared run
    // function so the daemon and the in-process path agree.
    await expect(
      runGraphTests(db, {
        symbols: ["handleAuth"],
        queryRoot: PROJECT,
        depth: 99,
        excludePrefixes: [],
      }),
    ).resolves.toBeInstanceOf(Array);
  });
});

describe("graph.dependents", () => {
  it("lists referencing files, and detailed mode keeps the symbols", async () => {
    const flat = await runGraphDependents(db, {
      symbols: ["handleAuth"],
      queryRoot: PROJECT,
      detailed: false,
      excludePrefixes: [],
    });
    expect(flat.map((d) => d.file)).toContain(`${PROJECT}/src/server.ts`);
    expect(flat[0]).not.toHaveProperty("symbols");

    const detailed = await runGraphDependents(db, {
      symbols: ["handleAuth"],
      queryRoot: PROJECT,
      detailed: true,
      excludePrefixes: [],
    });
    expect(detailed[0]).toHaveProperty("symbols");
  });

  it("drops the target's own file when excludePaths names it", async () => {
    const hits = await runGraphDependents(db, {
      symbols: ["handleAuth"],
      queryRoot: PROJECT,
      detailed: false,
      excludePaths: [`${PROJECT}/src/server.ts`],
      excludePrefixes: [],
    });
    expect(hits.map((d) => d.file)).not.toContain(`${PROJECT}/src/server.ts`);
  });
});

describe("graph.trace", () => {
  it("returns the center, its callers, and importers", async () => {
    const graph = await runGraphTrace(db, {
      symbol: "handleAuth",
      hops: 1,
      scope: wholeProject(),
    });
    expect(graph.center?.symbol).toBe("handleAuth");
    expect(graph.center?.file).toBe(`${PROJECT}/src/auth.ts`);
    expect(graph.callerTree.map((t) => t.node.file)).toContain(
      `${PROJECT}/src/server.ts`,
    );
  });

  it("reports a missing symbol as a null center, not an error", async () => {
    const graph = await runGraphTrace(db, {
      symbol: "noSuchSymbol",
      hops: 1,
      scope: wholeProject(),
    });
    expect(graph.center).toBeNull();
  });

  it("applies the scope so an excluded caller disappears", async () => {
    const graph = await runGraphTrace(db, {
      symbol: "handleAuth",
      hops: 1,
      scope: resolveScope({ projectRoot: PROJECT, exclude: "src" }),
    });
    expect(graph.callerTree.map((t) => t.node.file)).not.toContain(
      `${PROJECT}/src/server.ts`,
    );
  });
});

describe("graph.peek", () => {
  it("returns the defining chunks, graph, and metadata in one call", async () => {
    const result = await runGraphPeek(db, {
      symbol: "handleAuth",
      depth: 1,
      scope: wholeProject(),
      includeTests: false,
    });
    expect(result.defChunks).toEqual([
      { path: `${PROJECT}/src/auth.ts`, startLine: 10 },
    ]);
    expect(result.graph.center?.symbol).toBe("handleAuth");
    expect(result.meta).toEqual({
      isExported: true,
      startLine: 10,
      endLine: 40,
    });
    // depth 1 renders graph.callers, so no tree is shipped.
    expect(result.callerTree).toBeNull();
    expect(result.footerTests).toBeNull();
  });

  it("ships the multi-hop caller tree only when depth > 1", async () => {
    const result = await runGraphPeek(db, {
      symbol: "handleAuth",
      depth: 2,
      scope: wholeProject(),
      includeTests: false,
    });
    expect(Array.isArray(result.callerTree)).toBe(true);
  });

  it("returns null metadata for an unknown symbol", async () => {
    const result = await runGraphPeek(db, {
      symbol: "noSuchSymbol",
      depth: 1,
      scope: wholeProject(),
      includeTests: false,
    });
    expect(result.defChunks).toEqual([]);
    expect(result.meta).toBeNull();
    expect(result.graph.center).toBeNull();
  });
});

describe("graph.dead", () => {
  it("counts inbound callers instead of shipping them", async () => {
    const facts = await runGraphDead(db, {
      symbol: "handleAuth",
      scope: wholeProject(),
    });
    expect(facts.found).toBe(true);
    expect(facts.defPath).toBe(`${PROJECT}/src/auth.ts`);
    expect(facts.defLine).toBe(10);
    expect(facts.isExported).toBe(true);
    expect(facts.callerCount).toBeGreaterThan(0);
    // Only the top three locations cross the wire, however many callers exist.
    expect(facts.topCallers.length).toBeLessThanOrEqual(3);
  });

  it("reports a non-exported symbol with no callers", async () => {
    const facts = await runGraphDead(db, {
      symbol: "privateOnly",
      scope: wholeProject(),
    });
    expect(facts).toMatchObject({
      found: true,
      isExported: false,
      callerCount: 0,
      topCallers: [],
    });
  });

  it("says not-found rather than throwing for an unknown symbol", async () => {
    const facts = await runGraphDead(db, {
      symbol: "noSuchSymbol",
      scope: wholeProject(),
    });
    expect(facts.found).toBe(false);
  });
});

describe("graph.audit", () => {
  it("returns the finished report, never the rows it read", async () => {
    const report = await runGraphAudit(db, {
      projectRoot: PROJECT,
      scope: wholeProject(),
      top: 10,
    });
    expect(report).not.toBeNull();
    expect(report!.scannedChunks).toBe(5);
    expect(report!.scannedFiles).toBe(5);
    expect(report!.godNodes.map((g) => g.symbol)).toContain("handleAuth");
    // Paths are already project-relative in the report.
    expect(report!.godNodes[0].file).toBe("src/auth.ts");
    expect(report!.deadCandidates.map((d) => d.symbol)).toContain(
      "privateOnly",
    );
  });

  it("returns null for a scope with no rows so the caller prints its own line", async () => {
    const report = await runGraphAudit(db, {
      projectRoot: PROJECT,
      scope: resolveScope({ projectRoot: PROJECT, in: "nothing-here" }),
      top: 10,
    });
    expect(report).toBeNull();
  });

  it("clamps top", async () => {
    const report = await runGraphAudit(db, {
      projectRoot: PROJECT,
      scope: wholeProject(),
      top: 10_000_000,
    });
    expect(report!.godNodes.length).toBeLessThanOrEqual(1000);
  });
});

describe("computeAudit", () => {
  it("stays a pure function over rows (moved from audit.ts unchanged)", () => {
    const report = computeAudit(
      [
        {
          path: "/proj/a.ts",
          start_line: 0,
          is_exported: true,
          defined_symbols: ["alpha"],
          referenced_symbols: [],
        },
        {
          path: "/proj/b.ts",
          start_line: 0,
          is_exported: false,
          defined_symbols: ["beta"],
          referenced_symbols: ["alpha"],
        },
      ],
      "/proj/",
      10,
    );
    expect(report.godNodes).toEqual([
      {
        symbol: "alpha",
        file: "a.ts",
        line: 0,
        inboundFiles: 1,
        totalRefs: 1,
        defFiles: 1,
      },
    ]);
    expect(report.deadCandidates.map((d) => d.symbol)).toEqual(["beta"]);
  });
});

/**
 * The four verbs WP-D added for the MCP tools with no CLI twin. Same fixture,
 * same contract: the daemon and a daemonless client both call these functions,
 * so what they return here is what both paths render.
 */
describe("runGraphNeighbors", () => {
  it("walks caller edges and resolves each hit to its definition", async () => {
    const hits = await runGraphNeighbors(db, {
      symbol: "handleAuth",
      direction: "callers",
      maxHops: 2,
      scope: wholeProject(),
    });
    const byName = new Map(hits.map((h) => [h.symbol, h]));
    expect([...byName.keys()]).toContain("startServer");
    expect(byName.get("startServer")).toMatchObject({
      hops: 1,
      file: `${PROJECT}/src/server.ts`,
      line: 7,
    });
  });

  it("walks callee edges in the other direction", async () => {
    const hits = await runGraphNeighbors(db, {
      symbol: "startServer",
      direction: "callees",
      maxHops: 2,
      scope: wholeProject(),
    });
    expect(hits.map((h) => h.symbol)).toContain("handleAuth");
  });

  it("honours the scope's exclude prefixes", async () => {
    const scoped = resolveScope({ projectRoot: PROJECT, exclude: ["vendor"] });
    const hits = await runGraphNeighbors(db, {
      symbol: "handleAuth",
      direction: "callers",
      maxHops: 2,
      scope: scoped,
    });
    expect(hits.map((h) => h.symbol)).not.toContain("vendorThing");
  });

  it("clamps hops into 1..5 rather than trusting the payload", async () => {
    // 0 and 999 both have to become a bounded walk; the assertion is that the
    // call returns at all and stays inside the fixture.
    for (const maxHops of [0, 999, Number.NaN]) {
      const hits = await runGraphNeighbors(db, {
        symbol: "handleAuth",
        direction: "callers",
        maxHops,
        scope: wholeProject(),
      });
      expect(Array.isArray(hits)).toBe(true);
    }
  });
});

describe("runGraphPaths", () => {
  it("returns the symbol sequence from start to target", async () => {
    const path = await runGraphPaths(db, {
      from: "startServer",
      to: "handleAuth",
      direction: "callees",
      maxHops: 6,
      scope: wholeProject(),
    });
    expect(path).toEqual(["startServer", "handleAuth"]);
  });

  it("returns null when the target is unreachable", async () => {
    const path = await runGraphPaths(db, {
      from: "handleAuth",
      to: "privateOnly",
      direction: "callees",
      maxHops: 3,
      scope: wholeProject(),
    });
    expect(path).toBeNull();
  });
});

describe("runGraphSubgraph", () => {
  it("returns the file set's symbols, internal edges, and external deps", async () => {
    const sg = await runGraphSubgraph(db, {
      files: [`${PROJECT}/src/auth.ts`, `${PROJECT}/src/server.ts`],
      scope: wholeProject(),
    });
    expect(sg.files).toEqual([
      `${PROJECT}/src/auth.ts`,
      `${PROJECT}/src/server.ts`,
    ]);
    expect(sg.symbols).toEqual(["handleAuth", "helper", "startServer"]);
    // startServer references handleAuth, and both are defined in the set.
    expect(sg.internalEdges).toEqual([
      { from: "startServer", to: "handleAuth" },
    ]);
  });

  it("returns an empty subgraph for an empty file list", async () => {
    const sg = await runGraphSubgraph(db, {
      files: [],
      scope: wholeProject(),
    });
    expect(sg).toEqual({
      files: [],
      symbols: [],
      internalEdges: [],
      externalDeps: [],
    });
  });
});

describe("runGraphRisk", () => {
  it("returns caller count, definition, and test presence per symbol", async () => {
    const facts = await runGraphRisk(db, {
      symbols: ["handleAuth", "privateOnly"],
      queryRoot: PROJECT,
      scope: wholeProject(),
    });
    expect(facts.map((f) => f.symbol)).toEqual(["handleAuth", "privateOnly"]);

    const auth = facts[0];
    expect(auth.file).toBe(`${PROJECT}/src/auth.ts`);
    expect(auth.line).toBe(10);
    expect(auth.callerCount).toBeGreaterThan(0);
    expect(auth.hasTests).toBe(true);

    // No caller and no test, and it still reports rather than throwing.
    expect(facts[1]).toMatchObject({
      symbol: "privateOnly",
      callerCount: 0,
      hasTests: false,
    });
  });

  it("reports an unindexed symbol as an empty location, not an error", async () => {
    const [fact] = await runGraphRisk(db, {
      symbols: ["neverDefinedAnywhere"],
      queryRoot: PROJECT,
      scope: wholeProject(),
    });
    expect(fact).toMatchObject({ file: "", line: 0, callerCount: 0 });
  });
});
