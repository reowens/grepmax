import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

type LanceModule = typeof import("@lancedb/lancedb");

const args = new Map(
  process.argv.slice(2).map((arg) => {
    const [key, ...value] = arg.replace(/^--/, "").split("=");
    return [key, value.join("=")];
  }),
);

const storeDir = args.get("store");
const moduleRoot = args.get("module-root");
const label = args.get("label");
const output = args.get("output");
const iterations = Number.parseInt(args.get("iterations") ?? "100", 10);
const qualifyingCycles = Number.parseInt(args.get("cycles") ?? "12", 10);
const fragmentsPerCycle = Number.parseInt(args.get("fragments") ?? "55", 10);

if (!storeDir || !moduleRoot || !label || !output) {
  throw new Error(
    "Usage: lancedb-fts-soak.ts --store=DIR --module-root=DIR --label=NAME --output=FILE [--scope=PROJECT_ROOT]",
  );
}

if (
  !Number.isFinite(iterations) ||
  !Number.isFinite(qualifyingCycles) ||
  !Number.isFinite(fragmentsPerCycle) ||
  iterations < 1 ||
  qualifyingCycles < 1 ||
  fragmentsPerCycle < 51 ||
  qualifyingCycles > iterations
) {
  throw new Error("Invalid soak counts");
}

// Narrowed above, but the `emit` closure below doesn't inherit that narrowing.
const outputFile: string = output;

// Golden probes must query a stable, populated slice of the snapshot. Default to
// the project this script is run from; --scope targets a different indexed root.
const scopeRoot = path.resolve(args.get("scope") || process.cwd());
const scopePrefix = scopeRoot.endsWith("/") ? scopeRoot : `${scopeRoot}/`;
const scopeFilter = `starts_with(path, '${scopePrefix.replace(/'/g, "''")}')`;

const requireFromRuntime = createRequire(path.join(moduleRoot, "package.json"));
const lanceEntry = requireFromRuntime.resolve("@lancedb/lancedb");
const lancedb = (await import(pathToFileURL(lanceEntry).href)) as LanceModule;
const packageJson = JSON.parse(
  fs.readFileSync(path.join(path.dirname(lanceEntry), "..", "package.json"), "utf8"),
) as { version: string };

function hashIds(rows: Array<Record<string, unknown>>): string {
  return createHash("sha256")
    .update(rows.map((row) => String(row.id)).join("\n"))
    .digest("hex");
}

function emit(event: Record<string, unknown>): void {
  const record = { timestamp: new Date().toISOString(), label, ...event };
  fs.appendFileSync(outputFile, `${JSON.stringify(record)}\n`);
  console.log(JSON.stringify(record));
}

async function probes(table: any, vector: number[]) {
  const fts = await table
    .search("VectorDB")
    .select(["id", "path", "_score"])
    .where(scopeFilter)
    .limit(20)
    .toArray();
  const exact = await table
    .vectorSearch(vector)
    .column("vector")
    .bypassVectorIndex()
    .select(["id", "path", "_distance"])
    .where(scopeFilter)
    .limit(20)
    .toArray();
  return {
    ftsHash: hashIds(fts),
    ftsIds: fts.map((row: Record<string, unknown>) => String(row.id)),
    exactHash: hashIds(exact),
    exactIds: exact.map((row: Record<string, unknown>) => String(row.id)),
  };
}

function row(id: string, vectorDim: number) {
  return {
    id,
    path: `/__gmax_fts_soak__/${label}/${id}.ts`,
    hash: `hash-${id}`,
    content: `isolated fts maintenance marker ${label} ${id}`,
    display_text: "",
    start_line: 1,
    end_line: 1,
    vector: new Array(vectorDim).fill(0),
    chunk_index: 0,
    is_anchor: false,
    context_prev: "",
    context_next: "",
    chunk_type: "function",
    complexity: 1,
    is_exported: false,
    colbert: Buffer.alloc(0),
    colbert_scale: 1,
    pooled_colbert_48d: new Array(48).fill(0),
    doc_token_ids: [],
    defined_symbols: [],
    referenced_symbols: [],
    type_referenced_symbols: [],
    member_referenced_symbols: [],
    imports: [],
    exports: [],
    role: "",
    parent_symbol: "",
    file_skeleton: "",
    summary: "",
  };
}

const db = await lancedb.connect(storeDir);
let table = await db.openTable("chunks");
const schema = await table.schema();
const vectorField = schema.fields.find((field: any) => field.name === "vector");
const vectorDim = Number(vectorField?.type?.listSize);
if (!Number.isFinite(vectorDim) || vectorDim < 1) {
  throw new Error("Could not determine vector dimension");
}

const seedRows = await table
  .query()
  .select(["id", "vector"])
  .where(scopeFilter)
  .limit(1)
  .toArray();
if (seedRows.length === 0)
  throw new Error(`Golden probe seed row not found under ${scopePrefix}`);
const probeVector = Array.from(seedRows[0].vector as ArrayLike<number>);
const golden = await probes(table, probeVector);
const initialStats = await table.stats();
emit({
  type: "start",
  lanceVersion: packageJson.version,
  storeDir,
  scopeRoot: scopePrefix,
  iterations,
  qualifyingCycles,
  fragmentsPerCycle,
  rows: await table.countRows(),
  stats: initialStats,
  golden,
});

let previousIds: string[] = [];
let panicCount = 0;
let rebuildFailureCount = 0;
let correctnessMismatchCount = 0;
const latenciesMs: number[] = [];

for (let iteration = 0; iteration < iterations; iteration++) {
  const qualifying = iteration < qualifyingCycles;
  const writes = qualifying ? fragmentsPerCycle : 1;
  const currentIds: string[] = [];
  for (let fragment = 0; fragment < writes; fragment++) {
    const id = `soak-${label}-${iteration}-${fragment}`;
    currentIds.push(id);
    await table.add([row(id, vectorDim)]);
  }
  await table.update({
    where: `id = '${currentIds[0]}'`,
    values: { summary: `updated-${iteration}` },
  });
  if (previousIds.length > 0) {
    await table.delete(
      `id IN (${previousIds.map((id) => `'${id}'`).join(",")})`,
    );
  }

  table = await db.openTable("chunks");
  const before = await table.stats();
  const started = performance.now();
  let optimizeError: string | null = null;
  let recoveryError: string | null = null;
  try {
    await table.optimize({ cleanupOlderThan: new Date(), deleteUnverified: true });
  } catch (error) {
    optimizeError = error instanceof Error ? error.stack ?? error.message : String(error);
    if (optimizeError.includes("Panic")) panicCount++;
    try {
      await table.createIndex("content", {
        config: lancedb.Index.fts({ withPosition: true }),
        name: "content_idx",
        replace: true,
      });
      await table.optimize({ cleanupOlderThan: new Date(), deleteUnverified: true });
    } catch (recovery) {
      recoveryError =
        recovery instanceof Error ? recovery.stack ?? recovery.message : String(recovery);
      rebuildFailureCount++;
    }
  }
  const latencyMs = performance.now() - started;
  latenciesMs.push(latencyMs);
  table = await db.openTable("chunks");
  const after = await table.stats();
  const currentProbes = qualifying || iteration === iterations - 1
    ? await probes(table, probeVector)
    : null;
  const correctnessMismatch =
    currentProbes !== null &&
    (currentProbes.ftsHash !== golden.ftsHash ||
      currentProbes.exactHash !== golden.exactHash);
  if (correctnessMismatch) correctnessMismatchCount++;
  emit({
    type: "iteration",
    iteration: iteration + 1,
    qualifying,
    writes,
    before,
    after,
    latencyMs: Number(latencyMs.toFixed(1)),
    rssMb: Number((process.memoryUsage().rss / 1024 / 1024).toFixed(1)),
    optimizeError,
    recoveryError,
    correctnessMismatch,
    probes: currentProbes,
  });
  previousIds = currentIds;
}

latenciesMs.sort((a, b) => a - b);
emit({
  type: "summary",
  lanceVersion: packageJson.version,
  panicCount,
  rebuildFailureCount,
  correctnessMismatchCount,
  latencyMs: {
    p50: Number(latenciesMs[Math.ceil(latenciesMs.length * 0.5) - 1].toFixed(1)),
    p95: Number(latenciesMs[Math.ceil(latenciesMs.length * 0.95) - 1].toFixed(1)),
    max: Number(latenciesMs.at(-1)!.toFixed(1)),
  },
  finalRows: await table.countRows(),
  finalStats: await table.stats(),
});
