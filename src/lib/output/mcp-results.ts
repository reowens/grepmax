import { z } from "zod";
import type { GraphDeadFacts, GraphTraceResult } from "../daemon/graph-handler";
import type { CallerTree, GraphNode } from "../graph/graph-builder";

const location = z.object({
  path: z.string(),
  line: z.number().int().positive().describe("One-based source line"),
});
const graphNode = z.object({
  symbol: z.string(),
  location: location.nullable(),
  role: z.string(),
  resolution: z.enum(["indexed", "not_indexed", "ambiguous_member"]),
  edgeKind: z.enum(["free", "member", "type"]).optional(),
  confidence: z.enum(["EXTRACTED", "INFERRED"]).optional(),
});
const search = {
  schemaVersion: z.literal(1),
  query: z.string(),
  roots: z.array(z.string()),
  warnings: z.array(z.string()),
  matches: z
    .array(
      z.object({
        path: z.string(),
        startLine: z.number().int().positive(),
        endLine: z.number().int().positive(),
        symbols: z.array(z.string()),
        role: z.string(),
        score: z
          .number()
          .nullable()
          .describe("Search score; null when unavailable"),
      }),
    )
    .max(50),
};

export const compactionSchema = z.object({
  status: z.enum(["completed", "skipped", "failed"]),
  at: z.number(),
  attempts: z.number(),
  elapsedMs: z.number(),
  reason: z.string().optional(),
  logicalBytes: z.number().optional(),
  diskBytesBefore: z.number().optional(),
  diskBytesAfter: z.number().optional(),
  freeBytesBefore: z.number().optional(),
  freeBytesAfter: z.number().optional(),
  bytesReclaimed: z.number().optional(),
  netBytesReclaimed: z.number().optional(),
  cleanupPasses: z.number().int().min(0).max(1).optional(),
  cleanupReason: z.string().optional(),
});
const embedding = z.object({
  tier: z.string(),
  vectorDim: z.number(),
  fingerprint: z.string(),
});

/** Only tools with a complete success contract advertise an output schema. */
export const MCP_READ_OUTPUT_SCHEMAS: Record<string, z.ZodRawShape> = {
  semantic_search: search,
  trace_calls: {
    schemaVersion: z.literal(1),
    symbol: z.string(),
    root: z.string(),
    found: z.boolean(),
    center: graphNode.nullable(),
    callers: z.array(
      z.object({
        node: graphNode,
        depth: z.number().int().positive(),
        parentIndex: z
          .number()
          .int()
          .nonnegative()
          .nullable()
          .describe(
            "Index of the parent in callers; null for a direct caller of center",
          ),
      }),
    ),
    callees: z.array(graphNode).max(15),
    importers: z.array(z.string()).max(10),
    omittedCallees: z.number().int().nonnegative(),
    omittedImporters: z.number().int().nonnegative(),
    approximate: z.literal(true),
  },
  dead: {
    schemaVersion: z.literal(1),
    symbol: z.string(),
    root: z.string(),
    status: z.enum(["not_found", "public_export", "dead", "live"]),
    definition: location.nullable(),
    isExported: z.boolean(),
    callerCount: z.number().int().nonnegative(),
    callers: z.array(location),
    approximate: z.literal(true),
  },
  index_status: {
    schemaVersion: z.literal(1),
    root: z.string(),
    store: z.string(),
    secondary: z.boolean(),
    chunks: z.number().int().nonnegative(),
    files: z.number().int().nonnegative(),
    projects: z.number().int().nonnegative(),
    embedding: z.object({
      state: z.string(),
      configured: embedding,
      built: embedding.nullable(),
    }),
    watcher: z.object({
      status: z.string(),
      indexState: z
        .object({
          indexing: z.boolean(),
          pendingFiles: z.number(),
          verifying: z.boolean().optional(),
          failedFiles: z.number().optional(),
          degraded: z.boolean().optional(),
          watcherMode: z.enum(["native", "polling", "recovering"]).optional(),
          catchupRunning: z.boolean().optional(),
          lastReconciledAt: z.number().optional(),
          overflowCount: z.number().optional(),
          catchupMs: z.number().optional(),
        })
        .nullable(),
    }),
    compaction: compactionSchema.nullable(),
  },
};

function nodeResult(node: GraphNode) {
  return {
    symbol: node.symbol,
    location: node.file ? { path: node.file, line: node.line + 1 } : null,
    role: node.role,
    resolution: node.file
      ? "indexed"
      : node.resolution === "ambiguous-member"
        ? "ambiguous_member"
        : "not_indexed",
    ...(node.edgeKind ? { edgeKind: node.edgeKind } : {}),
    ...(node.confidence ? { confidence: node.confidence } : {}),
  };
}

export function traceResult(
  symbol: string,
  root: string,
  graph: GraphTraceResult,
) {
  const callers: Array<{
    node: ReturnType<typeof nodeResult>;
    depth: number;
    parentIndex: number | null;
  }> = [];
  function visit(
    trees: CallerTree[],
    depth: number,
    parentIndex: number | null,
  ): void {
    for (const tree of trees) {
      const index = callers.length;
      callers.push({ node: nodeResult(tree.node), depth, parentIndex });
      visit(tree.callers, depth + 1, index);
    }
  }
  visit(graph.callerTree, 1, null);
  const importers = graph.importers.filter((p) => p !== graph.center?.file);
  return {
    schemaVersion: 1,
    symbol,
    root,
    found: graph.center !== null,
    center: graph.center ? nodeResult(graph.center) : null,
    callers,
    callees: graph.callees.slice(0, 15).map(nodeResult),
    importers: importers.slice(0, 10),
    omittedCallees: Math.max(0, graph.callees.length - 15),
    omittedImporters: Math.max(0, importers.length - 10),
    approximate: true,
  };
}

export function deadResult(
  symbol: string,
  root: string,
  facts: GraphDeadFacts,
) {
  return {
    schemaVersion: 1,
    symbol,
    root,
    status: !facts.found
      ? "not_found"
      : facts.callerCount > 0
        ? "live"
        : facts.isExported
          ? "public_export"
          : "dead",
    definition: facts.found
      ? { path: facts.defPath, line: facts.defLine + 1 }
      : null,
    isExported: facts.isExported,
    callerCount: facts.callerCount,
    callers: facts.topCallers.map((c) => ({ path: c.file, line: c.line + 1 })),
    approximate: true,
  };
}
