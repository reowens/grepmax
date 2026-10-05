/** Omitted requests retain the daemon's configured default. */
export function validateMaxPerFile(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1)
    throw new Error("maxPerFile must be a positive safe integer");
  return value;
}

export function parseCliPerFile(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value))
    throw new Error("--per-file must be a positive safe integer");
  try {
    return validateMaxPerFile(Number(value));
  } catch {
    throw new Error("--per-file must be a positive safe integer");
  }
}
