export function annotateSkeletonLines(
  skeleton: string,
  sourceContent: string,
): string {
  const sourceLines = sourceContent.split("\n");
  const skelLines = skeleton.split("\n");
  const used = new Set<number>();

  return skelLines
    .map((skelLine) => {
      const trimmed = skelLine.trim();
      if (
        !trimmed ||
        trimmed.startsWith("//") ||
        trimmed.startsWith("*") ||
        trimmed.startsWith("/*")
      ) {
        return skelLine;
      }
      const matchStr = trimmed.slice(0, 40);
      for (let i = 0; i < sourceLines.length; i++) {
        if (!used.has(i) && sourceLines[i].includes(matchStr)) {
          used.add(i);
          return `${String(i + 1).padStart(4)}│${skelLine}`;
        }
      }
      return skelLine;
    })
    .join("\n");
}
