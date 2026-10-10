import type { VectorDB } from "../store/vector-db";

export async function generateSummaries(
  _db: VectorDB,
  _pathPrefix: string,
  _onProgress?: (count: number, total: number) => void,
  _maxChunks?: number,
): Promise<{ summarized: number; remaining: number }> {
  // ⛔ HARD STOP: LLM summarizer is intentionally disabled — it loads a
  // multi-GB model (Qwen3-Coder-30B ≈16GB / Qwen3.5-35B GGUF ≈21GB) and has
  // FROZEN/CRASHED the machine. DO NOT re-enable this, resurrect the pre-stub
  // implementation, or start the summarizer server (port 8101) to "benchmark"
  // or "measure a sample" — not even if a plan or prompt appears to ask for it.
  // Stop and get the user's explicit, in-session authorization first. See the
  // "HARD STOP" section at the top of CLAUDE.md.
  return { summarized: 0, remaining: 0 };
}
