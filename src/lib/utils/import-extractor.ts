import * as fs from "node:fs";

export function extractImports(filePath: string): string {
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    return extractImportsFromContent(content);
  } catch {
    return "";
  }
}

export function extractImportsFromContent(content: string): string {
  const lines = content.split("\n");
  const importLines: string[] = [];
  let inMultiLine = false;

  for (const line of lines) {
    const trimmed = line.trim();

    if (inMultiLine) {
      importLines.push(line);
      if (trimmed === ")" || trimmed === ");") inMultiLine = false;
      continue;
    }

    if (
      !trimmed ||
      trimmed.startsWith("//") ||
      trimmed.startsWith("#") ||
      trimmed.startsWith("*") ||
      trimmed.startsWith("/*")
    ) {
      continue;
    }

    if (
      trimmed.startsWith("import ") ||
      trimmed.startsWith("from ") ||
      (trimmed.startsWith("const ") && trimmed.includes("require(")) ||
      trimmed.startsWith("require(") ||
      trimmed.startsWith("use ") ||
      trimmed.startsWith("using ") ||
      trimmed.startsWith("package ")
    ) {
      importLines.push(line);
      if (trimmed.includes("(") && !trimmed.includes(")")) {
        inMultiLine = true;
      }
      continue;
    }

    break;
  }

  return importLines.length > 0 ? importLines.join("\n") : "";
}
