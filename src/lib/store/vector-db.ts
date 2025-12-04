import * as fs from "node:fs";
import * as lancedb from "@lancedb/lancedb";
import {
  Binary,
  Bool,
  Field,
  FixedSizeList,
  Float32,
  Float64,
  Int32,
  Schema,
  Utf8,
} from "apache-arrow";
import { CONFIG } from "../../config";
import type { VectorRecord } from "./types";

const TABLE_NAME = "chunks";

export class VectorDB {
  private db: lancedb.Connection | null = null;

  constructor(private lancedbDir: string) { }

  private async getDb(): Promise<lancedb.Connection> {
    if (!this.db) {
      fs.mkdirSync(this.lancedbDir, { recursive: true });
      this.db = await lancedb.connect(this.lancedbDir);
    }
    return this.db;
  }

  private baseSchemaRow(): VectorRecord {
    return {
      id: "seed",
      path: "",
      hash: "",
      content: "",
      start_line: 0,
      end_line: 0,
      chunk_index: 0,
      is_anchor: false,
      context_prev: "",
      context_next: "",
      chunk_type: "",
      vector: new Float32Array(CONFIG.VECTOR_DIM),
      colbert: Buffer.alloc(0),
      colbert_scale: 1,
      pooled_colbert_48d: new Float32Array(CONFIG.COLBERT_DIM),
    };
  }

  async ensureTable(): Promise<lancedb.Table> {
    const db = await this.getDb();
    const schema = new Schema([
      new Field("id", new Utf8(), false),
      new Field("path", new Utf8(), false),
      new Field("hash", new Utf8(), false),
      new Field("content", new Utf8(), false),
      new Field("start_line", new Int32(), false),
      new Field("end_line", new Int32(), false),
      new Field(
        "vector",
        new FixedSizeList(
          CONFIG.VECTOR_DIM,
          new Field("item", new Float32(), false),
        ),
        false,
      ),
      new Field("chunk_index", new Int32(), true),
      new Field("is_anchor", new Bool(), true),
      new Field("context_prev", new Utf8(), true),
      new Field("context_next", new Utf8(), true),
      new Field("chunk_type", new Utf8(), true),
      new Field("colbert", new Binary(), true),
      new Field("colbert_scale", new Float64(), true),
      new Field(
        "pooled_colbert_48d",
        new FixedSizeList(
          CONFIG.COLBERT_DIM,
          new Field("item", new Float32(), false),
        ),
        true,
      ),
    ]);

    try {
      const table = await db.openTable(TABLE_NAME);
      return table;
    } catch (_err) {
      const table = await db.createTable(TABLE_NAME, [this.baseSchemaRow()], {
        schema,
      });
      await table.delete('id = "seed"');
      return table;
    }
  }

  async insertBatch(records: VectorRecord[]): Promise<void> {
    if (!records.length) return;
    const table = await this.ensureTable();
    const sanitized = records.map((rec) => ({
      ...rec,
      vector: Array.from(rec.vector),
      colbert: Buffer.isBuffer(rec.colbert)
        ? rec.colbert
        : Buffer.from(
          rec.colbert instanceof Int8Array
            ? rec.colbert
            : new Int8Array(rec.colbert),
        ),
      pooled_colbert_48d: rec.pooled_colbert_48d
        ? Array.from(rec.pooled_colbert_48d)
        : undefined,
    }));
    await table.add(sanitized);
  }

  async createFTSIndex(): Promise<void> {
    const table = await this.ensureTable();
    try {
      await table.createIndex("content", {
        config: lancedb.Index.fts(),
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!msg.includes("already exists")) {
        console.warn("Failed to create FTS index:", e);
      }
    }
  }

  async listPaths(): Promise<Map<string, string | undefined>> {
    const table = await this.ensureTable();
    const results = (await table
      .query()
      .select(["path", "hash"])
      .toArray()) as VectorRecord[];
    const byPath = new Map<string, string | undefined>();
    for (const r of results) {
      const key = r.path as string;
      if (!byPath.has(key)) {
        byPath.set(key, r.hash as string | undefined);
      }
    }
    return byPath;
  }

  async deletePaths(paths: string[]): Promise<void> {
    if (!paths.length) return;
    const table = await this.ensureTable();
    const unique = Array.from(new Set(paths));
    const batchSize = 500;
    for (let i = 0; i < unique.length; i += batchSize) {
      const slice = unique.slice(i, i + batchSize);
      const values = slice.map((p) => `'${p.replace(/'/g, "''")}'`).join(",");
      await table.delete(`path IN (${values})`);
    }
  }

  async drop(): Promise<void> {
    const db = await this.getDb();
    try {
      await db.dropTable(TABLE_NAME);
    } catch (_err) {
      // ignore if missing
    }
  }
}
