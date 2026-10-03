/** Shared backend outages are retryable; malformed inputs/protocols are not. */
export class EmbeddingBackendUnavailableError extends Error {
  readonly code = "EMBED_BACKEND_UNAVAILABLE";
  constructor(message: string) {
    super(message);
    this.name = "EmbeddingBackendUnavailableError";
  }
}

export function isEmbeddingBackendUnavailable(error: unknown): boolean {
  return (
    (error as { code?: unknown } | null)?.code === "EMBED_BACKEND_UNAVAILABLE"
  );
}
