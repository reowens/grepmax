// Isolated acceptance seed written by the same Node backend as gmax. This
// reproduces VectorDB's schema and seed lifecycle without loading any model.
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

function canonical(value) {
  if (value === null || value === undefined || typeof value !== "object") return value;
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return { binary: Buffer.from(value).toString("hex") };
  }
  if (ArrayBuffer.isView(value)) return Array.from(value, canonical);
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value.toJSON === "function") return canonical(value.toJSON());
  if (typeof value.toArray === "function") return canonical(value.toArray());
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
}

async function nodeRowDigest(table) {
  const rows = (await table.query().toArray()).map(canonical)
    .sort((left, right) => left.id.localeCompare(right.id));
  return { rows: rows.length, ids: rows.map(row => row.id),
    digest: crypto.createHash("sha256").update(JSON.stringify(rows)).digest("hex") };
}

function productionSchema(packageRoot) {
  const { Schema, Field, Utf8, Int32, Float32, Float64, Bool, Binary,
    FixedSizeList, List } = require(require.resolve("apache-arrow", { paths: [packageRoot] }));
  const text = name => new Field(name, new Utf8(), true);
  const texts = name => new Field(name, new List(new Field("item", new Utf8(), true)), true);
  return new Schema([
    ...["id", "path", "hash", "content", "display_text"].map(name => new Field(name, new Utf8(), false)),
    new Field("start_line", new Int32(), false), new Field("end_line", new Int32(), false),
    new Field("vector", new FixedSizeList(384, new Field("item", new Float32(), false)), false),
    new Field("chunk_index", new Int32(), true), new Field("is_anchor", new Bool(), true),
    ...["context_prev", "context_next", "chunk_type"].map(text),
    new Field("complexity", new Float32(), true), new Field("is_exported", new Bool(), true),
    new Field("colbert", new Binary(), true), new Field("colbert_scale", new Float64(), true),
    new Field("pooled_colbert_48d", new FixedSizeList(48, new Field("item", new Float32(), false)), true),
    new Field("doc_token_ids", new List(new Field("item", new Int32(), true)), true),
    ...["defined_symbols", "referenced_symbols", "type_referenced_symbols",
      "member_referenced_symbols", "imports", "exports"].map(texts),
    ...["role", "parent_symbol", "file_skeleton", "summary"].map(text),
  ]);
}

function seed() {
  return { id: "seed", path: "", hash: "", content: "", display_text: "", start_line: 0,
    end_line: 0, chunk_index: 0, is_anchor: false, context_prev: "", context_next: "",
    chunk_type: "", complexity: 0, is_exported: false, vector: Array(384).fill(0),
    colbert: Buffer.alloc(0), colbert_scale: 1, pooled_colbert_48d: Array(48).fill(0),
    doc_token_ids: [], defined_symbols: [], referenced_symbols: [], type_referenced_symbols: [],
    member_referenced_symbols: [], imports: [], exports: [], role: "", parent_symbol: "",
    file_skeleton: "", summary: "" };
}

async function prepareNodeBoundedFixture(lance, store, packageRoot) {
  const connection = await lance.connect(store, {
    session: new lance.Session(BigInt(16 * 1024 ** 2), BigInt(8 * 1024 ** 2)),
  });
  let table;
  try {
    table = await connection.createTable("chunks", [seed()], { schema: productionSchema(packageRoot) });
    await table.delete("id = 'seed'");
    for (let offset = 0; offset < 512; offset += 128) {
      const batch = Array.from({ length: 128 }, (_, local) => {
        const i = offset + local;
        return { ...seed(), id: `fixture-${String(i).padStart(5, "0")}`,
          path: `/fixture/β/${i}.ts`, hash: `hash-${i}`, content: `retainedneedle function${i} β`,
          display_text: `display ${i}`, start_line: i, end_line: i + 2, chunk_index: i % 3,
          is_anchor: i % 2 === 0, context_prev: `previous-${i}`, context_next: `next-${i}`,
          chunk_type: "function", complexity: i % 11, is_exported: i % 7 === 0,
          vector: Array.from({ length: 384 }, (_, j) => ((i + j) % 17) / 17),
          colbert: i % 4 ? Buffer.from([i % 256, 0, 255]) : null,
          colbert_scale: 0.5, pooled_colbert_48d: Array.from({ length: 48 }, (_, j) => j / 48),
          doc_token_ids: [i, i + 1], defined_symbols: [`function${i}`, "β"],
          referenced_symbols: i % 5 ? ["dependency"] : [], type_referenced_symbols: ["Type"],
          member_referenced_symbols: ["member"], imports: ["module"], exports: [`function${i}`],
          role: "ORCHESTRATION", parent_symbol: "parent", file_skeleton: `skeleton-${i}`,
          summary: i % 7 ? `summary-${i}` : null };
      });
      await table.add(batch);
    }
    await table.createIndex("content", { config: lance.Index.fts(), name: "content_idx" });
    await table.createIndex("path", { config: lance.Index.btree(), name: "path_idx" });
    const originalVersion = await table.version();
    await (await table.tags()).create("user-reader", originalVersion);
    await table.delete("start_line < 64");
    const expected = await nodeRowDigest(table);
    assert.equal(expected.rows, 448);
    assert.deepEqual(expected.ids, Array.from({ length: 448 }, (_, i) => `fixture-${String(i + 64).padStart(5, "0")}`));
    return { version: await table.version(), rows: expected.rows, expectedIds: expected.ids,
      nodeDigest: expected.digest, vectorWidth: 384, schemaFields: (await table.schema()).fields.length,
      seedBackend: "installed-node-lancedb", userVersion: originalVersion };
  } finally {
    table?.close();
    await connection.close();
  }
}

async function verifyNodeBoundedFixture(table, prepared) {
  const current = await nodeRowDigest(table);
  assert.equal(current.digest, prepared.nodeDigest, "Every field must match the Node-created snapshot");
  assert.deepEqual(current.ids, prepared.expectedIds);
  const lexical = await table.query().fullTextSearch("retainedneedle", { columns: ["content"] })
    .select(["id", "content"]).limit(3).toArray();
  assert.equal(lexical.length, 3);
  assert(lexical.every(row => prepared.expectedIds.includes(row.id) && row.content.includes("retainedneedle")));
  const exactPath = await table.query().where("path = '/fixture/β/64.ts'").select(["id"]).toArray();
  assert.deepEqual(exactPath.map(row => row.id), ["fixture-00064"]);
  const nearest = await table.vectorSearch(Array(384).fill(0)).column("vector").select(["id"]).limit(5).toArray();
  assert.equal(nearest.length, 5);
  assert(nearest.every(row => prepared.expectedIds.includes(row.id)));
  return { rows: current.rows, allFieldsDigest: current.digest, ftsHits: lexical.length,
    pathHits: exactPath.length, vectorHits: nearest.length, vectorWidth: 384 };
}

module.exports = { prepareNodeBoundedFixture, verifyNodeBoundedFixture, nodeRowDigest };
