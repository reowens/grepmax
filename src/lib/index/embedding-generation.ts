import { createHash } from "node:crypto";
import { MODEL_IDS, MODEL_TIERS } from "../../config";
import {
  GEMMA2_CONTRACT_DIGEST,
  GEMMA2_MODEL,
} from "../workers/embeddings/gemma2";

/** The dense weights file the ONNX path loads from `<onnxModel>/onnx/`. */
export const ONNX_DENSE_FILE = "model_quantized.onnx";

/**
 * How the ONNX models turn a chunk into vectors: the int8 dense file, and
 * ColBERT run 1 chunk per call (its int8 activation scale is per input tensor,
 * so batching made a chunk's vectors depend on its neighbours). Identities
 * written before it existed omit it and read as stale.
 */
export const ONNX_PROFILE = `dense=${ONNX_DENSE_FILE};colbert=1-per-call`;

export interface EmbeddingGenerationIdentity {
  tier: string;
  vectorDim: number;
  onnxModel: string;
  mlxModel: string;
  colbertModel: string;
  onnxProfile?: string;
}

export interface EmbeddingGenerationConfig extends EmbeddingGenerationIdentity {
  fingerprint: string;
}

export interface EmbeddingGenerationInput {
  modelTier: string;
  vectorDim?: number;
  mlxModel?: string;
  /** Omit only to rebuild an identity written before profiles existed. */
  onnxProfile?: string | null;
}

export interface PersistedEmbeddingIdentity {
  modelTier: string;
  vectorDim: number;
  embedModel?: string;
  mlxModel?: string;
  colbertModel?: string;
  onnxProfile?: string;
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
  if (identity.mlxModel === GEMMA2_MODEL && identity.tier !== "gemma2")
    throw new Error("The pinned Gemma model requires the gemma2 tier");
  const canonical = [
    "gmax-embedding-generation-v1",
    requireModelId("Model tier", identity.tier),
    identity.vectorDim,
    requireModelId("ONNX model", identity.onnxModel),
    requireModelId("MLX model", identity.mlxModel),
    requireModelId("ColBERT model", identity.colbertModel),
  ];
  if (identity.onnxProfile !== undefined)
    canonical.push(requireModelId("ONNX profile", identity.onnxProfile));
  if (identity.tier === "gemma2") {
    if (
      identity.mlxModel !== GEMMA2_MODEL ||
      identity.onnxModel !== MODEL_TIERS.gemma2.onnxModel ||
      identity.vectorDim !== 768
    )
      throw new Error("Gemma requires its pinned text-only MLX identity");
    canonical.push(GEMMA2_CONTRACT_DIGEST);
  }
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
    ...(input.onnxProfile === null
      ? {}
      : { onnxProfile: input.onnxProfile ?? ONNX_PROFILE }),
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
    (candidate.onnxProfile !== undefined &&
      typeof candidate.onnxProfile !== "string") ||
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
    ...(candidate.onnxProfile === undefined
      ? {}
      : { onnxProfile: candidate.onnxProfile }),
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
    generation.tier !== "gemma2" &&
    tier?.id === generation.tier &&
    tier.vectorDim === generation.vectorDim &&
    tier.onnxModel === generation.onnxModel &&
    tier.mlxModel === generation.mlxModel &&
    generation.onnxProfile === ONNX_PROFILE
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
        onnxProfile: persisted.onnxProfile,
        fingerprint: persisted.embeddingFingerprint,
      })
    : resolveEmbeddingGeneration({
        modelTier: persisted.modelTier,
        vectorDim: persisted.vectorDim,
        onnxProfile: null,
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
