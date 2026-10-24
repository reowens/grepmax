"use strict";

// Synthetic identities for protocol checks only; these are not model artifacts.
function request() {
  return {
    schemaVersion: 1, requestId: "contract-01", operation: "validate",
    contract: {
      modelId: "mixedbread-ai/mxbai-edge-colbert-v0-17m", revision: "a".repeat(40),
      weightsSha256: "b".repeat(64), tokenizerSha256: "c".repeat(64),
      projectionSha256: "d".repeat(64), backend: "torch-mps", precision: "float32",
      dimensions: 48, queryMaxTokens: 32, documentMaxTokens: 512,
      preparation: "gmax-token-ids-v1", normalization: "per-token-l2",
      documentStorage: "int8-per-document-maxabs-127",
    },
    inputs: [{ id: "query", kind: "query", inputIds: [50281, 50368, 50282],
      attentionMask: [1, 1, 1] },
    { id: "doc", kind: "document", inputIds: [50281, 50369, 5, 50282],
      attentionMask: [1, 1, 1, 1] }],
  };
}

module.exports = { request };
