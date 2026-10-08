/** A bounded source excerpt with explicit loss counts. Full/JSON output stays exact. */
export function boundedAgentText(
  text: string,
  maxChars = 6000,
  maxLines = 120,
): string {
  const lines = text.split("\n");
  const lineLimited = lines.slice(0, maxLines).join("\n");
  let end = Math.min(lineLimited.length, maxChars);
  // Do not emit half of a UTF-16 surrogate pair at the character boundary.
  if (
    end > 0 &&
    /[\uD800-\uDBFF]/.test(lineLimited[end - 1]) &&
    /[\uDC00-\uDFFF]/.test(lineLimited[end] ?? "")
  )
    end--;
  const excerpt = lineLimited.slice(0, end);
  if (excerpt.length === text.length) return text;
  const shownLines = excerpt ? excerpt.split("\n").length : 0;
  return `${excerpt}\n… omitted ${Math.max(0, lines.length - shownLines)} lines, ${text.length - excerpt.length} characters`;
}

/** Preserve complete fields so loss counts describe files, not partial names. */
export function boundedAgentList(
  items: string[],
  maxItems = 8,
  maxChars = 1000,
): { text: string; omitted: number } {
  const shown: string[] = [];
  let length = 0;
  for (const item of items.slice(0, maxItems)) {
    const field = item
      .replace(/\\/g, "\\\\")
      .replace(/\t/g, "\\t")
      .replace(/\r/g, "\\r")
      .replace(/\n/g, "\\n");
    const nextLength = length + field.length + (shown.length ? 1 : 0);
    if (nextLength > maxChars) break;
    shown.push(field);
    length = nextLength;
  }
  return { text: shown.join(","), omitted: items.length - shown.length };
}
