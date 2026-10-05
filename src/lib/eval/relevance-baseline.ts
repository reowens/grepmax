import { createHash } from "node:crypto";
import * as path from "node:path";
import { z } from "zod";
import type { ChunkType, SearchResponse } from "../store/types";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const targetSchema = z
  .object({
    file: z.string().min(1),
    symbol: z.string().min(1),
    match: z.enum(["symbol-or-range", "range"]).optional(),
    startLine: z.number().int().positive(),
    endLine: z.number().int().positive(),
    sourceSha256: digest,
  })
  .strict()
  .refine((t) => t.endLine >= t.startLine, "Reversed target range");

export const relevanceFixtureSchema = z
  .object({
    schemaVersion: z.literal(1),
    createdAt: z.string().min(1),
    purpose: z.string().min(1),
    corpora: z
      .array(
        z
          .object({
            id: z.string().min(1),
            root: z.string().min(1),
            language: z.string().min(1),
          })
          .strict(),
      )
      .min(1),
    cases: z
      .array(
        z
          .object({
            id: z.string().min(1),
            corpus: z.string().min(1),
            split: z.enum(["dev", "heldout"]),
            origin: z.enum(["curated-source", "observed-session"]),
            intent: z.string().min(1),
            query: z.string().min(1),
            expected: z.array(targetSchema).min(1),
          })
          .strict(),
      )
      .min(1),
  })
  .strict()
  .superRefine((fixture, ctx) => {
    for (const values of [fixture.corpora, fixture.cases]) {
      if (new Set(values.map((v) => v.id)).size !== values.length) {
        ctx.addIssue({ code: "custom", message: "Duplicate fixture IDs" });
      }
    }
    for (const c of fixture.cases) {
      if (!fixture.corpora.some((r) => r.id === c.corpus)) {
        ctx.addIssue({
          code: "custom",
          message: `Unknown corpus: ${c.corpus}`,
        });
      }
      for (const target of c.expected) {
        if (
          path.isAbsolute(target.file) ||
          target.file.split(/[\\/]/).includes("..")
        ) {
          ctx.addIssue({
            code: "custom",
            message: "Targets must be contained relative paths",
          });
        }
      }
    }
  });

export type RelevanceFixture = z.infer<typeof relevanceFixtureSchema>;
export type RelevanceCase = RelevanceFixture["cases"][number];
export type RelevanceTarget = RelevanceCase["expected"][number];

export function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function parseFrozenFixture(
  bytes: Buffer,
  expectedSha256: string,
): RelevanceFixture {
  if (
    !digest.safeParse(expectedSha256).success ||
    sha256(bytes) !== expectedSha256
  ) {
    throw new Error(
      "Fixture checksum mismatch; freeze the reviewed fixture before measuring",
    );
  }
  return relevanceFixtureSchema.parse(JSON.parse(bytes.toString("utf8")));
}

/** Exact file plus the frozen matching rule; legacy fixtures allow symbol or range. */
export function matchesTarget(
  chunk: ChunkType,
  root: string,
  target: RelevanceTarget,
): boolean {
  if (typeof chunk.metadata?.path !== "string") return false;
  if (path.resolve(chunk.metadata.path) !== path.resolve(root, target.file))
    return false;
  if (
    target.match !== "range" &&
    chunk.defined_symbols?.includes(target.symbol)
  )
    return true;
  const start = chunk.generated_metadata?.start_line;
  const count = chunk.generated_metadata?.num_lines;
  if (typeof start !== "number" || typeof count !== "number" || count <= 0)
    return false;
  // SearchResponse ranges start at zero; source fixtures use one-based lines.
  return start + 1 <= target.endLine && start + count >= target.startLine;
}

export function scoreRelevance(
  response: SearchResponse,
  root: string,
  c: RelevanceCase,
) {
  const index = response.data.findIndex((chunk) =>
    c.expected.some((t) => matchesTarget(chunk, root, t)),
  );
  const rank = index + 1;
  return {
    rank,
    rrAt10: rank > 0 && rank <= 10 ? 1 / rank : 0,
    recallAt10: rank > 0 && rank <= 10 ? 1 : 0,
    hitAt1: rank === 1 ? 1 : 0,
    found: rank > 0,
  };
}

export type RelevanceSample = ReturnType<typeof scoreRelevance> & {
  id: string;
  corpus: string;
  split: "dev" | "heldout";
  repetition: number;
  elapsedMs: number;
  exclusions: string[];
};

export function summarizeRelevance(samples: RelevanceSample[]) {
  const valid = samples.filter((s) => s.exclusions.length === 0);
  const times = valid.map((s) => s.elapsedMs).sort((a, b) => a - b);
  const mean = (key: "rrAt10" | "recallAt10" | "hitAt1") =>
    valid.length
      ? valid.reduce((sum, s) => sum + s[key], 0) / valid.length
      : null;
  return {
    cases: new Set(samples.map((s) => s.id)).size,
    samples: samples.length,
    validSamples: valid.length,
    excludedSamples: samples.length - valid.length,
    mrrAt10: mean("rrAt10"),
    recallAt10: mean("recallAt10"),
    hitsAt1: mean("hitAt1"),
    medianMs: times.length ? times[Math.ceil(times.length / 2) - 1] : null,
    p95Ms: times.length ? times[Math.ceil(times.length * 0.95) - 1] : null,
  };
}

export function sourceExclusions(
  frozenHash: string,
  sourceHash: string,
  cacheHash?: string,
) {
  const reasons: string[] = [];
  if (sourceHash !== frozenHash) reasons.push("source_changed");
  if (cacheHash !== frozenHash) reasons.push("index_cache_hash_mismatch");
  return reasons;
}
