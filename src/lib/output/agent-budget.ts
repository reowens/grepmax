/** A bounded source excerpt with explicit loss counts. Full/JSON output stays exact. */
export function boundedAgentText(text: string, maxChars = 6000, maxLines = 120): string {
  const lines = text.split("\n");
  const lineLimited = lines.slice(0, maxLines).join("\n");
  const excerpt = lineLimited.slice(0, maxChars);
  if (excerpt.length === text.length) return text;
  const shownLines = excerpt.split("\n").length;
  return `${excerpt}\n… omitted ${Math.max(0, lines.length - shownLines)} lines, ${text.length - excerpt.length} characters`;
}
