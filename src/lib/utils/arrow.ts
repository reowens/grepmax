/**
 * Convert an Apache Arrow vector/list field to a plain JS array.
 * Handles both Arrow objects (with .toArray()) and plain arrays.
 */
export function toArr(val: unknown): string[] {
  if (val && typeof (val as any).toArray === "function") {
    return (val as any).toArray();
  }
  return Array.isArray(val) ? val : [];
}
