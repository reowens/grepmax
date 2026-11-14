// Replays recent edits of a git repository through gmax's chunking and row
// preparation, without embedding, and reports how many rows an edit keeps.
// Reads the repository with git only; writes nothing and loads no model.
//
//   npx tsx scripts/replay-row-keep.ts <repo> <edits> [rev] [--build]
//
// Edits are walked back from `rev` (default HEAD), which the output names so a
// second run can replay the same edits.
// --build counts kept rows through the indexer's own keepStoredRows; without it
// the script counts the same rule with its own multiset match.
import { execFileSync } from "node:child_process";
import * as path from "node:path";
import { type ChunkWithContext, TreeSitterChunker } from "../src/lib/index/chunker";
import { embeddingReuseKey } from "../src/lib/index/embedding-reuse";
import { ProjectFilePolicy } from "../src/lib/index/file-policy";
import {
  keepStoredRows,
  keptRowFields,
  keptRowKey,
} from "../src/lib/index/kept-rows";
import { chunkSource, prepareChunks } from "../src/lib/index/prepared-chunks";
import { Skeletonizer } from "../src/lib/skeleton";
import type { PreparedChunk, VectorRecord } from "../src/lib/store/types";
import {
  computeContentHash,
  hasNullByte,
  isGeneratedContent,
  isIndexableFile,
} from "../src/lib/utils/file-utils";

const [repoArg, countArg, revArg = "HEAD"] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const useBuild = process.argv.includes("--build");
if (!repoArg || !countArg) {
  console.error("usage: replay-row-keep.ts <repo> <edits> [rev] [--build]");
  process.exit(2);
}
const repo = path.resolve(repoArg);
const wanted = Number.parseInt(countArg, 10);

const git = (args: string[], encoding: "utf8" | "buffer" = "utf8") =>
  execFileSync("git", ["-C", repo, ...args], {
    encoding: encoding === "utf8" ? "utf8" : undefined,
    maxBuffer: 1 << 30,
  });

type Edit = { commit: string; file: string; before: string; after: string };

const rev = (git(["rev-parse", "--verify", `${revArg}^{commit}`]) as string).trim();

function* recentEdits(): Generator<Edit> {
  const log = git([
    "log",
    "--no-merges",
    "--raw",
    "--no-abbrev",
    "--no-renames",
    "--format=%x00%H",
    "-n",
    "5000",
    rev,
  ]) as string;
  for (const block of log.split("\0").slice(1)) {
    const [commit, ...lines] = block.trim().split("\n");
    for (const line of lines) {
      const m = /^:\d+ \d+ ([0-9a-f]+) ([0-9a-f]+) M\t(.+)$/.exec(line);
      if (m) yield { commit, before: m[1], after: m[2], file: m[3] };
    }
  }
}

const POSITION = ["start_line", "end_line", "chunk_index"] as const;
const NEIGHBOURS = ["context_prev", "context_next"] as const;

// The row-prep columns that come from the whole file rather than the chunk.
function fileLevel(chunk: ChunkWithContext, row: PreparedChunk) {
  return JSON.stringify([chunk.imports ?? [], row.file_skeleton ?? ""]);
}

// The chunk's own text: what formatChunkText adds besides path and imports.
function ownText(chunk: ChunkWithContext) {
  return JSON.stringify([chunk.context, chunk.content, chunk.docstring ?? ""]);
}

type Prepared = { chunks: ChunkWithContext[]; rows: PreparedChunk[] };

async function main() {
  const chunker = new TreeSitterChunker();
  const skeletonizer = new Skeletonizer();
  await Promise.all([chunker.init(), skeletonizer.init()]);
  const policy = new ProjectFilePolicy(repo);

  async function indexable(abs: string): Promise<boolean> {
    let dir = path.dirname(abs);
    const dirs: string[] = [];
    while (dir.startsWith(repo)) {
      dirs.push(dir);
      if (dir === repo) break;
      dir = path.dirname(dir);
    }
    for (const d of dirs.reverse()) {
      try {
        await policy.ignoreRules(d);
      } catch {}
    }
    return !policy.isIgnoredByLoadedPolicy(abs);
  }

  async function prepare(abs: string, blob: string): Promise<Prepared | null> {
    const buffer = git(["show", blob], "buffer") as Buffer;
    if (
      !isIndexableFile(abs, buffer.length) ||
      buffer.length === 0 ||
      hasNullByte(buffer) ||
      isGeneratedContent(buffer, abs)
    )
      return null;
    const content = buffer.toString("utf-8");
    const [chunks, skeleton] = await Promise.all([
      chunkSource(chunker, abs, content),
      skeletonizer.skeletonizeFile(abs, content, { includeSummary: true }),
    ]);
    if (!chunks.length) return null;
    const rows = prepareChunks(
      abs,
      computeContentHash(buffer, abs),
      chunks,
      skeleton.success ? skeleton.skeleton : undefined,
    );
    return { chunks, rows };
  }

  const multiset = (keys: string[]) => {
    const m = new Map<string, number>();
    for (const k of keys) m.set(k, (m.get(k) ?? 0) + 1);
    return m;
  };
  const take = (m: Map<string, number>, k: string) => {
    const n = m.get(k) ?? 0;
    if (n === 0) return false;
    m.set(k, n - 1);
    return true;
  };
  const looseKey = (row: PreparedChunk) => {
    const f: Record<string, unknown> = keptRowFields(row);
    for (const c of [...POSITION, ...NEIGHBOURS]) delete f[c];
    return JSON.stringify(f);
  };

  type FileResult = { ext: string; after: number; kept: number; loose: number };
  const files: FileResult[] = [];
  const reasons = {
    position: 0,
    neighbours: 0,
    fileLevel: 0,
    anchor: 0,
    ownText: 0,
    other: 0,
  };
  let scanned = 0;

  for (const edit of recentEdits()) {
    if (files.length >= wanted) break;
    scanned++;
    const abs = path.join(repo, edit.file);
    if (!(await indexable(abs))) continue;
    const before = await prepare(abs, edit.before);
    const after = await prepare(abs, edit.after);
    if (!before || !after) continue;

    let kept: number;
    const keptAfter = new Set<number>();
    if (useBuild) {
      // The worker reuses an embedding exactly when the content matches.
      const stored = before.rows.map((row, i) => ({
        id: String(i),
        key: keptRowKey(row),
      }));
      const reusable = new Set(before.rows.map((r) => embeddingReuseKey(r.content)));
      const reused = after.rows.flatMap((r, i) =>
        reusable.has(embeddingReuseKey(r.content)) ? [i] : [],
      );
      const write = keepStoredRows(after.rows as VectorRecord[], reused, stored);
      kept = write.keptIds.length;
      const written = new Set(write.records);
      after.rows.forEach((r, i) => {
        if (!written.has(r as VectorRecord)) keptAfter.add(i);
      });
    } else {
      const pool = multiset(before.rows.map(keptRowKey));
      after.rows.forEach((r, i) => {
        if (take(pool, keptRowKey(r))) keptAfter.add(i);
      });
      kept = keptAfter.size;
    }

    const loosePool = multiset(before.rows.map(looseKey));
    let loose = 0;
    for (const r of after.rows) if (take(loosePool, looseKey(r))) loose++;

    // For each row not kept, compare it with an unkept before-row that has
    // the same own text, and name the column groups that differ.
    const keptBefore = multiset(after.rows.filter((_, i) => keptAfter.has(i)).map(keptRowKey));
    const candidates = new Map<string, number[]>();
    before.rows.forEach((row, i) => {
      if (take(keptBefore, keptRowKey(row))) return;
      const k = ownText(before.chunks[i]);
      candidates.set(k, [...(candidates.get(k) ?? []), i]);
    });
    after.rows.forEach((row, i) => {
      if (keptAfter.has(i)) return;
      const chunk = after.chunks[i];
      if (row.is_anchor) {
        reasons.anchor++;
        return;
      }
      const j = candidates.get(ownText(chunk))?.shift();
      if (j === undefined) {
        reasons.ownText++;
        return;
      }
      const a = keptRowFields(row) as Record<string, unknown>;
      const b = keptRowFields(before.rows[j]) as Record<string, unknown>;
      const differs = (cols: readonly string[]) =>
        cols.some((c) => JSON.stringify(a[c]) !== JSON.stringify(b[c]));
      const groups = {
        position: differs(POSITION),
        neighbours: differs(NEIGHBOURS),
        fileLevel:
          fileLevel(chunk, row) !== fileLevel(before.chunks[j], before.rows[j]),
      };
      for (const [group, differed] of Object.entries(groups))
        if (differed) reasons[group as keyof typeof groups]++;
      if (!Object.values(groups).some(Boolean)) reasons.other++;
    });

    files.push({
      ext: path.extname(edit.file).toLowerCase() || path.basename(edit.file),
      after: after.rows.length,
      kept,
      loose,
    });
  }

  const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
  const median = (xs: number[]) => {
    if (!xs.length) return 0;
    const s = [...xs].sort((a, b) => a - b);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  };
  const pct = (a: number, b: number) =>
    b ? `${((100 * a) / b).toFixed(1)}%` : "n/a";
  const totals = (fs: FileResult[]) => {
    const after = sum(fs.map((f) => f.after));
    const kept = sum(fs.map((f) => f.kept));
    const loose = sum(fs.map((f) => f.loose));
    return { after, kept, loose };
  };

  const t = totals(files);
  const notKept = t.after - t.kept;
  console.log(`from ${rev}`);
  console.log(`repo edits replayed: ${files.length} (of ${scanned} modified files scanned)`);
  console.log(`mode: ${useBuild ? "build (keepStoredRows)" : "replay multiset"}`);
  console.log("");
  console.log(`rows after the edits:                     ${t.after}`);
  console.log(`kept (equal except id, hash):             ${t.kept} (${pct(t.kept, t.after)})`);
  console.log(`keepable ignoring position and neighbours: ${t.loose} (${pct(t.loose, t.after)})`);
  console.log(`written:                                  ${notKept} (${pct(notKept, t.after)})`);
  console.log("");
  console.log("rows not kept, by the column groups that differ (a row can count in several):");
  console.log(`  own text (no before-row with the same chunk text): ${reasons.ownText}`);
  console.log(`  anchor row (file-level):                           ${reasons.anchor}`);
  console.log(`  position (start_line, end_line, chunk_index):      ${reasons.position}`);
  console.log(`  neighbours (context_prev, context_next):           ${reasons.neighbours}`);
  console.log(`  file-level (imports in content, file_skeleton):    ${reasons.fileLevel}`);
  console.log(`  other columns only:                                ${reasons.other}`);
  console.log("");
  console.log("per file median:");
  console.log(`  rows after: ${median(files.map((f) => f.after))}`);
  console.log(`  kept:       ${median(files.map((f) => f.kept))}`);
  console.log(`  written:    ${median(files.map((f) => f.after - f.kept))}`);
  console.log(
    `  kept share: ${(100 * median(files.map((f) => (f.after ? f.kept / f.after : 0)))).toFixed(1)}%`,
  );
  console.log("");
  console.log("by extension: files, rows after, kept, keepable ignoring position+neighbours, median written per file");
  const byExt = new Map<string, FileResult[]>();
  for (const f of files) byExt.set(f.ext, [...(byExt.get(f.ext) ?? []), f]);
  for (const [ext, fs] of [...byExt].sort((a, b) => b[1].length - a[1].length)) {
    const e = totals(fs);
    console.log(
      `  ${ext.padEnd(10)} ${String(fs.length).padStart(4)} ${String(e.after).padStart(7)} ${String(e.kept).padStart(7)} ${pct(e.kept, e.after).padStart(6)} ${String(e.loose).padStart(7)} ${pct(e.loose, e.after).padStart(6)} ${String(median(fs.map((f) => f.after - f.kept))).padStart(6)}`,
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
