import { afterEach, expect, it, vi } from "vitest";
import { artifactPreference } from "../src/lib/search/artifact-preference";
import { Searcher } from "../src/lib/search/searcher";
import type { VectorRecord } from "../src/lib/store/types";
import type { VectorDB } from "../src/lib/store/vector-db";

afterEach(() => vi.unstubAllEnvs());

it.each([
  [
    "Which regression test verifies stale entries disappear?",
    true,
    false,
    false,
  ],
  ["Find unit tests for the parser", true, false, false],
  ["What test covers the empty response?", true, false, false],
  ["Where is the test file for cache expiry?", true, false, false],
  ["Find the test case for empty responses", true, false, false],
  ["Show the test suite for routing", true, false, false],
  ["Where are the test files for cache expiry?", true, false, false],
  ["Find the test cases for empty responses", true, false, false],
  ["Show the test suites for routing", true, false, false],
  ["Where does the README explain setup?", false, true, false],
  ["Which manual describes setup?", false, true, false],
  ["Where is the setup guide?", false, true, false],
  ["Which documentation guide describes the tests?", true, true, false],
  ["How does the client test the connection?", false, false, false],
  ["Where is testConnection defined?", false, false, false],
  ["How is manual memory management implemented?", false, false, false],
  ["How does manual mode affect retries?", false, false, false],
  ["How do guide rails constrain the carriage?", false, false, false],
  [
    "How does the PDF document renderer handle a manualFeed flag?",
    false,
    false,
    false,
  ],
  ["Where are the archived plans for door pricing?", false, false, true],
  ["Which superseded spec covered wallet passes?", false, false, true],
  ["What did the previous design say about billing?", false, false, true],
  ["Show the history of the pricing ruling", false, false, true],
  ["Show the old docs for setup", false, true, true],
  ["How is conversation history stored?", false, false, false],
  ["Where do we archive old messages?", false, false, false],
])(
  "recognizes explicit artifact requests in %s",
  (query, tests, documentation, history) => {
    expect(artifactPreference(query as string)).toEqual({
      tests,
      documentation,
      history,
    });
  },
);

function row(id: string, file: string): VectorRecord {
  return {
    id,
    path: `/project/${file}`,
    hash: id,
    content:
      "synthetic handler body with enough content to avoid import-only heuristics",
    start_line: 0,
    end_line: 5,
    vector: [],
    colbert: [],
    colbert_scale: 1,
    chunk_type: "chunk",
    role: "OTHER",
    pooled_colbert_48d: [],
  };
}
function searcher(records: VectorRecord[]) {
  records = records.map((record, i) => ({ ...record, _rowid: BigInt(i) }));
  const retrieval = () => {
    let count = records.length;
    const chain = {
      withRowId: () => chain,
      select: () => chain,
      where: () => chain,
      limit: (n: number) => {
        count = n;
        return chain;
      },
      toArray: async () => records.slice(0, count),
    };
    return chain;
  };
  const table = {
    version: async () => 1,
    checkout: async () => {},
    close: () => {},
    takeRowIds: (ids: readonly (bigint | number)[]) => {
      const chain = {
        select: () => chain,
        toArray: async () => ids.map((id) => records[Number(id)]),
      };
      return chain;
    },
    vectorSearch: retrieval,
    query: retrieval,
    search: () => {
      const chain = {
        withRowId: () => chain,
        select: () => chain,
        where: () => chain,
        limit: () => chain,
        toArray: async () => [],
      };
      return chain;
    },
  };
  const rerank = vi.fn();
  return {
    instance: new Searcher(
      {
        ensureTable: async () => table,
        adoptFTSIndex: async () => {},
      } as unknown as VectorDB,
      {
        encodeQuery: async () => ({ dense: [1], colbert: [], colbertDim: 48 }),
        rerank,
      } as any,
    ),
    rerank,
  };
}
it("preserves the code prior for general queries but waives test penalty for a requested regression test", async () => {
  vi.stubEnv("GMAX_CONCENTRATION_THRESHOLD", "2");
  const { instance, rerank } = searcher([
    row("test", "tests/cache.test.ts"),
    row("code", "src/cache.ts"),
  ]);
  expect(
    (await instance.search("reclaim expired entries", 2)).data[0].metadata
      ?.hash,
  ).toBe("code");
  const explicit = await instance.search(
    "Which regression test covers expiry?",
    2,
    { diagnostics: true },
  );
  expect(explicit.data[0].metadata?.hash).toBe("test");
  expect(explicit.diagnostics?.settings.testArtifactRequested).toBe(true);
  expect(rerank).not.toHaveBeenCalled();
});
it("waives the docs prior only for explicit documentation requests and keeps per-file caps", async () => {
  vi.stubEnv("GMAX_CONCENTRATION_THRESHOLD", "2");
  const docs = [
    row("doc", "docs/setup.md"),
    { ...row("otherdoc", "docs/setup.md"), start_line: 20, end_line: 25 },
    row("code", "src/setup.ts"),
  ];
  const { instance } = searcher(docs);
  expect(
    (await instance.search("configure setup", 3)).data[0].metadata?.hash,
  ).toBe("code");
  const uncapped = await instance.search(
    "Which README guide explains setup?",
    3,
    { maxPerFile: 3 },
  );
  expect(
    uncapped.data.filter((r) => r.metadata?.path === "/project/docs/setup.md"),
  ).toHaveLength(2);
  const result = await instance.search(
    "Which README guide explains setup?",
    3,
    { diagnostics: true, maxPerFile: 1 },
  );
  expect(result.data[0].metadata?.hash).toBe("doc");
  expect(
    result.data.filter((r) => r.metadata?.path === "/project/docs/setup.md"),
  ).toHaveLength(1);
  expect(result.diagnostics?.settings.documentationRequested).toBe(true);
});
it("does not force an artifact match above a stronger retriever consensus", async () => {
  vi.stubEnv("GMAX_CONCENTRATION_THRESHOLD", "2");
  const { instance } = searcher([
    row("code", "src/relevant.ts"),
    row("test", "tests/unrelated.test.ts"),
  ]);
  expect(
    (await instance.search("Which regression test checks retries?", 2)).data[0]
      .metadata?.hash,
  ).toBe("code");
});

function docRow(id: string, file: string): VectorRecord {
  return { ...row(id, file), role: "DOCS" };
}
const ARCHIVED = "docs/modules/comms/archive/comms-data-model.md";
const CURRENT = "docs/modules/comms/comms.md";
const MODEL_QUERY = "comms data model for conversations and channels";

function byHash(result: Awaited<ReturnType<Searcher["search"]>>, id: string) {
  const hit = result.data.find((r) => r.metadata?.hash === id);
  if (!hit) throw new Error(`missing ${id}`);
  return hit;
}

it("demotes an archived doc by the docs factor and the archive factor, once each", async () => {
  vi.stubEnv("GMAX_CONCENTRATION_THRESHOLD", "2");
  const { instance } = searcher([docRow("old", ARCHIVED)]);
  const result = await instance.search(MODEL_QUERY, 1, {
    explain: true,
    projectRoot: "/project",
  });
  const hit = byHash(result, "old");
  expect(hit.scoreBreakdown?.boost).toBeCloseTo(0.3);
  expect(hit.scoreBreakdown?.archive).toBe(0.5);
  expect(hit.docStatus).toBe("archived");
});

it("leaves code in an archive folder at its code boost and unlabelled", async () => {
  vi.stubEnv("GMAX_CONCENTRATION_THRESHOLD", "2");
  const code = (id: string, file: string): VectorRecord => ({
    ...row(id, file),
    chunk_type: "function",
    role: "DEFINITION",
  });
  const { instance } = searcher([
    code("archived-seed", "packages/db/src/archive/seed-pilot.ts"),
    code("seed", "packages/db/src/seed-pilot.ts"),
  ]);
  const result = await instance.search("seed data for a pilot property", 2, {
    explain: true,
    projectRoot: "/project",
  });
  const archived = byHash(result, "archived-seed");
  expect(archived.scoreBreakdown?.archive).toBe(1);
  expect(archived.scoreBreakdown?.boost).toBeCloseTo(
    byHash(result, "seed").scoreBreakdown?.boost as number,
  );
  expect(archived.scoreBreakdown?.boost).toBeGreaterThan(1);
  expect(archived.docStatus).toBeNull();
});

it.each([
  ["a history query", "archived comms data model for conversations", {}],
  ["the history flag", MODEL_QUERY, { history: true }],
])(
  "skips the archive factor for %s and keeps the label and docs factor",
  async (_name, query, options) => {
    vi.stubEnv("GMAX_CONCENTRATION_THRESHOLD", "2");
    const { instance } = searcher([docRow("old", ARCHIVED)]);
    const result = await instance.search(query as string, 1, {
      ...(options as { history?: boolean }),
      explain: true,
      diagnostics: true,
      projectRoot: "/project",
    });
    const hit = byHash(result, "old");
    expect(hit.scoreBreakdown?.archive).toBe(1);
    expect(hit.scoreBreakdown?.boost).toBeCloseTo(0.6);
    expect(hit.docStatus).toBe("archived");
    expect(result.diagnostics?.settings.historyRequested).toBe(true);
  },
);

it("keeps the archive factor alone under a documentation request", async () => {
  vi.stubEnv("GMAX_CONCENTRATION_THRESHOLD", "2");
  const { instance } = searcher([docRow("old", ARCHIVED)]);
  const result = await instance.search(
    "Which docs describe the comms data model?",
    1,
    { explain: true, diagnostics: true, projectRoot: "/project" },
  );
  const hit = byHash(result, "old");
  expect(hit.scoreBreakdown?.boost).toBeCloseTo(0.5);
  expect(result.diagnostics?.settings.documentationRequested).toBe(true);
  expect(result.diagnostics?.settings.historyRequested).toBe(false);
});

it("matches archive folders only below the project root", async () => {
  vi.stubEnv("GMAX_CONCENTRATION_THRESHOLD", "2");
  const underArchive = {
    ...docRow("doc", "x"),
    path: "/archive/project/docs/setup.md",
  };
  const { instance } = searcher([underArchive]);
  const result = await instance.search(MODEL_QUERY, 1, {
    explain: true,
    projectRoot: "/archive/project",
  });
  expect(byHash(result, "doc").scoreBreakdown?.archive).toBe(1);
  expect(byHash(result, "doc").docStatus).toBeNull();
});

it("keeps today's scores when the caller passes no project root", async () => {
  vi.stubEnv("GMAX_CONCENTRATION_THRESHOLD", "2");
  const { instance } = searcher([docRow("old", ARCHIVED)]);
  const result = await instance.search(MODEL_QUERY, 1, { explain: true });
  const hit = byHash(result, "old");
  expect(hit.scoreBreakdown?.boost).toBeCloseTo(0.6);
  expect(hit.docStatus).toBeNull();
});

it("uses the containing project root in cross-project search", async () => {
  vi.stubEnv("GMAX_CONCENTRATION_THRESHOLD", "2");
  const other = {
    ...docRow("other", "x"),
    path: "/work/other/docs/archived/plan.md",
  };
  const { instance } = searcher([other]);
  const result = await instance.search(
    MODEL_QUERY,
    1,
    { explain: true, projectRoot: "/project" },
    { projectRoots: ["/project", "/work/other"] },
  );
  expect(byHash(result, "other").scoreBreakdown?.archive).toBe(0.5);
  expect(byHash(result, "other").docStatus).toBe("archived");
});

it("demotes nothing when a single --in scope sits inside an archive folder", async () => {
  vi.stubEnv("GMAX_CONCENTRATION_THRESHOLD", "2");
  const plan = docRow("plan", "docs/plans/archived/door-pricing.md");
  const { instance } = searcher([plan]);
  const result = await instance.search(
    MODEL_QUERY,
    1,
    { explain: true, diagnostics: true, projectRoot: "/project" },
    undefined,
    "/project/docs/plans/archived/",
  );
  const hit = byHash(result, "plan");
  expect(hit.scoreBreakdown?.archive).toBe(1);
  expect(hit.scoreBreakdown?.boost).toBeCloseTo(0.6);
  expect(hit.docStatus).toBe("archived");
  expect(result.diagnostics?.settings.historyRequested).toBe(true);
});

it.each([
  ["1", 1],
  ["0.25", 0.25],
  ["0", 0.5],
  ["-1", 0.5],
  ["abc", 0.5],
])("reads GMAX_ARCHIVE_PENALTY=%s as %s", async (value, factor) => {
  vi.stubEnv("GMAX_CONCENTRATION_THRESHOLD", "2");
  vi.stubEnv("GMAX_ARCHIVE_PENALTY", value as string);
  const { instance } = searcher([docRow("old", ARCHIVED)]);
  const result = await instance.search(MODEL_QUERY, 1, {
    explain: true,
    projectRoot: "/project",
  });
  const hit = byHash(result, "old");
  expect(hit.scoreBreakdown?.archive).toBe(factor);
  expect(hit.scoreBreakdown?.boost).toBeCloseTo(0.6 * (factor as number));
  expect(hit.docStatus).toBe("archived");
});

it("ranks the current doc above its archived predecessor in a P3-shaped pool", async () => {
  vi.stubEnv("GMAX_CONCENTRATION_THRESHOLD", "2");
  const pool = [
    docRow("old-model", ARCHIVED),
    docRow(
      "old-delivery",
      "docs/modules/comms/archive/comms-message-delivery.md",
    ),
    docRow("telephony", "docs/modules/telephony.md"),
    docRow("notifications", "docs/platform/notifications.md"),
    row("resolver", "packages/api/src/comms/resolvers.ts"),
    docRow("current", CURRENT),
  ];
  const order = async (options: { history?: boolean; projectRoot?: string }) =>
    (await searcher(pool).instance.search(MODEL_QUERY, 6, options)).data.map(
      (r) => r.metadata?.hash,
    );
  const ranked = await order({ projectRoot: "/project" });
  expect(ranked.indexOf("current")).toBeLessThan(ranked.indexOf("old-model"));
  expect(ranked.indexOf("current")).toBeLessThan(
    ranked.indexOf("old-delivery"),
  );
  for (const unchanged of [
    await order({}),
    await order({ projectRoot: "/project", history: true }),
  ]) {
    expect(unchanged.indexOf("old-model")).toBeLessThan(
      unchanged.indexOf("current"),
    );
  }
});
