import type { Table } from "@lancedb/lancedb";
import { CONFIG } from "../../config";
import type {
  ChunkType,
  SearchFilter,
  SearchResponse,
  VectorRecord,
} from "../store/types";
import type { VectorDB } from "../store/vector-db";
import { escapeSqlString, normalizePath } from "../utils/filter-builder";
import { getWorkerPool } from "../workers/pool";
import { detectIntent, type SearchIntent } from "./intent";

export function buildWhereClause(
  pathPrefix: string | undefined,
  filters: SearchFilter | undefined,
  searchIntent: SearchIntent,
): string | undefined {
  const parts: string[] = [];

  if (pathPrefix) {
    parts.push(
      `path LIKE '${escapeSqlString(normalizePath(pathPrefix))}%'`,
    );
  }

  const fileFilter = filters?.file;
  if (typeof fileFilter === "string" && fileFilter) {
    parts.push(`path LIKE '%/${escapeSqlString(fileFilter)}'`);
  }

  const excludeFilter = filters?.exclude;
  if (typeof excludeFilter === "string" && excludeFilter) {
    const absExclude = pathPrefix
      ? normalizePath(pathPrefix + excludeFilter)
      : excludeFilter;
    parts.push(`path NOT LIKE '${escapeSqlString(absExclude)}%'`);
  }

  const langFilter = filters?.language;
  if (typeof langFilter === "string" && langFilter) {
    const ext = langFilter.startsWith(".") ? langFilter : `.${langFilter}`;
    parts.push(`path LIKE '%${escapeSqlString(ext)}'`);
  }

  const roleFilter = filters?.role;
  if (typeof roleFilter === "string" && roleFilter) {
    parts.push(`role = '${escapeSqlString(roleFilter)}'`);
  }

  const projectRoots = filters?.project_roots;
  if (typeof projectRoots === "string" && projectRoots) {
    const roots = projectRoots.split(",");
    const clauses = roots.map((r) => {
      const prefix = r.endsWith("/") ? r : `${r}/`;
      return `path LIKE '${escapeSqlString(prefix)}%'`;
    });
    parts.push(`(${clauses.join(" OR ")})`);
  }

  const excludeRoots = filters?.exclude_project_roots;
  if (typeof excludeRoots === "string" && excludeRoots) {
    for (const r of excludeRoots.split(",")) {
      const prefix = r.endsWith("/") ? r : `${r}/`;
      parts.push(`path NOT LIKE '${escapeSqlString(prefix)}%'`);
    }
  }

  const defFilter = filters?.def;
  if (typeof defFilter === "string" && defFilter) {
    parts.push(
      `array_contains(defined_symbols, '${escapeSqlString(defFilter)}')`,
    );
  } else if (
    searchIntent.type === "DEFINITION" &&
    searchIntent.filters?.definitionsOnly
  ) {
    parts.push(
      `(role = 'DEFINITION' OR array_length(defined_symbols) > 0)`,
    );
  }

  const refFilter = filters?.ref;
  if (typeof refFilter === "string" && refFilter) {
    parts.push(
      `array_contains(referenced_symbols, '${escapeSqlString(refFilter)}')`,
    );
  }

  return parts.length > 0 ? parts.join(" AND ") : undefined;
}

export class Searcher {
  constructor(private db: VectorDB) {}

  private mapRecordToChunk(
    record: Partial<VectorRecord>,
    score: number,
  ): ChunkType {
    const toStrArray = (val?: unknown): string[] => {
      if (!val) return [];
      if (Array.isArray(val)) {
        return val.filter((v) => typeof v === "string");
      }
      if (typeof (val as any).toArray === "function") {
        try {
          const arr = (val as any).toArray();
          if (Array.isArray(arr))
            return arr.filter((v) => typeof v === "string");
          return Array.from(arr || []).filter((v) => typeof v === "string");
        } catch {
          return [];
        }
      }
      return [];
    };

    // 1. Aggressive Header Stripping
    // Prefer display_text (includes breadcrumbs/imports) but strip them for humans
    const cleanCode = record.display_text || record.content || "";

    // Split by lines
    const lines = cleanCode.split("\n");
    let startIdx = 0;

    // Skip lines that look like headers or imports
    // Heuristic: skip until we hit the first line that looks like code or a symbol breadcrumb
    let inImportBlock = false;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      if (line.startsWith("// File:")) continue;
      if (line.startsWith("File:")) continue; // Sometimes "File: ..." without comment
      if (line.startsWith("Imports:") || line.startsWith("Exports:")) continue;
      if (line === "---" || line === "(anchor)") continue;
      if (line.startsWith("//")) continue; // other header comments

      if (inImportBlock) {
        if (line.endsWith(";")) inImportBlock = false;
        continue;
      }
      if (line.startsWith("import ")) {
        inImportBlock = !line.endsWith(";");
        continue;
      }
      if (line.startsWith("from ")) continue; // Python/JS

      // If we hit something else, this is likely the start of code
      startIdx = i;
      break;
    }

    // Reassemble and Truncate
    const bodyLines = lines.slice(startIdx);
    const MAX_LINES = 15;
    let truncatedText = bodyLines.slice(0, MAX_LINES).join("\n");
    if (bodyLines.length > MAX_LINES) {
      truncatedText += `\n... (+${bodyLines.length - MAX_LINES} more lines)`;
    }

    // 2. Cap the Symbol Lists
    const MAX_SYMBOLS = 10;
    const truncate = (arr?: unknown) => {
      const arrVal = toStrArray(arr);
      if (arrVal.length <= MAX_SYMBOLS) return arrVal;
      return [
        ...arrVal.slice(0, MAX_SYMBOLS),
        `... (+${arrVal.length - MAX_SYMBOLS} more)`,
      ];
    };

    const definedSymbols = truncate(record.defined_symbols);
    const referencedSymbols = truncate(record.referenced_symbols);
    const imports = truncate(record.imports);
    const exports = truncate(record.exports);

    const startLine = record.start_line ?? 0;
    const endLine =
      typeof record.end_line === "number" ? record.end_line : startLine;

    const numLines = Math.max(1, endLine - startLine + 1);

    return {
      type: "text",
      text: truncatedText.trim(),
      score,
      metadata: {
        path: record.path || "",
        hash: record.hash || "",
        is_anchor: !!record.is_anchor,
      },
      generated_metadata: {
        start_line: startLine,
        end_line: endLine,
        num_lines: numLines,
        type: record.chunk_type,
      },
      complexity: record.complexity,
      is_exported: record.is_exported,
      role: record.role,
      parent_symbol: record.parent_symbol,

      // Truncate lists to save tokens
      defined_symbols: definedSymbols,
      referenced_symbols: referencedSymbols,
      imports,
      exports,
      summary: record.summary,
    };
  }

  private applyStructureBoost(
    record: Partial<VectorRecord>,
    score: number,
    intent?: SearchIntent,
  ): number {
    let adjusted = score;

    // Item 6: Anchors are recall helpers, not rank contenders
    if (record.is_anchor) {
      // Minimal penalty to break ties
      const anchorPenalty =
        Number.parseFloat(process.env.GMAX_ANCHOR_PENALTY ?? "") || 0.99;
      adjusted *= anchorPenalty;
    } else {
      // Only boost non-anchors
      const chunkType = record.chunk_type || "";
      const boosted = [
        "function",
        "class",
        "method",
        "interface",
        "type_alias",
      ];
      if (boosted.includes(chunkType)) {
        let boostFactor = 1.0;

        // Base boost
        boostFactor *= 1.1;

        // --- Role Boost ---
        if (record.role === "ORCHESTRATION") {
          boostFactor *= 1.5;
        } else if (record.role === "DEFINITION") {
          boostFactor *= 1.2;
        } else if (record.role === "IMPLEMENTATION") {
          boostFactor *= 1.1;
        }

        // --- Complexity/Orchestration Boost (User Requested) ---
        const refs = record.referenced_symbols?.length || 0;

        if (refs > 5) {
          // Small boost for non-trivial functions
          boostFactor *= 1.1;
        }
        if (refs > 15) {
          // Massive boost for Orchestrators
          boostFactor *= 1.25;
        }

        // Intent-based boosts
        if (intent) {
          if (intent.type === "DEFINITION" && record.role === "DEFINITION") {
            boostFactor *= 1.2;
          }
          if (intent.type === "FLOW" && record.role === "ORCHESTRATION") {
            boostFactor *= 1.4;
          }
          if (intent.type === "USAGE" && record.role === "IMPLEMENTATION") {
            boostFactor *= 1.2;
          }
        }

        adjusted *= boostFactor;
      }
    }

    if (record.role === "DOCS") {
      adjusted *= 0.6;
    }

    const pathStr = (record.path || "").toLowerCase();

    // Use path-segment and filename patterns to avoid false positives like "latest"
    const isTestPath =
      /(^|\/)(__tests__|tests?|specs?|benchmark)(\/|$)/i.test(pathStr) ||
      /\.(test|spec)\.[cm]?[jt]sx?$/i.test(pathStr);

    if (isTestPath) {
      const testPenalty =
        Number.parseFloat(process.env.GMAX_TEST_PENALTY ?? "") || 0.5;
      adjusted *= testPenalty;
    }
    if (
      pathStr.endsWith(".md") ||
      pathStr.endsWith(".mdx") ||
      pathStr.endsWith(".txt") ||
      pathStr.endsWith(".json") ||
      pathStr.endsWith(".lock") ||
      pathStr.includes("/docs/")
    ) {
      const docPenalty =
        Number.parseFloat(process.env.GMAX_DOC_PENALTY ?? "") || 0.6;
      adjusted *= docPenalty; // Downweight docs/data
    }
    // Import-only penalty
    if ((record.content || "").length < 50 && !record.is_exported) {
      adjusted *= 0.9;
    }

    return adjusted;
  }

  private deduplicateResults(
    results: { record: VectorRecord; score: number }[],
  ): { record: VectorRecord; score: number }[] {
    const seenIds = new Set<string>();
    const seenContent = new Map<string, { start: number; end: number }[]>();
    const deduped: { record: VectorRecord; score: number }[] = [];

    for (const item of results) {
      // Hard Dedup: ID
      if (item.record.id && seenIds.has(item.record.id)) continue;
      if (item.record.id) seenIds.add(item.record.id);

      // Overlap Dedup
      const path = item.record.path || "";
      const start = item.record.start_line || 0;
      const end = item.record.end_line || 0;
      const range = end - start;

      const existing = seenContent.get(path) || [];
      let isOverlapping = false;

      for (const other of existing) {
        const otherRange = other.end - other.start;
        const overlapStart = Math.max(start, other.start);
        const overlapEnd = Math.min(end, other.end);
        const overlap = Math.max(0, overlapEnd - overlapStart);

        // If overlap is > 50% of the smaller chunk
        if (overlap > 0.5 * Math.min(range, otherRange)) {
          isOverlapping = true;
          break;
        }
      }

      if (!isOverlapping) {
        deduped.push(item);
        existing.push({ start, end });
        seenContent.set(path, existing);
      }
    }
    return deduped;
  }

  private ftsIndexChecked = false;
  private ftsAvailable = false;
  private ftsLastCheckedAt = 0;
  private static readonly FTS_RETRY_INTERVAL_MS = 5 * 60 * 1000;

  async search(
    query: string,
    top_k?: number,
    _search_options?: { rerank?: boolean; explain?: boolean },
    _filters?: SearchFilter,
    pathPrefix?: string,
    intent?: SearchIntent,
    signal?: AbortSignal,
  ): Promise<SearchResponse> {
    const finalLimit = top_k ?? 10;
    const doRerank = _search_options?.rerank ?? true;
    const explain = _search_options?.explain ?? false;
    const searchIntent = intent || detectIntent(query);

    const pool = getWorkerPool();

    if (signal?.aborted) {
      const err = new Error("Aborted");
      err.name = "AbortError";
      throw err;
    }

    const {
      dense: queryVector,
      colbert: queryMatrixRaw,
      colbertDim,
      pooled_colbert_48d: queryPooled,
    } = await pool.encodeQuery(query, signal);

    if (signal?.aborted) {
      const err = new Error("Aborted");
      err.name = "AbortError";
      throw err;
    }

    if (colbertDim !== CONFIG.COLBERT_DIM) {
      throw new Error(
        `[Searcher] Query ColBERT dim (${colbertDim}) != Config (${CONFIG.COLBERT_DIM})`,
      );
    }

    const whereClause = buildWhereClause(pathPrefix, _filters, searchIntent);

    const envPreK = Number.parseInt(process.env.GMAX_PRE_K ?? "", 10);
    const PRE_RERANK_K =
      Number.isFinite(envPreK) && envPreK > 0
        ? envPreK
        : Math.max(finalLimit * 5, 500);
    let table: Table;
    try {
      table = await this.db.ensureTable();
    } catch {
      return { data: [] };
    }

    // Ensure FTS index exists (lazy init, retry periodically on failure)
    const now = Date.now();
    if (
      !this.ftsIndexChecked ||
      (!this.ftsAvailable &&
        now - this.ftsLastCheckedAt > Searcher.FTS_RETRY_INTERVAL_MS)
    ) {
      this.ftsIndexChecked = true;
      this.ftsLastCheckedAt = now;
      try {
        await this.db.createFTSIndex();
        this.ftsAvailable = true;
      } catch (e) {
        this.ftsAvailable = false;
        console.warn("[Searcher] Failed to ensure FTS index:", e);
      }
    }

    // Phase A: Lightweight retrieval — only columns needed for RRF, cosine, boost, dedup
    const LIGHTWEIGHT_COLUMNS = [
      "id", "path", "hash", "chunk_index", "start_line", "end_line",
      "is_anchor", "chunk_type", "role", "complexity", "is_exported",
      "content", "parent_symbol", "referenced_symbols", "pooled_colbert_48d",
    ];
    // _distance is auto-added by vectorSearch, _score by FTS — include each
    // in the respective query to suppress LanceDB deprecation warnings
    const VECTOR_COLUMNS = [...LIGHTWEIGHT_COLUMNS, "_distance"];
    const FTS_COLUMNS = [...LIGHTWEIGHT_COLUMNS, "_score"];

    let vectorQuery = table
      .vectorSearch(queryVector)
      .select(VECTOR_COLUMNS)
      .limit(PRE_RERANK_K);
    if (whereClause) {
      vectorQuery = vectorQuery.where(whereClause);
    }
    let vectorResults = (await vectorQuery.toArray()).map((r: any) => ({ ...r })) as VectorRecord[];

    let ftsResults: VectorRecord[] = [];
    let ftsSearchFailed = false;
    if (this.ftsAvailable) {
      try {
        let ftsQuery = table
          .search(query)
          .select(FTS_COLUMNS)
          .limit(PRE_RERANK_K);
        if (whereClause) {
          ftsQuery = ftsQuery.where(whereClause);
        }
        ftsResults = (await ftsQuery.toArray()).map((r: any) => ({ ...r })) as VectorRecord[];
      } catch (e) {
        ftsSearchFailed = true;
        this.ftsAvailable = false;
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.includes("position")) {
          // FTS index lacks positional data — rebuild it
          try {
            await this.db.createFTSIndex(true);
            this.ftsAvailable = true;
            console.warn("[Searcher] Rebuilt FTS index with position support — retry search");
          } catch {}
        } else {
          console.warn(`[Searcher] FTS search failed (will retry later): ${msg}`);
        }
      }
    }

    if (signal?.aborted) {
      const err = new Error("Aborted");
      err.name = "AbortError";
      throw err;
    }

    // Reciprocal Rank Fusion (vector + FTS)
    const RRF_K = 60;
    const candidateScores = new Map<string, number>();
    const docMap = new Map<string, VectorRecord>();

    vectorResults.forEach((doc, rank) => {
      const key = doc.id || `${doc.path}:${doc.chunk_index}`;
      docMap.set(key, doc);
      const score = 1.0 / (RRF_K + rank + 1);
      candidateScores.set(key, (candidateScores.get(key) || 0) + score);
    });

    ftsResults.forEach((doc, rank) => {
      const key = doc.id || `${doc.path}:${doc.chunk_index}`;
      if (!docMap.has(key)) docMap.set(key, doc);
      const score = 1.0 / (RRF_K + rank + 1);
      candidateScores.set(key, (candidateScores.get(key) || 0) + score);
    });

    const fused = Array.from(candidateScores.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([key]) => docMap.get(key))
      .filter(Boolean) as VectorRecord[];

    // Free raw search results — docMap holds the only needed references
    vectorResults.length = 0;
    ftsResults.length = 0;

    // Item 8: Widen PRE_RERANK_K
    // Retrieve a wide set for Stage 1 filtering
    const envStage1 = Number.parseInt(process.env.GMAX_STAGE1_K ?? "", 10);
    const STAGE1_K =
      Number.isFinite(envStage1) && envStage1 > 0 ? envStage1 : 200;
    const topCandidates = fused.slice(0, STAGE1_K);

    // Free docMap — topCandidates already holds record references
    docMap.clear();

    // Item 9: Two-stage rerank
    // Stage 1: Cheap pooled cosine filter
    let stage2Candidates = topCandidates;
    const envStage2K = Number.parseInt(process.env.GMAX_STAGE2_K ?? "", 10);
    const STAGE2_K =
      Number.isFinite(envStage2K) && envStage2K > 0 ? envStage2K : 40;

    const envRerankTop = Number.parseInt(process.env.GMAX_RERANK_TOP ?? "", 10);
    const RERANK_TOP =
      Number.isFinite(envRerankTop) && envRerankTop > 0 ? envRerankTop : 20;
    const envBlend = Number.parseFloat(process.env.GMAX_RERANK_BLEND ?? "");
    const FUSED_WEIGHT =
      Number.isFinite(envBlend) && envBlend >= 0 ? envBlend : 0.5;

    if (queryPooled && topCandidates.length > STAGE2_K) {
      const cosineScores = topCandidates.map((doc) => {
        if (!doc.pooled_colbert_48d) return -1;
        // Manual cosine sim since we don't have helper here easily
        // Assuming vectors are normalized (which they should be from orchestrator)
        let dot = 0;
        const docVec = doc.pooled_colbert_48d;
        for (let i = 0; i < queryPooled.length; i++) {
          dot += queryPooled[i] * (docVec[i] || 0);
        }
        return dot;
      });

      // Sort by cosine score and keep top N
      const withScore = topCandidates.map((doc, i) => ({
        doc,
        score: cosineScores[i],
      }));
      withScore.sort((a, b) => b.score - a.score);
      stage2Candidates = withScore.slice(0, STAGE2_K).map((x) => x.doc);
    }

    if (stage2Candidates.length === 0) {
      return { data: [] };
    }

    const rerankCandidates = stage2Candidates.slice(0, RERANK_TOP);

    // Phase B: Lazy-load colbert data only for the ~20 rerank candidates
    if (doRerank && rerankCandidates.length > 0) {
      const rerankIds = rerankCandidates
        .map((doc) => doc.id)
        .filter(Boolean)
        .map((id) => `'${escapeSqlString(id)}'`);
      if (rerankIds.length > 0) {
        const colbertRows = await table
          .query()
          .select(["id", "colbert", "colbert_scale", "doc_token_ids"])
          .where(`id IN (${rerankIds.join(",")})`)
          .limit(rerankIds.length)
          .toArray();
        const colbertMap = new Map(
          colbertRows.map((r: any) => [r.id, r]),
        );
        for (const doc of rerankCandidates) {
          const extra = colbertMap.get(doc.id);
          if (extra) {
            (doc as any).colbert = extra.colbert;
            (doc as any).colbert_scale = extra.colbert_scale;
            (doc as any).doc_token_ids = extra.doc_token_ids;
          }
        }
      }
    }

    const scores = doRerank
      ? await pool.rerank(
          {
            query: queryMatrixRaw,
            docs: rerankCandidates.map((doc) => ({
              colbert: (doc.colbert as Buffer | Int8Array | number[]) ?? [],
              scale:
                typeof doc.colbert_scale === "number" ? doc.colbert_scale : 1,
              token_ids: Array.isArray((doc as any).doc_token_ids)
                ? ((doc as any).doc_token_ids as number[])
                : undefined,
            })),
            colbertDim,
          },
          signal,
        )
      : rerankCandidates.map((doc, idx) => {
          // If rerank is disabled, fall back to fusion ordering with structural boost
          const key = doc.id || `${doc.path}:${doc.chunk_index}`;
          const fusedScore = candidateScores.get(key) ?? 0;
          // Small tie-breaker so later items don't all share 0
          return fusedScore || 1 / (idx + 1);
        });

    type ScoredItem = {
      record: (typeof rerankCandidates)[number];
      score: number;
      breakdown?: { rerank: number; fused: number; boost: number; normalized: number };
    };

    const scored: ScoredItem[] = rerankCandidates.map((doc, idx) => {
      const base = scores?.[idx] ?? 0;
      const key = doc.id || `${doc.path}:${doc.chunk_index}`;
      const fusedScore = candidateScores.get(key) ?? 0;
      const blended = base + FUSED_WEIGHT * fusedScore;
      const boosted = this.applyStructureBoost(doc, blended, searchIntent);
      return {
        record: doc,
        score: boosted,
        breakdown: explain
          ? { rerank: base, fused: fusedScore, boost: blended > 0 ? boosted / blended : 1, normalized: 0 }
          : undefined,
      };
    });

    // Note: "boosted" was not previously declared -- fix to use "scored"
    scored.sort((a: ScoredItem, b: ScoredItem) => b.score - a.score);

    // Item 11: Intelligent Deduplication
    const uniqueScored = this.deduplicateResults(scored);

    // Item 10: Per-file diversification
    const seenFiles = new Map<string, number>();
    const diversified: ScoredItem[] = [];
    const envMaxPerFile = Number.parseInt(
      process.env.GMAX_MAX_PER_FILE ?? "",
      10,
    );
    const MAX_PER_FILE =
      Number.isFinite(envMaxPerFile) && envMaxPerFile > 0 ? envMaxPerFile : 3;

    for (const item of uniqueScored) {
      const path = item.record.path || "";
      const count = seenFiles.get(path) || 0;
      if (count < MAX_PER_FILE) {
        diversified.push(item);
        seenFiles.set(path, count + 1);
      }
      if (diversified.length >= finalLimit) break;
    }

    // Phase C: Lazy-load display columns only for the final ~10 results
    const finalIds = diversified
      .map((item) => item.record.id)
      .filter(Boolean)
      .map((id) => `'${escapeSqlString(id)}'`);
    if (finalIds.length > 0) {
      const displayRows = await table
        .query()
        .select([
          "id", "display_text", "defined_symbols", "imports", "exports",
          "summary", "file_skeleton",
        ])
        .where(`id IN (${finalIds.join(",")})`)
        .limit(finalIds.length)
        .toArray();
      const displayMap = new Map(
        displayRows.map((r: any) => [r.id, r]),
      );
      for (const item of diversified) {
        const extra = displayMap.get(item.record.id);
        if (extra) {
          (item.record as any).display_text = extra.display_text;
          (item.record as any).defined_symbols = extra.defined_symbols;
          (item.record as any).imports = extra.imports;
          (item.record as any).exports = extra.exports;
          (item.record as any).summary = extra.summary;
          (item.record as any).file_skeleton = extra.file_skeleton;
        }
      }
    }

    const finalResults = diversified.map((item: ScoredItem) => ({
      ...item.record,
      _score: item.score,
      _breakdown: item.breakdown,
      vector: undefined,
      colbert: undefined,
    }));

    // Item 12: Score Calibration
    const maxScore = finalResults.length > 0 ? finalResults[0]._score : 1.0;

    return {
      data: finalResults.map((r: (typeof finalResults)[number]) => {
        const chunk = this.mapRecordToChunk(r, r._score || 0);

        // Normalize score relative to top result
        const normalized = maxScore > 0 ? r._score / maxScore : 0;

        let confidence: "High" | "Medium" | "Low" = "Low";
        if (normalized > 0.8) confidence = "High";
        else if (normalized > 0.5) confidence = "Medium";

        chunk.score = normalized;
        if ((r as any)._breakdown) {
          chunk.scoreBreakdown = { ...(r as any)._breakdown, normalized };
        }
        chunk.confidence = confidence;
        return chunk;
      }),
      ...(!this.ftsAvailable || ftsSearchFailed
        ? {
            warnings: [
              "Full-text search unavailable — results may be less precise",
            ],
          }
        : {}),
    };
  }
}
