import {
  parseEmbeddingGeneration,
  resolveEmbeddingGeneration,
} from "../index/embedding-generation";
import { readGlobalConfig } from "../index/index-config";
import {
  type ProcessFileInput,
  type ProcessFileResult,
  type RerankDoc,
  WorkerOrchestrator,
} from "./orchestrator";

export type { ProcessFileInput, ProcessFileResult, RerankDoc };

const hasSerializedRuntime =
  !!process.env.GMAX_EMBEDDING_GENERATION &&
  (process.env.GMAX_EMBED_MODE === "cpu" ||
    process.env.GMAX_EMBED_MODE === "gpu");
const runtimeConfig = hasSerializedRuntime ? null : readGlobalConfig();
const generation = process.env.GMAX_EMBEDDING_GENERATION
  ? parseEmbeddingGeneration(JSON.parse(process.env.GMAX_EMBEDDING_GENERATION))
  : resolveEmbeddingGeneration(runtimeConfig!);
const embedMode =
  process.env.GMAX_EMBED_MODE === "cpu" || process.env.GMAX_EMBED_MODE === "gpu"
    ? process.env.GMAX_EMBED_MODE
    : runtimeConfig!.embedMode;
const orchestrator = new WorkerOrchestrator(generation, embedMode);

export default async function processFile(
  input: ProcessFileInput,
  onProgress?: () => void,
): Promise<ProcessFileResult> {
  return orchestrator.processFile(input, onProgress);
}

export async function encodeQuery(input: { text: string }) {
  return orchestrator.encodeQuery(input.text);
}

export async function rerank(input: {
  query: number[][];
  docs: RerankDoc[];
  colbertDim: number;
}) {
  return orchestrator.rerank(input);
}
