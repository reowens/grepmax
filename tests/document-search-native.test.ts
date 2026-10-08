import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { connect } from "@lancedb/lancedb";
import { expect, it, vi } from "vitest";
import { handleDocumentSearch } from "../src/lib/daemon/document-search-handler";
import { VectorDB } from "../src/lib/store/vector-db";

it("restricted native dense reads filter literal prefixes without changing synthetic rows", async () => {
  const dir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "gmax-doc-native-")),
    ),
    home = path.join(dir, "home"),
    root = path.join(dir, "repo"),
    prefix = path.join(root, "docs'_%"),
    other = path.join(root, "other");
  fs.mkdirSync(home);
  fs.mkdirSync(prefix, { recursive: true });
  fs.mkdirSync(other);
  vi.stubEnv("HOME", dir);
  vi.stubEnv("GMAX_SECONDARY_STORE", "0");
  const file = path.join(prefix, "plan.md"),
    hidden = path.join(other, "private.md");
  fs.writeFileSync(file, "# Plan\n");
  fs.writeFileSync(hidden, "# Private\n");
  fs.writeFileSync(
    path.join(home, "projects.json"),
    JSON.stringify([{ root, status: "indexed" }]),
  );
  const hash = "a".repeat(64),
    vector = Array(384).fill(0);
  vector[0] = 1;
  const connection = await connect(path.join(home, "lancedb"));
  try {
    const table = await connection.createTable("chunks", [
      { path: file, hash, start_line: 0, end_line: 1, vector },
      { path: hidden, hash, start_line: 0, end_line: 1, vector },
    ]);
    const before = await table.countRows();
    const result = await handleDocumentSearch(
      {
        home,
        state: () => "ready",
        generation: () => 1,
        embeddingState: () => "ready",
        meta: () => ({
          hash,
          hashVersion: 1,
          hasVectors: true,
          mtimeMs: 1,
          size: 1,
        }),
        queryState: () => "ready",
        encode: async () => ({ dense: vector }),
        table: async () => table,
        indexState: () => ({ indexing: false }),
      },
      {
        cmd: "documents.search",
        contractVersion: 1,
        generation: 1,
        checkout: root,
        projectRoot: root,
        store: path.join(home, "lancedb"),
        query: "plans",
        prefixes: [prefix],
      },
      new AbortController().signal,
    );
    expect(result).toMatchObject({
      ok: true,
      matches: [
        { path: file, startLine: 1, endLine: 2, hashAlgorithm: "sha256-bytes" },
      ],
    });
    expect(result.matches).toHaveLength(1);
    expect(await table.countRows()).toBe(before);
  } finally {
    connection.close();
    fs.rmSync(dir, { recursive: true, force: true });
    vi.unstubAllEnvs();
  }
});
it("restricted VectorDB table access cannot create a connection or seed a missing table", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gmax-doc-no-open-"));
  const db = new VectorDB(dir, 384);
  const open = vi.spyOn(db as any, "getDb");
  const ensure = vi.spyOn(db, "ensureTable");
  try {
    await expect(db.existingTableForRead()).rejects.toThrow(
      "store_unavailable",
    );
    expect(open).not.toHaveBeenCalled();
    expect(ensure).not.toHaveBeenCalled();
    expect(fs.readdirSync(dir)).toEqual([]);
  } finally {
    await db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
