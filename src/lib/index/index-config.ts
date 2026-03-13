/**
 * Index configuration — tracks which models built the current index.
 * Prevents searching with incompatible vectors after a model swap.
 *
 * Also stores user preferences from `osgrep setup` (embed mode, MLX model).
 */

import * as fs from "node:fs";
import { CONFIG, MODEL_IDS } from "../../config";

export interface IndexConfig {
  // User preferences (set by `osgrep setup`)
  embedMode?: "cpu" | "gpu";
  mlxModel?: string;

  // Model identity (set after indexing completes)
  embedModel: string;
  colbertModel: string;
  vectorDim: number;
  indexedAt?: string;
}

export function readIndexConfig(configPath: string): IndexConfig | null {
  try {
    const raw = fs.readFileSync(configPath, "utf-8");
    return JSON.parse(raw) as IndexConfig;
  } catch {
    return null;
  }
}

export function writeIndexConfig(configPath: string, extra?: Partial<IndexConfig>): void {
  const existing = readIndexConfig(configPath);
  const config: IndexConfig = {
    // Preserve user preferences from setup
    embedMode: existing?.embedMode,
    mlxModel: existing?.mlxModel,
    // Model identity from current run
    embedModel: MODEL_IDS.embed,
    colbertModel: MODEL_IDS.colbert,
    vectorDim: CONFIG.VECTOR_DIM,
    indexedAt: new Date().toISOString(),
    // Allow overrides
    ...extra,
  };
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
}

/**
 * Write only user preferences without touching model identity fields.
 * Used by `osgrep setup` before any indexing has happened.
 */
export function writeSetupConfig(
  configPath: string,
  prefs: { embedMode: "cpu" | "gpu"; mlxModel?: string },
): void {
  const existing = readIndexConfig(configPath);
  const config = {
    ...existing,
    embedMode: prefs.embedMode,
    mlxModel: prefs.mlxModel,
  };
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
}

export function checkModelMismatch(configPath: string): boolean {
  const stored = readIndexConfig(configPath);
  if (!stored) return false; // No config yet — first index
  if (stored.embedModel !== MODEL_IDS.embed) return true;
  if (stored.colbertModel !== MODEL_IDS.colbert) return true;
  if (stored.vectorDim !== undefined && stored.vectorDim !== CONFIG.VECTOR_DIM) return true;
  return false;
}
