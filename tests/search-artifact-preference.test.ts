import { afterEach, expect, it, vi } from "vitest";
import { artifactPreference } from "../src/lib/search/artifact-preference";
import { Searcher } from "../src/lib/search/searcher";
import type { VectorRecord } from "../src/lib/store/types";
import type { VectorDB } from "../src/lib/store/vector-db";

afterEach(() => vi.unstubAllEnvs());

it.each([
  ["Which regression test verifies stale entries disappear?", true, false],
  ["Find unit tests for the parser", true, false],
  ["What test covers the empty response?", true, false],
  ["Where is the test file for cache expiry?", true, false],
  ["Find the test case for empty responses", true, false],
  ["Show the test suite for routing", true, false],
  ["Where are the test files for cache expiry?", true, false],
  ["Find the test cases for empty responses", true, false],
  ["Show the test suites for routing", true, false],
  ["Where does the README explain setup?", false, true],
  ["Which manual describes setup?", false, true],
  ["Where is the setup guide?", false, true],
  ["Which documentation guide describes the tests?", true, true],
  ["How does the client test the connection?", false, false],
  ["Where is testConnection defined?", false, false],
  ["How is manual memory management implemented?", false, false],
  ["How does manual mode affect retries?", false, false],
  ["How do guide rails constrain the carriage?", false, false],
  [
    "How does the PDF document renderer handle a manualFeed flag?",
    false,
    false,
  ],
])(
  "recognizes explicit artifact requests in %s",
  (query, tests, documentation) => {
    expect(artifactPreference(query as string)).toEqual({
      tests,
      documentation,
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
  const retrieval = () => {
    let count = records.length;
    const chain = {
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
    vectorSearch: retrieval,
    query: retrieval,
    search: () => {
      const chain = {
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
