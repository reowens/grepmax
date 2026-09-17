import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { PATHS } from "../../config";
import type { VectorDB } from "../store/vector-db";
import { pathStartsWith } from "../utils/filter-builder";

export interface PageRankGraph {
  nodes: string[];
  edges: Map<string, Set<string>>;
}

interface PageRankCacheFile {
  pathPrefix: string;
  computedAt: string;
  nodeCount: number;
  scores: Record<string, number>;
}

interface CachedScores {
  scores: Map<string, number>;
  max: number;
  computedAt: number;
}

const DEFAULT_DAMPING = 0.85;
const DEFAULT_MAX_ITER = 50;
const DEFAULT_TOL = 1e-6;
const DEFAULT_TTL_MS = 60 * 60 * 1000;

/**
 * Row cap for the graph scan. Matches `graph.audit`'s AUDIT_ROW_LIMIT: the
 * largest indexed project holds ~270k chunks, so this never truncates a real
 * project, but a runaway prefix (a home directory, a monorepo root) can no
 * longer pull millions of symbol-array rows into daemon memory at once. A
 * truncated scan ranks the symbols it saw; the ranking is a search boost, not
 * an answer, so a partial graph degrades gracefully.
 */
export const PAGERANK_ROW_LIMIT = 500_000;

/**
 * Score maps stay in the daemon for its lifetime, one per scoped prefix a
 * search has used (`--in` makes those open-ended). Keep the most recently
 * used few; each is a Map over every defined symbol in its scope.
 */
export const PAGERANK_MEMORY_CACHE_MAX = 8;

// Map iteration order is insertion order, so re-inserting on a hit makes the
// first key the least recently used.
const memoryCache = new Map<string, CachedScores>();
// Concurrent searches on a cold prefix share one scan instead of each running
// their own.
const inFlight = new Map<
  string,
  Promise<{ scores: Map<string, number>; max: number }>
>();

function memoryGet(pathPrefix: string): CachedScores | undefined {
  const entry = memoryCache.get(pathPrefix);
  if (!entry) return undefined;
  memoryCache.delete(pathPrefix);
  if (Date.now() - entry.computedAt >= getTtlMs()) return undefined;
  memoryCache.set(pathPrefix, entry);
  return entry;
}

function memorySet(pathPrefix: string, entry: CachedScores): void {
  memoryCache.delete(pathPrefix);
  memoryCache.set(pathPrefix, entry);
  const ttl = getTtlMs();
  const now = Date.now();
  for (const [key, value] of memoryCache) {
    if (now - value.computedAt >= ttl) memoryCache.delete(key);
  }
  while (memoryCache.size > PAGERANK_MEMORY_CACHE_MAX) {
    const oldest = memoryCache.keys().next().value as string;
    memoryCache.delete(oldest);
  }
}

export function computePageRank(
  graph: PageRankGraph,
  damping = DEFAULT_DAMPING,
  maxIter = DEFAULT_MAX_ITER,
  tol = DEFAULT_TOL,
): Map<string, number> {
  const N = graph.nodes.length;
  const result = new Map<string, number>();
  if (N === 0) return result;

  const idx = new Map<string, number>();
  for (let i = 0; i < N; i++) idx.set(graph.nodes[i], i);

  const outNeighbors: number[][] = Array.from({ length: N }, () => []);
  for (const [src, targets] of graph.edges) {
    const si = idx.get(src);
    if (si === undefined) continue;
    const seen = new Set<number>();
    for (const tgt of targets) {
      const ti = idx.get(tgt);
      if (ti === undefined || ti === si || seen.has(ti)) continue;
      seen.add(ti);
      outNeighbors[si].push(ti);
    }
  }

  const outDegree = new Int32Array(N);
  for (let i = 0; i < N; i++) outDegree[i] = outNeighbors[i].length;

  const inNeighbors: number[][] = Array.from({ length: N }, () => []);
  for (let i = 0; i < N; i++) {
    for (const j of outNeighbors[i]) inNeighbors[j].push(i);
  }

  let pr = new Float64Array(N).fill(1 / N);
  let next = new Float64Array(N);
  const teleport = (1 - damping) / N;

  for (let iter = 0; iter < maxIter; iter++) {
    let dangling = 0;
    for (let i = 0; i < N; i++) {
      if (outDegree[i] === 0) dangling += pr[i];
    }
    const danglingShare = (damping * dangling) / N;

    for (let i = 0; i < N; i++) {
      let sum = 0;
      const ins = inNeighbors[i];
      for (let k = 0; k < ins.length; k++) {
        const j = ins[k];
        sum += pr[j] / outDegree[j];
      }
      next[i] = teleport + danglingShare + damping * sum;
    }

    let delta = 0;
    for (let i = 0; i < N; i++) delta += Math.abs(next[i] - pr[i]);

    const tmp = pr;
    pr = next;
    next = tmp;

    if (delta < tol) break;
  }

  for (let i = 0; i < N; i++) result.set(graph.nodes[i], pr[i]);
  return result;
}

function toStringArray(val: unknown): string[] {
  if (!val) return [];
  if (Array.isArray(val))
    return val.filter((v): v is string => typeof v === "string");
  const maybe = val as { toArray?: () => unknown };
  if (typeof maybe.toArray === "function") {
    try {
      const arr = maybe.toArray();
      return Array.isArray(arr)
        ? arr.filter((v): v is string => typeof v === "string")
        : [];
    } catch {
      return [];
    }
  }
  return [];
}

export async function buildGraphFromDb(
  db: VectorDB,
  pathPrefix: string,
): Promise<PageRankGraph> {
  const table = await db.ensureTable();
  const prefix = pathPrefix.endsWith("/") ? pathPrefix : `${pathPrefix}/`;
  const rows = await table
    .query()
    .select(["defined_symbols", "referenced_symbols"])
    .where(pathStartsWith(prefix))
    .limit(PAGERANK_ROW_LIMIT)
    .toArray();

  const nodes = new Set<string>();
  const edges = new Map<string, Set<string>>();

  for (const row of rows) {
    const defs = toStringArray(
      (row as { defined_symbols?: unknown }).defined_symbols,
    );
    const refs = toStringArray(
      (row as { referenced_symbols?: unknown }).referenced_symbols,
    );
    for (const d of defs) nodes.add(d);
    if (refs.length === 0) continue;
    for (const d of defs) {
      let set = edges.get(d);
      if (!set) {
        set = new Set();
        edges.set(d, set);
      }
      for (const r of refs) set.add(r);
    }
  }

  return { nodes: Array.from(nodes), edges };
}

function cachePathFor(pathPrefix: string): string {
  const hash = crypto
    .createHash("sha1")
    .update(pathPrefix)
    .digest("hex")
    .slice(0, 16);
  return path.join(PATHS.globalRoot, "pagerank", `${hash}.json`);
}

function getTtlMs(): number {
  const env = Number.parseInt(process.env.GMAX_PAGERANK_TTL_MS ?? "", 10);
  return Number.isFinite(env) && env > 0 ? env : DEFAULT_TTL_MS;
}

function readDiskCache(pathPrefix: string): CachedScores | null {
  const file = cachePathFor(pathPrefix);
  if (!fs.existsSync(file)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf8")) as PageRankCacheFile;
    const computedAt = Date.parse(data.computedAt);
    if (!Number.isFinite(computedAt)) return null;
    if (Date.now() - computedAt > getTtlMs()) return null;
    const scores = new Map<string, number>();
    let max = 0;
    for (const [k, v] of Object.entries(data.scores)) {
      const n = Number(v);
      if (!Number.isFinite(n)) continue;
      scores.set(k, n);
      if (n > max) max = n;
    }
    return { scores, max, computedAt };
  } catch {
    return null;
  }
}

export function writeDiskCache(
  pathPrefix: string,
  scores: Map<string, number>,
): void {
  const file = cachePathFor(pathPrefix);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const obj: PageRankCacheFile = {
    pathPrefix,
    computedAt: new Date().toISOString(),
    nodeCount: scores.size,
    scores: Object.fromEntries(scores),
  };
  fs.writeFileSync(file, JSON.stringify(obj), "utf8");
}

export async function loadOrComputePageRank(
  db: VectorDB,
  pathPrefix: string,
): Promise<{ scores: Map<string, number>; max: number }> {
  const mem = memoryGet(pathPrefix);
  if (mem) return { scores: mem.scores, max: mem.max };
  const pending = inFlight.get(pathPrefix);
  if (pending) return pending;
  const task = (async () => {
    const disk = readDiskCache(pathPrefix);
    if (disk) {
      memorySet(pathPrefix, disk);
      return { scores: disk.scores, max: disk.max };
    }
    const graph = await buildGraphFromDb(db, pathPrefix);
    const scores = computePageRank(graph);
    let max = 0;
    for (const v of scores.values()) if (v > max) max = v;
    memorySet(pathPrefix, { scores, max, computedAt: Date.now() });
    try {
      writeDiskCache(pathPrefix, scores);
    } catch {}
    return { scores, max };
  })();
  inFlight.set(pathPrefix, task);
  try {
    return await task;
  } finally {
    inFlight.delete(pathPrefix);
  }
}

export function pageRankBoostForSymbols(
  symbols: string[] | undefined,
  scores: Map<string, number>,
  max: number,
): number {
  if (!symbols || symbols.length === 0 || max <= 0) return 0;
  let best = 0;
  for (const s of symbols) {
    const v = scores.get(s);
    if (v !== undefined && v > best) best = v;
  }
  return best / max;
}

export function _clearMemoryCacheForTests(): void {
  memoryCache.clear();
  inFlight.clear();
}

export function _memoryCacheKeysForTests(): string[] {
  return [...memoryCache.keys()];
}

export function _cachePathForTests(pathPrefix: string): string {
  return cachePathFor(pathPrefix);
}
