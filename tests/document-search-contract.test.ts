import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type DocumentSearchDeps,
  documentFilter,
  handleDocumentSearch,
} from "../src/lib/daemon/document-search-handler";
import {
  canonicalPointer,
  DOCUMENT_LIMITS,
  documentCoveragePaths,
  documentIndexState,
  documentPaths,
  selectDocumentContext,
} from "../src/lib/mcp/document-contract";
import { OperationCoordinator } from "../src/lib/utils/operation-coordinator";

let dir: string, home: string, root: string, file: string;
let deps: DocumentSearchDeps;
let rows: any[],
  table: any,
  state: string,
  queryState: string,
  generation: number;
const hash = "a".repeat(64);
beforeEach(() => {
  dir = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "gmax-doc-contract-")),
  );
  home = path.join(dir, "home");
  root = path.join(dir, "Repo");
  file = path.join(root, "docs", "plan.md");
  fs.mkdirSync(home);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "# Plan\n");
  vi.stubEnv("HOME", dir);
  vi.stubEnv("GMAX_SECONDARY_STORE", "0");
  fs.writeFileSync(
    path.join(home, "projects.json"),
    JSON.stringify([{ root, status: "indexed" }]),
  );
  state = "ready";
  queryState = "ready";
  generation = 1;
  rows = [
    {
      path: file,
      hash,
      start_line: 4,
      end_line: 6,
      _distance: 0.25,
      content: "PRIVATE_CACHED_TEXT",
    },
  ];
  table = {
    vectorSearch: vi.fn(() => table),
    distanceType: vi.fn(() => table),
    where: vi.fn(() => table),
    select: vi.fn(() => table),
    limit: vi.fn(() => table),
    toArray: vi.fn(async () => rows),
  };
  deps = {
    home,
    state: () => state,
    generation: () => generation,
    embeddingState: () => "ready",
    meta: () => ({
      hash,
      mtimeMs: 1,
      size: 1,
      hashVersion: 1,
      hasVectors: true,
    }),
    queryState: () => queryState,
    encode: vi.fn(async () => ({ dense: [1, 2] })),
    table: vi.fn(async () => table),
    indexState: () => ({ indexing: false }),
  };
});
afterEach(() => {
  vi.useRealTimers();
  fs.rmSync(dir, { recursive: true, force: true });
  vi.unstubAllEnvs();
});
function command(cmd = "documents.search"): Record<string, unknown> {
  return {
    cmd,
    contractVersion: 1,
    checkout: root,
    projectRoot: root,
    store: path.join(home, "lancedb"),
    generation: 1,
    query: "where do plans describe shipping",
    prefixes: [path.dirname(file)],
    paths: [file],
  };
}
function call(cmd = command(), signal = new AbortController().signal) {
  return handleDocumentSearch(deps, cmd, signal);
}

describe("bounded document contract", () => {
  it("selects the most specific canonical ancestor and preserves registered spelling", () => {
    const alias = path.join(dir, "Alias");
    fs.symlinkSync(root, alias);
    fs.writeFileSync(
      path.join(home, "projects.json"),
      JSON.stringify([
        { root: dir, status: "indexed" },
        { root: alias, status: "indexed" },
      ]),
    );
    const ctx = selectDocumentContext(home, path.dirname(file));
    expect(ctx.root).toBe(root);
    expect(ctx.wireRoot).toBe(alias);
    expect(documentPaths([file], ctx, "paths")).toEqual([
      path.join(alias, "docs", "plan.md"),
    ]);
  });
  it("rejects unknown registry and secondary stores without seeding config", () => {
    fs.writeFileSync(path.join(home, "projects.json"), "[]");
    expect(() => selectDocumentContext(home, root)).toThrow("no_index");
    vi.stubEnv("GMAX_SECONDARY_STORE", "1");
    expect(() => selectDocumentContext(home, root)).toThrow(
      "store_unavailable",
    );
    expect(fs.readdirSync(home)).toEqual(["projects.json"]);
  });
  it("restricts descendant checkouts and follows symlinks before authorizing", () => {
    const ctx = selectDocumentContext(home, path.dirname(file));
    const outside = path.join(root, "other.md");
    fs.writeFileSync(outside, "outside");
    fs.symlinkSync(outside, path.join(path.dirname(file), "escape.md"));
    expect(() => documentPaths([outside], ctx, "paths")).toThrow("no_coverage");
    expect(
      canonicalPointer(path.join(path.dirname(file), "escape.md"), ctx),
    ).toBe(null);
  });
  it.each([
    Array(33).fill("prefix"),
    [],
    ["../docs"],
    [`${root}/../other`],
    [`${file}\0`],
  ])("refuses invalid prefixes %j", (value) => {
    expect(() =>
      documentPaths(value, selectDocumentContext(home, root), "prefixes"),
    ).toThrow();
  });
  it("bounds path count and bytes and rejects non-markdown coverage", () => {
    const ctx = selectDocumentContext(home, root);
    expect(() => documentPaths(Array(2001).fill(file), ctx, "paths")).toThrow();
    expect(() =>
      documentPaths(
        [`/${"a".repeat(DOCUMENT_LIMITS.pathBytes)}`],
        ctx,
        "paths",
      ),
    ).toThrow();
    expect(() => documentPaths([root], ctx, "paths")).toThrow();
  });
  it("rejects Markdown directories and symlinks to them as coverage or source pointers", () => {
    const directory = path.join(root, "docs", "folder.md");
    const alias = path.join(root, "docs", "alias.md");
    fs.mkdirSync(directory);
    fs.symlinkSync(directory, alias);
    const context = selectDocumentContext(home, root);
    for (const candidate of [directory, alias]) {
      expect(() => documentCoveragePaths([candidate], context)).toThrow(
        "no_coverage",
      );
      expect(canonicalPointer(candidate, context)).toBeNull();
    }
    expect(documentPaths([directory], context, "prefixes")).toEqual([
      directory,
    ]);
  });
  it("keeps valid sampled paths when another disappears but rejects missing paths outside scope", () => {
    const missing = path.join(root, "docs", "deleted.md"),
      context = selectDocumentContext(home, root);
    expect(documentCoveragePaths([file, missing], context)).toEqual({
      paths: [file],
      requested: 2,
    });
    expect(() =>
      documentCoveragePaths([file, path.join(dir, "private.md")], context),
    ).toThrow("no_coverage");
    expect(() =>
      documentPaths([path.join(root, "missing")], context, "prefixes"),
    ).toThrow("no_coverage");
  });
  it("allowlists bounded index metadata and drops arbitrary diagnostics", () => {
    expect(documentIndexState(undefined)).toEqual({ degraded: true });
    expect(
      documentIndexState({ indexing: false, failedFiles: "PRIVATE_QUERY" }),
    ).toEqual({ indexing: false, degraded: true });
    expect(
      documentIndexState({
        indexing: false,
        pendingFiles: 4,
        failedFiles: -1,
        verifying: "PRIVATE_QUERY",
        degraded: true,
        queue: { source: "PRIVATE_TEXT" },
        watcherMode: "polling",
        catchupMs: Infinity,
        lastReconciledAt: 123,
        extra: "PRIVATE_TEXT",
      }),
    ).toEqual({
      indexing: false,
      pendingFiles: 4,
      degraded: true,
      watcherMode: "polling",
      lastReconciledAt: 123,
    });
  });
  it("escapes SQL literals and uses literal prefix ranges rather than LIKE metacharacters", () => {
    const sql = documentFilter(["/repo/a'_%"]);
    expect(sql).toContain("a''_%/");
    expect(sql).not.toContain("LIKE '/repo/");
  });
});

describe("existing daemon document reads", () => {
  it("returns bounded full-source pointers with indexed byte hash, never source bodies", async () => {
    const result = await call();
    expect(result).toMatchObject({
      ok: true,
      retrieval: "dense",
      matches: [
        {
          path: file,
          startLine: 5,
          endLine: 7,
          score: 0.8,
          hash,
          hashAlgorithm: "sha256-bytes",
        },
      ],
    });
    expect(JSON.stringify(result)).not.toContain("PRIVATE_CACHED_TEXT");
    expect(table.limit).toHaveBeenCalledWith(50);
    expect(table.select).toHaveBeenCalledWith([
      "path",
      "hash",
      "start_line",
      "end_line",
      "_distance",
    ]);
  });
  it("status reports actual metadata coverage without query/store/model setup", async () => {
    const result = await call(command("documents.status"));
    expect(result).toMatchObject({
      ok: true,
      embeddingReady: true,
      covered: [{ path: file, hash, hashAlgorithm: "sha256-bytes" }],
      coverage: { requested: 1, indexed: 1, partial: false },
    });
    expect(deps.encode).not.toHaveBeenCalled();
    expect(deps.table).not.toHaveBeenCalled();
    deps.meta = () => undefined;
    expect(await call(command("documents.status"))).toMatchObject({
      covered: [],
      coverage: { partial: true, indexed: 0 },
    });
  });
  it("status preserves indexed timestamps and partial coverage across disappearing sampled files", async () => {
    deps.lastIndexed = () => "2026-10-07T22:00:00Z";
    const request = command("documents.status");
    request.paths = [file, path.join(root, "docs", "deleted.md")];
    deps.indexState = () => ({
      indexing: true,
      failedFiles: 2,
      error: "PRIVATE_QUERY",
    });
    const result = await call(request);
    expect(result).toMatchObject({
      lastIndexed: "2026-10-07T22:00:00Z",
      covered: [{ path: file, indexedMtimeMs: 1 }],
      coverage: { requested: 2, indexed: 1, partial: true },
      indexState: { indexing: true, failedFiles: 2 },
    });
    expect(JSON.stringify(result)).not.toContain("PRIVATE_QUERY");
    expect(deps.table).not.toHaveBeenCalled();
  });
  it.each(["host_pressure", "busy", "store_unavailable", "embedding_mismatch"])(
    "refuses %s before any native/query work",
    async (reason) => {
      state = reason;
      expect(await call()).toMatchObject({ ok: false, state: reason });
      expect(deps.encode).not.toHaveBeenCalled();
      expect(deps.table).not.toHaveBeenCalled();
    },
  );
  it.each(["busy", "embedding_unavailable", "host_pressure"])(
    "refuses query worker state %s",
    async (reason) => {
      queryState = reason;
      expect(await call()).toMatchObject({ ok: false, state: reason });
      expect(deps.encode).not.toHaveBeenCalled();
    },
  );
  it.each([
    { contractVersion: 2 },
    { projectRoot: "/forged" },
    { store: "/secondary" },
    { generation: 2 },
    { generation: undefined },
    { generation: null },
    { generation: "1" },
    { generation: 0 },
    { generation: 1.5 },
    { generation: Number.MAX_SAFE_INTEGER + 1 },
    { query: "x".repeat(501) },
    { prefixes: ["/forged"] },
  ])("refuses forged/unsupported scope %j", async (fields) => {
    expect((await call({ ...command(), ...fields })).ok).toBe(false);
    expect(deps.encode).not.toHaveBeenCalled();
  });
  it("revalidates generation and host state after encoding", async () => {
    deps.encode = vi.fn(async () => {
      generation++;
      return { dense: [1] };
    });
    expect(await call()).toMatchObject({ state: "embedding_mismatch" });
    expect(deps.table).not.toHaveBeenCalled();
    generation = 1;
    deps.encode = vi.fn(async () => {
      state = "host_pressure";
      return { dense: [1] };
    });
    expect(await call()).toMatchObject({ state: "host_pressure" });
  });
  it("discards late results on cancellation without touching any shared cleanup", async () => {
    const controller = new AbortController();
    table.toArray.mockImplementation(async () => {
      controller.abort();
      return rows;
    });
    expect(await call(command(), controller.signal)).toMatchObject({
      state: "cancelled",
    });
  });
  it.each(["cancelled", "timeout"])(
    "holds shared ownership through %s until the actual native promise settles",
    async (mode) => {
      vi.useFakeTimers({ toFake: ["performance"] });
      const coordinator = new OperationCoordinator(),
        controller = new AbortController();
      let finish!: (value: any[]) => void;
      table.toArray.mockImplementation(
        () =>
          new Promise<any[]>((resolve) => {
            finish = resolve;
          }),
      );
      const result = coordinator.runShared(
        "documents",
        controller.signal,
        (signal) => call(command(), signal),
      );
      await vi.waitFor(() => expect(table.toArray).toHaveBeenCalled());
      if (mode === "cancelled") controller.abort();
      const exclusive = vi.fn(async () => {});
      const drain = coordinator.runExclusive(
        "teardown",
        async () => {},
        exclusive,
      );
      vi.advanceTimersByTime(10001);
      await Promise.resolve();
      expect(exclusive).not.toHaveBeenCalled();
      expect(coordinator.activeCount).toBe(2);
      finish(rows);
      expect(await result).toMatchObject({ state: mode });
      await drain;
      expect(exclusive).toHaveBeenCalledTimes(1);
      expect(coordinator.activeCount).toBe(0);
    },
  );
  it("passes only the remaining overall deadline to the native query", async () => {
    vi.useFakeTimers({ toFake: ["performance"] });
    deps.encode = vi.fn(async () => {
      vi.advanceTimersByTime(6000);
      return { dense: [1] };
    });
    expect(await call()).toMatchObject({ ok: true });
    const nativeMs = table.toArray.mock.calls[0][0].timeoutMs;
    expect(nativeMs).toBeGreaterThan(0);
    expect(nativeMs).toBeLessThanOrEqual(4000);
  });
  it("redacts provider errors containing query text", async () => {
    deps.encode = vi.fn(async () => {
      throw new Error("PRIVATE_QUERY_CREDENTIAL");
    });
    expect(await call()).toEqual({ ok: false, state: "search_unavailable" });
  });
  it("drops outside/malformed rows without refill and strips legacy or inconsistent hashes", async () => {
    rows = [
      ...rows,
      {
        path: path.join(dir, "outside.md"),
        hash,
        start_line: 0,
        end_line: 1,
        _distance: 1,
      },
    ];
    deps.meta = () => ({
      hash,
      mtimeMs: 1,
      size: 1,
      hashVersion: 0,
      hasVectors: true,
    });
    expect(await call()).toMatchObject({ matches: [{ path: file }] });
    expect(JSON.stringify(await call())).not.toContain("hashAlgorithm");
    deps.meta = () => ({
      hash: "b".repeat(64),
      mtimeMs: 1,
      size: 1,
      hashVersion: 1,
      hasVectors: true,
    });
    expect(JSON.stringify(await call())).not.toContain("hashAlgorithm");
    rows = Array(70).fill(rows[0]);
    expect((await call()).matches).toHaveLength(50);
  });
});
