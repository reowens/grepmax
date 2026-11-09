import * as path from "node:path";
import { verifyPreparedEmbeddingArtifacts } from "../remote-embedding-artifacts";
import type { PreparedRemoteEmbeddingRuntime } from "../remote-embedding-executor";
import {
  type PreparedEmbeddingIdentity,
  validatePreparedEmbeddingIdentity,
} from "./protocol";

/** Called only inside the trusted fixed job, with adapter-owned canonical roots.
 * This factory does not claim containment or authorize a host/model invocation.
 */
export function createPreparedOnnxRuntime(
  manifest: unknown,
  value: PreparedEmbeddingIdentity,
  roots: { models: string; runtime: string; dependencies?: string },
): PreparedRemoteEmbeddingRuntime {
  const identity = validatePreparedEmbeddingIdentity(value);
  let verified = false;
  let created = false;
  const verifyArtifacts = async () => {
    await verifyPreparedEmbeddingArtifacts(manifest, identity, roots);
    verified = true;
  };
  return {
    identity,
    verifyArtifacts,
    async createModels() {
      if (!verified || created)
        throw new Error("Remote runtime must be verified and is one-shot");
      created = true;
      // This is scoped to the owned single-job process, never the P3 daemon.
      process.env.HF_HUB_OFFLINE = "1";
      process.env.TRANSFORMERS_OFFLINE = "1";
      const { env } = await import("@huggingface/transformers");
      env.allowRemoteModels = false;
      env.allowLocalModels = true;
      env.useFSCache = false;
      env.localModelPath = path.resolve(roots.models);
      const [{ GraniteModel }, { ColbertModel }] = await Promise.all([
        import("../embeddings/granite"),
        import("../embeddings/colbert"),
      ]);
      const granite = new GraniteModel(
        identity.generation.vectorDim,
        identity.generation.onnxModel,
        path.resolve(roots.models),
      );
      const colbert = new ColbertModel(
        identity.generation.colbertModel,
        path.resolve(roots.models),
      );
      return {
        granite,
        colbert,
        async dispose() {
          // Both native disposals settle before releasing executor ownership.
          const outcomes = await Promise.allSettled([
            granite.dispose(),
            colbert.dispose(),
          ]);
          const failed = outcomes.find((o) => o.status === "rejected");
          if (failed?.status === "rejected") throw failed.reason;
          // Recheck the inventory after reads. OS cache immutability must still
          // be provided by the actual job adapter; a manifest is not enforcement.
          await verifyArtifacts();
        },
      };
    },
  };
}
