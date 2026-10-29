import { classifyLeaseError, isStoreAccessRefused } from "../utils/store-access";
import { isEmbeddingBackendUnavailable } from "../workers/embedding-error";

type SearchOperation = "query-embedding" | "requested-rerank" | "automatic-rerank";

/** Explain only a stage that actually failed; never include backend error text. */
export async function runSearchStage<T>(
  stage: SearchOperation,
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    // Cancellation and sandbox refusal keep their existing handling/exit code.
    if (
      (error as Error)?.name === "AbortError" ||
      isStoreAccessRefused(error) ||
      classifyLeaseError(error) === "sandboxed"
    ) {
      throw error;
    }
    const code = (error as NodeJS.ErrnoException)?.code;
    const label =
      stage === "query-embedding"
        ? "Query embedding"
        : `${stage === "requested-rerank" ? "Requested" : "Automatic"} reranking`;
    const message =
      code === "HOST_SAFETY"
        ? `${label} refused by host safety policy — search did not return results. Check \`gmax status --json\`; have the operator review pressure/quarantine before retrying. Do not clear safety stops as a recovery shortcut.`
        : stage === "query-embedding"
          ? `Query embedding ${isEmbeddingBackendUnavailable(error) ? "backend unavailable" : "failed"} — search could not run; no lexical-only fallback was used. Check \`gmax config\` and \`gmax status --json\`; have the operator restore the configured backend or resolve model compatibility without switching models.`
          : `${label} failed — search did not return results; no unreranked fallback was used. Check \`gmax status --json\` and \`gmax config\` before retrying; have the operator resolve the worker or index/model compatibility failure.`;
    const failure = new Error(message);
    // Preserve the underlying classification without exposing paths/query text.
    if (code) Object.assign(failure, { code });
    throw failure;
  }
}

/** Uses existing adopt/query outcomes, never an empty hit list, as evidence. */
export function lexicalSearchWarning(state: {
  available: boolean;
  searchFailed: boolean;
  missingIndex?: boolean;
}): string | undefined {
  if (state.available && !state.searchFailed) return undefined;
  const reason = state.searchFailed
    ? "the full-text query failed"
    : state.missingIndex
      ? "no full-text index exists"
      : "the full-text index could not be used";
  const recovery =
    state.missingIndex && !state.searchFailed
      ? "Recovery: the store owner can build only the missing index with an explicitly authorized `gmax repair --fts` after indexing completes."
      : "Check `gmax status --json`; have the store owner inspect the full-text failure before any repair. `gmax repair --fts` only builds a missing index; it does not replace an existing one.";
  return `Full-text search unavailable — ${reason}; results use vector retrieval only. ${recovery}`;
}

const LEGACY_LEXICAL_WARNING =
  "Full-text search unavailable — results may be less precise";

/** Optional/older metadata must never prevent rendering otherwise valid hits. */
export function formatSearchWarnings(warnings: unknown): string[] {
  if (!Array.isArray(warnings)) return [];
  return [
    ...new Set(
      warnings
        .filter((w): w is string => typeof w === "string")
        .map((warning) =>
          warning === LEGACY_LEXICAL_WARNING
            ? lexicalSearchWarning({ available: false, searchFailed: false })!
            : warning,
        )
        .map((warning) => warning.replace(/[\r\n\t]/g, " ").trim())
        .filter(Boolean),
    ),
  ];
}
