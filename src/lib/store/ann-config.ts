import type { VectorQuery } from "@lancedb/lancedb";

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function isAnnEnabled(): boolean {
  return process.env.GMAX_ANN === "1";
}

export function annMinRows(): number {
  return positiveInt(process.env.GMAX_ANN_MIN_ROWS, 50_000);
}

export function configureAnnVectorQuery(query: VectorQuery): VectorQuery {
  let configured = query;
  if (typeof configured.column === "function") {
    configured = configured.column("vector");
  }
  if (!isAnnEnabled()) {
    return typeof configured.bypassVectorIndex === "function"
      ? configured.bypassVectorIndex()
      : configured;
  }

  const minimum = positiveInt(process.env.GMAX_ANN_NPROBES, 20);
  const maximum = Math.max(
    minimum,
    positiveInt(process.env.GMAX_ANN_MAX_NPROBES, 200),
  );
  if (typeof configured.minimumNprobes === "function") {
    configured = configured.minimumNprobes(minimum);
  }
  return typeof configured.maximumNprobes === "function"
    ? configured.maximumNprobes(maximum)
    : configured;
}
