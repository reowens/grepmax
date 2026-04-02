export interface LlmConfig {
  model: string;
  binary: string;
  host: string;
  port: number;
  ctxSize: number;
  ngl: number;
  maxTokens: number;
  idleTimeoutMin: number;
  startupWaitSec: number;
}

const DEFAULT_MODEL =
  "/Volumes/External/models/huggingface/hub/models--unsloth--Qwen3.5-35B-A3B-GGUF/Qwen3.5-35B-A3B-Q4_K_M.gguf";

function envInt(key: string, fallback: number): number {
  const v = process.env[key];
  if (!v) return fallback;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function getLlmConfig(): LlmConfig {
  return {
    model: process.env.GMAX_LLM_MODEL ?? DEFAULT_MODEL,
    binary: process.env.GMAX_LLM_BINARY ?? "llama-server",
    host: process.env.GMAX_LLM_HOST ?? "127.0.0.1",
    port: envInt("GMAX_LLM_PORT", 8079),
    ctxSize: envInt("GMAX_LLM_CTX_SIZE", 16384),
    ngl: envInt("GMAX_LLM_NGL", 99),
    maxTokens: envInt("GMAX_LLM_MAX_TOKENS", 8192),
    idleTimeoutMin: envInt("GMAX_LLM_IDLE_TIMEOUT", 30),
    startupWaitSec: envInt("GMAX_LLM_STARTUP_WAIT", 60),
  };
}
