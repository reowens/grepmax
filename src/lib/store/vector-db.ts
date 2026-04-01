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
  List,
  Schema,
  Utf8,
} from "apache-arrow";
import { CONFIG } from "../../config";
import { escapeSqlString } from "../utils/filter-builder";
import { debug, log, timer } from "../utils/logger";
import { registerCleanup } from "../utils/cleanup";
import type { VectorRecord } from "./types";

const TABLE_NAME = "chunks";

export class VectorDB {
  private db: lancedb.Connection | null = null;
  private unregisterCleanup?: () => void;
  private closed = false;
  private readonly vectorDim: number;
  private maintenanceRunning = false;

  constructor(
    private lancedbDir: string,
    vectorDim?: number,
  ) {
    this.vectorDim = vectorDim ?? CONFIG.VECTOR_DIM;
    this.unregisterCleanup = registerCleanup(() => this.close());
  }

  private async getDb(): Promise<lancedb.Connection> {
    if (this.closed) {
      throw new Error("VectorDB connection is closed");
    }
    if (!this.db) {
      fs.mkdirSync(this.lancedbDir, { recursive: true });
      this.db = await lancedb.connect(this.lancedbDir);
    }
    return this.db;
  }

  private seedRow(): VectorRecord {
    return {
      id: "seed",
      path: "",
      hash: "",
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
      vector: Array(this.vectorDim).fill(0),
      colbert: Buffer.alloc(0),
      colbert_scale: 1,
      pooled_colbert_48d: Array(CONFIG.COLBERT_DIM).fill(0),
      doc_token_ids: [],
      defined_symbols: [],
      referenced_symbols: [],
      imports: [],
      exports: [],
      role: "",
      parent_symbol: "",
      file_skeleton: "",
      summary: "",
    };
  }

  private async validateSchema(table: lancedb.Table) {
    const schema = await table.schema();
    const fields = new Set(schema.fields.map((f) => f.name));
    const required = ["complexity", "is_exported"];
    const missing = required.filter((r) => !fields.has(r));
    if (missing.length > 0) {
      throw new Error(
        `[vector-db] schema missing fields (${missing.join(
          ", ",
        )}). Please run "gmax index --reset" to rebuild the index.`,
      );
    }
  }

  private buildSchema(): Schema {
    return new Schema([
      new Field("id", new Utf8(), false),
      new Field("path", new Utf8(), false),
      new Field("hash", new Utf8(), false),
      new Field("content", new Utf8(), false),
      new Field("display_text", new Utf8(), false),
      new Field("start_line", new Int32(), false),
      new Field("end_line", new Int32(), false),
      new Field(
        "vector",
        new FixedSizeList(
          this.vectorDim,
          new Field("item", new Float32(), false),
        ),
        false,
      ),
      new Field("chunk_index", new Int32(), true),
      new Field("is_anchor", new Bool(), true),
      new Field("context_prev", new Utf8(), true),
      new Field("context_next", new Utf8(), true),
      new Field("chunk_type", new Utf8(), true),
      new Field("complexity", new Float32(), true),
      new Field("is_exported", new Bool(), true),
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
      new Field(
        "doc_token_ids",
        new List(new Field("item", new Int32(), true)),
        true,
      ),
      new Field(
        "defined_symbols",
        new List(new Field("item", new Utf8(), true)),
        true,
      ),
      new Field(
        "referenced_symbols",
        new List(new Field("item", new Utf8(), true)),
        true,
      ),
      new Field("imports", new List(new Field("item", new Utf8(), true)), true),
      new Field("exports", new List(new Field("item", new Utf8(), true)), true),
      new Field("role", new Utf8(), true),
      new Field("parent_symbol", new Utf8(), true),
      new Field("file_skeleton", new Utf8(), true),
      new Field("summary", new Utf8(), true),
    ]);
  }

  async ensureTable(): Promise<lancedb.Table> {
    const db = await this.getDb();
    try {
      const table = await db.openTable(TABLE_NAME);
      await this.validateSchema(table);
      return table;
    } catch (_err) {
      log("db", `Creating table (${this.vectorDim}d)`);
      const schema = this.buildSchema();
      const table = await db.createTable(TABLE_NAME, [this.seedRow()], {
        schema,
      });
      await table.delete('id = "seed"');
      return table;
    }
  }

  async insertBatch(records: VectorRecord[]): Promise<void> {
    if (!records.length) return;
    const table = await this.ensureTable();

    const toBuffer = (val: unknown): Buffer => {
      if (Buffer.isBuffer(val)) return val;
      if (ArrayBuffer.isView(val) && (val as ArrayBufferView).buffer) {
        const view = val as ArrayBufferView;
        return Buffer.from(
          view.buffer,
          view.byteOffset ?? 0,
          view.byteLength ?? undefined,
        );
      }
      if (
        val &&
        typeof val === "object" &&
        "type" in (val as any) &&
        (val as any).type === "Buffer" &&
        Array.isArray((val as any).data)
      ) {
        return Buffer.from((val as any).data);
      }
      if (Array.isArray(val)) return Buffer.from(val);
      return Buffer.alloc(0);
    };

    const toNumberArray = (val: unknown): number[] => {
      if (Array.isArray(val)) return val.map((x) => Number(x) || 0);
      if (ArrayBuffer.isView(val) && (val as ArrayBufferView).buffer) {
        return Array.from(val as unknown as ArrayLike<number>);
      }
      if (
        val &&
        typeof val === "object" &&
        !("length" in (val as any)) &&
        Object.keys(val as any).length > 0
      ) {
        // Plain object with numeric keys (e.g., from IPC serialization)
        return Object.entries(val as Record<string, unknown>)
          .filter(([k]) => !Number.isNaN(Number(k)))
          .sort((a, b) => Number(a[0]) - Number(b[0]))
          .map(([, v]) => Number(v) || 0);
      }
      return [];
    };

    // Mutate records in-place to avoid doubling memory with a parallel rows array.
    // Callers (syncer flushBatch) splice records before passing — they're never reused.
    for (const rec of records) {
      const vec = toNumberArray(rec.vector);
      if (vec.length < this.vectorDim) {
        vec.push(...Array(this.vectorDim - vec.length).fill(0));
      } else if (vec.length > this.vectorDim) {
        vec.length = this.vectorDim;
      }
      (rec as any).vector = vec;
      (rec as any).colbert = toBuffer(rec.colbert);
      (rec as any).display_text = rec.display_text || rec.content;
      (rec as any).chunk_index = rec.chunk_index ?? null;
      (rec as any).is_anchor = rec.is_anchor ?? false;
      (rec as any).context_prev = rec.context_prev ?? "";
      (rec as any).context_next = rec.context_next ?? "";
      (rec as any).chunk_type = rec.chunk_type ?? "";
      (rec as any).complexity =
        typeof rec.complexity === "number" ? rec.complexity : undefined;
      (rec as any).is_exported = rec.is_exported ?? false;
      (rec as any).colbert_scale =
        typeof rec.colbert_scale === "number" ? rec.colbert_scale : 1;
      (rec as any).pooled_colbert_48d = rec.pooled_colbert_48d
        ? Array.from(rec.pooled_colbert_48d)
        : undefined;
      (rec as any).doc_token_ids = rec.doc_token_ids
        ? Array.from(rec.doc_token_ids)
        : null;
      (rec as any).defined_symbols = rec.defined_symbols ?? [];
      (rec as any).referenced_symbols = rec.referenced_symbols ?? [];
      (rec as any).imports = rec.imports ?? [];
      (rec as any).exports = rec.exports ?? [];
      (rec as any).role = rec.role ?? "";
      (rec as any).parent_symbol = rec.parent_symbol ?? "";
      (rec as any).file_skeleton = rec.file_skeleton ?? "";
      (rec as any).summary = rec.summary ?? null;
    }

    try {
      await table.add(records);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.toLowerCase().includes("found field not in schema")) {
        const schema = await table.schema();
        const schemaFields = schema.fields.map((f) => f.name);
        throw new Error(
          `[vector-db] schema mismatch detected (fields: ${schemaFields.join(
            ", ",
          )}). Please run "gmax index --reset" to rebuild the index.`,
        );
      }
      throw err;
    }
  }

  async createFTSIndex(rebuild = false): Promise<void> {
    const table = await this.ensureTable();
    if (rebuild) {
      try {
        await table.dropIndex("content_idx");
      } catch {}
    }
    try {
      await table.createIndex("content", {
        config: lancedb.Index.fts({ withPosition: true }),
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("already exists")) {
        return;
      }
      // If position error, try dropping and recreating
      if (msg.includes("position")) {
        try {
          await table.dropIndex("content_idx");
          await table.createIndex("content", {
            config: lancedb.Index.fts({ withPosition: true }),
          });
          log("vectordb", "Rebuilt FTS index with position support");
          return;
        } catch {}
      }
      console.warn("Failed to create FTS index:", e);
    }
  }

  async optimize(retries = 3, retentionMs = 0): Promise<void> {
    const table = await this.ensureTable();
    const cutoff = new Date(Date.now() - retentionMs);

    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        const done = timer("vectordb", "optimize");
        const stats = await table.optimize({
          cleanupOlderThan: cutoff,
          deleteUnverified: true,
        });
        done();

        const { compaction, prune } = stats;
        if (
          compaction.fragmentsRemoved > 0 ||
          prune.oldVersionsRemoved > 0 ||
          prune.bytesRemoved > 0
        ) {
          log(
            "vectordb",
            `Compacted: ${compaction.fragmentsRemoved} frags → ${compaction.fragmentsAdded}, ` +
              `pruned ${prune.oldVersionsRemoved} versions, ` +
              `freed ${(prune.bytesRemoved / 1024 / 1024).toFixed(1)}MB`,
          );
        } else {
          debug("vectordb", "Optimize: nothing to compact or prune");
        }
        return;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.includes("Nothing to do")) {
          debug("vectordb", "Optimize: nothing to do");
          return;
        }
        if (
          attempt < retries &&
          (msg.includes("conflict") || msg.includes("Retryable"))
        ) {
          const delay = 1000 * 2 ** (attempt - 1);
          log(
            "vectordb",
            `Optimize conflict (attempt ${attempt}/${retries}), retrying in ${delay}ms`,
          );
          await new Promise((r) => setTimeout(r, delay));
          continue;
        }
        log("vectordb", `Optimize failed: ${msg}`);
        return;
      }
    }
  }

  /**
   * Run FTS rebuild + optimize as a single serialized operation.
   * Safe to call from multiple project processors — only one runs at a time.
   */
  async runMaintenance(): Promise<void> {
    if (this.maintenanceRunning) {
      debug("vectordb", "Maintenance already running, skipping");
      return;
    }
    this.maintenanceRunning = true;
    try {
      await this.createFTSIndex();
      await this.optimize();
    } finally {
      this.maintenanceRunning = false;
    }
  }

  async hasAnyRows(): Promise<boolean> {
    const table = await this.ensureTable();
    const rows = await table.query().select(["id"]).limit(1).toArray();
    return rows.length > 0;
  }

  async hasRowsForPath(pathPrefix: string): Promise<boolean> {
    const table = await this.ensureTable();
    const prefix = pathPrefix.endsWith("/") ? pathPrefix : `${pathPrefix}/`;
    const rows = await table
      .query()
      .select(["id"])
      .where(`path LIKE '${escapeSqlString(prefix)}%'`)
      .limit(1)
      .toArray();
    return rows.length > 0;
  }

  async getStats(): Promise<{ chunks: number; totalBytes: number }> {
    const table = await this.ensureTable();
    const [count, stats] = await Promise.all([
      table.countRows(),
      table.stats(),
    ]);
    return { chunks: count, totalBytes: stats.totalBytes };
  }

  async getDistinctFileCount(): Promise<number> {
    const table = await this.ensureTable();
    const rows = await table.query().select(["path"]).toArray();
    return new Set(rows.map((r) => r.path)).size;
  }

  async deletePaths(paths: string[]): Promise<void> {
    if (!paths.length) return;
    const table = await this.ensureTable();
    const unique = Array.from(new Set(paths));
    const batchSize = 500;
    for (let i = 0; i < unique.length; i += batchSize) {
      const slice = unique.slice(i, i + batchSize);
      const values = slice.map((p) => `'${escapeSqlString(p)}'`).join(",");
      await table.delete(`path IN (${values})`);
    }
  }

  async updateRows(
    ids: string[],
    field: string,
    values: (string | null)[],
  ): Promise<void> {
    if (!ids.length) return;
    const table = await this.ensureTable();
    for (let i = 0; i < ids.length; i++) {
      const escaped = escapeSqlString(ids[i]);
      await table.update({
        where: `id = '${escaped}'`,
        values: { [field]: values[i] ?? "" },
      });
    }
  }

  async deletePathsExcludingIds(
    paths: string[],
    excludeIds: string[],
  ): Promise<void> {
    if (!paths.length) return;
    const table = await this.ensureTable();
    const unique = Array.from(new Set(paths));
    const batchSize = 500;
    const idExclusion =
      excludeIds.length > 0
        ? ` AND id NOT IN (${excludeIds.map((id) => `'${escapeSqlString(id)}'`).join(",")})`
        : "";
    for (let i = 0; i < unique.length; i += batchSize) {
      const slice = unique.slice(i, i + batchSize);
      const values = slice
        .map((p) => `'${escapeSqlString(p)}'`)
        .join(",");
      await table.delete(`path IN (${values})${idExclusion}`);
    }
  }

  async deletePathsWithPrefix(prefix: string): Promise<void> {
    const table = await this.ensureTable();
    await table.delete(`path LIKE '${escapeSqlString(prefix)}%'`);
  }

  async drop(): Promise<void> {
    const db = await this.getDb();
    try {
      await db.dropTable(TABLE_NAME);
    } catch (_err) {
      // ignore if missing
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.unregisterCleanup?.();
    this.unregisterCleanup = undefined;
    if (this.db) {
      if (this.db.close) await this.db.close();
    }
    this.db = null;
  }
}
