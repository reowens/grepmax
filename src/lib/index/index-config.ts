/**
 * Index configuration — tracks which models built the current index.
 * Prevents searching with incompatible vectors after a model swap.
 *
 * Also stores user preferences from `gmax setup` (embed mode, MLX model).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
  DEFAULT_MODEL_TIER,
  MODEL_IDS,
  MODEL_TIERS,
  PATHS,
} from "../../config";

export interface IndexConfig {
  // User preferences (set by `gmax setup`)
  embedMode?: "cpu" | "gpu";
  mlxModel?: string;
  modelTier?: string; // "small" | "standard"

  // Model identity (set after indexing completes)
  embedModel: string;
  colbertModel: string;
  vectorDim: number;
  indexedAt?: string;
}

export interface GlobalConfig {
  modelTier: string;
  vectorDim: number;
  embedMode: "cpu" | "gpu";
  mlxModel?: string;
}

const GLOBAL_CONFIG_PATH = path.join(PATHS.globalRoot, "config.json");

export function readGlobalConfig(): GlobalConfig {
  const defaultEmbedMode =
    process.arch === "arm64" && process.platform === "darwin" ? "gpu" : "cpu";
  try {
    const raw = fs.readFileSync(GLOBAL_CONFIG_PATH, "utf-8");
    const parsed = JSON.parse(raw) as GlobalConfig;
    // Ensure embedMode has a default even if missing from stored config
    if (!parsed.embedMode) parsed.embedMode = defaultEmbedMode;
    return parsed;
  } catch {
    const tier = MODEL_TIERS[DEFAULT_MODEL_TIER];
    return {
      modelTier: DEFAULT_MODEL_TIER,
      vectorDim: tier.vectorDim,
      embedMode: defaultEmbedMode,
    };
  }
}

export function writeGlobalConfig(config: GlobalConfig): void {
  fs.mkdirSync(path.dirname(GLOBAL_CONFIG_PATH), { recursive: true });
  fs.writeFileSync(GLOBAL_CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`);
}

/**
 * Resolve the effective model IDs for a given tier.
 */
export function getModelIdsForTier(tierName: string): {
  embed: string;
  colbert: string;
  vectorDim: number;
} {
  const tier = MODEL_TIERS[tierName] ?? MODEL_TIERS[DEFAULT_MODEL_TIER];
  return {
    embed: tier.onnxModel,
    colbert: MODEL_IDS.colbert,
    vectorDim: tier.vectorDim,
  };
}

export function readIndexConfig(configPath: string): IndexConfig | null {
  try {
    const raw = fs.readFileSync(configPath, "utf-8");
    return JSON.parse(raw) as IndexConfig;
  } catch {
    return null;
  }
}

export function writeIndexConfig(
  configPath: string,
  extra?: Partial<IndexConfig>,
): void {
  const existing = readIndexConfig(configPath);
  const tierName = existing?.modelTier ?? readGlobalConfig().modelTier;
  const tierIds = getModelIdsForTier(tierName);
  const config: IndexConfig = {
    // Preserve user preferences from setup
    embedMode: existing?.embedMode,
    mlxModel: existing?.mlxModel,
    modelTier: tierName,
    // Model identity from current run
    embedModel: tierIds.embed,
    colbertModel: tierIds.colbert,
    vectorDim: tierIds.vectorDim,
    indexedAt: new Date().toISOString(),
    // Allow overrides
    ...extra,
  };
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
}

/**
 * Write only user preferences without touching model identity fields.
 * Used by `gmax setup` before any indexing has happened.
 */
export function writeSetupConfig(
  configPath: string,
  prefs: {
    embedMode: "cpu" | "gpu";
    mlxModel?: string;
    modelTier?: string;
  },
): void {
  const existing = readIndexConfig(configPath);
  const config = {
    ...existing,
    embedMode: prefs.embedMode,
    mlxModel: prefs.mlxModel,
    modelTier: prefs.modelTier,
  };
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
}

export function checkModelMismatch(configPath: string): boolean {
  const stored = readIndexConfig(configPath);
  if (!stored) return false; // No config yet — first index
  const globalConfig = readGlobalConfig();
  const tierIds = getModelIdsForTier(globalConfig.modelTier);
  if (stored.embedModel && stored.embedModel !== tierIds.embed) return true;
  if (stored.colbertModel && stored.colbertModel !== tierIds.colbert)
    return true;
  if (stored.vectorDim !== undefined && stored.vectorDim !== tierIds.vectorDim)
    return true;
  return false;
}
