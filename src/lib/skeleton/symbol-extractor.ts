export interface SkeletonSymbol {
  name: string;
  line: number;
  signature: string;
  type: string;
  exported: boolean;
}

export function extractSymbolsFromSkeleton(
  annotatedSkeleton: string,
): SkeletonSymbol[] {
  return annotatedSkeleton
    .split("\n")
    .filter((l) => /^\s*\d+│/.test(l))
    .map((l) => {
      const m = l.match(/^\s*(\d+)│(.+)/);
      if (!m) return null;
      const line = Number.parseInt(m[1], 10);
      const sig = m[2].trim();
      const exported = sig.includes("export ");
      const type =
        sig.match(
          /\b(class|interface|type|function|def|fn|func)\b/,
        )?.[1] || "other";
      const name =
        sig.match(
          /(?:function|class|interface|type|def|fn|func)\s+(\w+)/,
        )?.[1] ||
        sig.match(/^(?:async\s+)?(\w+)\s*[(<]/)?.[1] ||
        "unknown";
      return {
        name,
        line,
        signature: sig.replace(/\s*\{?\s*\/\/.*$/, "").trim(),
        type,
        exported,
      };
    })
    .filter(
      (s): s is NonNullable<typeof s> =>
        s !== null && s.name !== "unknown",
    );
}
