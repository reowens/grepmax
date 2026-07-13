import { createHash } from "node:crypto";
import { MODEL_IDS, MODEL_TIERS } from "../../config";

export interface EmbeddingGenerationIdentity {
  tier: string;
  vectorDim: number;
  onnxModel: string;
  mlxModel: string;
  colbertModel: string;
}

export interface EmbeddingGenerationConfig extends EmbeddingGenerationIdentity {
  fingerprint: string;
}

export interface EmbeddingGenerationInput {
  modelTier: string;
  vectorDim?: number;
  mlxModel?: string;
}

export interface PersistedEmbeddingIdentity {
  modelTier: string;
  vectorDim: number;
  embedModel?: string;
  mlxModel?: string;
  colbertModel?: string;
  embeddingFingerprint?: string;
}

export type EmbeddingIdentityState = "current" | "legacy" | "stale";

function requireModelId(label: string, value: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} must be a non-empty model ID`);
  if (normalized !== value) {
    throw new Error(`${label} must not contain surrounding whitespace`);
  }
  return value;
}

export function computeEmbeddingFingerprint(
  identity: EmbeddingGenerationIdentity,
): string {
  if (!Number.isInteger(identity.vectorDim) || identity.vectorDim <= 0) {
    throw new Error("Embedding vector dimension must be a positive integer");
  }
  const canonical = [
    "gmax-embedding-generation-v1",
    requireModelId("Model tier", identity.tier),
    identity.vectorDim,
    requireModelId("ONNX model", identity.onnxModel),
    requireModelId("MLX model", identity.mlxModel),
    requireModelId("ColBERT model", identity.colbertModel),
  ];
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

export function resolveEmbeddingGeneration(
  input: EmbeddingGenerationInput,
): Readonly<EmbeddingGenerationConfig> {
  const tier = MODEL_TIERS[input.modelTier];
  if (!tier) throw new Error(`Unknown model tier: ${input.modelTier}`);
  if (input.vectorDim !== undefined && input.vectorDim !== tier.vectorDim) {
    throw new Error(
      `Vector dimension ${input.vectorDim} contradicts model tier ${input.modelTier} (${tier.vectorDim})`,
    );
  }

  const identity: EmbeddingGenerationIdentity = {
    tier: tier.id,
    vectorDim: tier.vectorDim,
    onnxModel: tier.onnxModel,
    mlxModel: requireModelId("MLX model", input.mlxModel ?? tier.mlxModel),
    colbertModel: MODEL_IDS.colbert,
  };
  return Object.freeze({
    ...identity,
    fingerprint: computeEmbeddingFingerprint(identity),
  });
}

export function parseEmbeddingGeneration(
  value: unknown,
): Readonly<EmbeddingGenerationConfig> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid embedding generation");
  }
  const candidate = value as Partial<EmbeddingGenerationConfig>;
  if (
    typeof candidate.tier !== "string" ||
    typeof candidate.vectorDim !== "number" ||
    typeof candidate.onnxModel !== "string" ||
    typeof candidate.mlxModel !== "string" ||
    typeof candidate.colbertModel !== "string" ||
    typeof candidate.fingerprint !== "string"
  ) {
    throw new Error("Invalid embedding generation");
  }
  const identity: EmbeddingGenerationIdentity = {
    tier: candidate.tier,
    vectorDim: candidate.vectorDim,
    onnxModel: candidate.onnxModel,
    mlxModel: candidate.mlxModel,
    colbertModel: candidate.colbertModel,
  };
  if (candidate.fingerprint !== computeEmbeddingFingerprint(identity)) {
    throw new Error("Embedding generation identity is inconsistent");
  }
  return Object.freeze({ ...identity, fingerprint: candidate.fingerprint });
}

export function isOnnxFallbackCompatible(
  generation: Readonly<EmbeddingGenerationConfig>,
): boolean {
  const tier = MODEL_TIERS[generation.tier];
  return (
    tier?.id === generation.tier &&
    tier.vectorDim === generation.vectorDim &&
    tier.onnxModel === generation.onnxModel &&
    tier.mlxModel === generation.mlxModel
  );
}

export function compareEmbeddingGeneration(
  persisted: PersistedEmbeddingIdentity,
  configured: Readonly<EmbeddingGenerationConfig>,
): {
  built: Readonly<EmbeddingGenerationConfig>;
  state: EmbeddingIdentityState;
} {
  const hasExactIdentity =
    persisted.embeddingFingerprint !== undefined &&
    persisted.embedModel !== undefined &&
    persisted.mlxModel !== undefined &&
    persisted.colbertModel !== undefined;
  const built = hasExactIdentity
    ? parseEmbeddingGeneration({
        tier: persisted.modelTier,
        vectorDim: persisted.vectorDim,
        onnxModel: persisted.embedModel,
        mlxModel: persisted.mlxModel,
        colbertModel: persisted.colbertModel,
        fingerprint: persisted.embeddingFingerprint,
      })
    : resolveEmbeddingGeneration({
        modelTier: persisted.modelTier,
        vectorDim: persisted.vectorDim,
        ...(persisted.mlxModel === undefined
          ? {}
          : { mlxModel: persisted.mlxModel }),
      });
  return {
    built,
    state:
      (persisted.embeddingFingerprint ?? built.fingerprint) !==
      configured.fingerprint
        ? "stale"
        : persisted.embeddingFingerprint
          ? "current"
          : "legacy",
  };
}
