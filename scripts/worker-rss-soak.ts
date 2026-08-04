import * as path from "node:path";
import fg from "fast-glob";
import { WorkerPool } from "../src/lib/workers/pool";

const modeArg = process.argv.find((arg) => arg.startsWith("--mode="));
const mode = modeArg?.slice("--mode=".length);
if (mode !== "gpu" && mode !== "cpu") {
  throw new Error("Usage: worker-rss-soak.ts --mode=gpu|cpu [--rounds=N]");
}

const roundsArg = process.argv.find((arg) => arg.startsWith("--rounds="));
const rounds = Number.parseInt(roundsArg?.slice("--rounds=".length) ?? "3", 10);
if (!Number.isFinite(rounds) || rounds < 1) {
  throw new Error("--rounds must be a positive integer");
}

function percentile(sorted: readonly number[], fraction: number): number {
  return sorted[Math.ceil(sorted.length * fraction) - 1] ?? 0;
}

async function main(): Promise<void> {
  if (mode === "gpu") {
    const health = await fetch("http://127.0.0.1:8100/health", {
      signal: AbortSignal.timeout(3_000),
    }).catch(() => null);
    if (!health?.ok) {
      throw new Error(
        "MLX mode requires a healthy existing server on 127.0.0.1:8100",
      );
    }
  }

  const root = process.cwd();
  const files = (
    await fg(["src/**/*.ts", "tests/**/*.ts", "scripts/**/*.ts"], {
      cwd: root,
      absolute: true,
      onlyFiles: true,
      ignore: ["**/*.d.ts"],
    })
  ).sort();

  if (files.length === 0) throw new Error("No TypeScript files found");

  const pool = new WorkerPool(undefined, mode);
  const samples: number[] = [];
  let tasks = 0;

  try {
    for (let round = 0; round < rounds; round++) {
      for (const absolutePath of files) {
        await pool.processFile({
          path: path.relative(root, absolutePath),
          absolutePath,
          projectRoot: root,
        });
        tasks++;
        const stats = pool.getWorkerMemoryStats();
        if (stats.length !== 1 || stats[0].rssBytes <= 0) {
          throw new Error(
            `Expected one reporting worker, got ${JSON.stringify(stats)}`,
          );
        }
        samples.push(stats[0].rssBytes / 1024 / 1024);
      }
    }

    const warmSamples = samples.slice(files.length);
    const measured = warmSamples.length > 0 ? warmSamples : samples;
    const sorted = [...measured].sort((a, b) => a - b);
    console.log(
      JSON.stringify(
        {
          mode,
          files: files.length,
          rounds,
          tasks,
          warmupSamplesDiscarded: samples.length - measured.length,
          rssMb: {
            min: Number(sorted[0].toFixed(1)),
            p50: Number(percentile(sorted, 0.5).toFixed(1)),
            p95: Number(percentile(sorted, 0.95).toFixed(1)),
            max: Number(sorted.at(-1)!.toFixed(1)),
          },
        },
        null,
        2,
      ),
    );
  } finally {
    await pool.destroy({ requireExit: true });
  }
}

void main();
