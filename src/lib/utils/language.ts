import * as path from "node:path";

const EXTENSION_TO_LANGUAGE: Record<string, string> = {
  ".ts": "ts",
  ".tsx": "ts",
  ".js": "js",
  ".jsx": "js",
  ".mjs": "js",
  ".cjs": "js",
  ".py": "py",
  ".swift": "swift",
  ".kt": "kotlin",
  ".kts": "kotlin",
  ".go": "go",
  ".rs": "rust",
  ".rb": "ruby",
  ".java": "java",
  ".c": "c",
  ".h": "c",
  ".cpp": "cpp",
  ".cc": "cpp",
  ".hpp": "cpp",
  ".cs": "csharp",
  ".php": "php",
  ".lua": "lua",
  ".sh": "bash",
  ".bash": "bash",
  ".zsh": "bash",
  ".sql": "sql",
  ".md": "md",
  ".mdx": "md",
  ".json": "json",
  ".yaml": "yaml",
  ".yml": "yaml",
  ".toml": "toml",
};

export function languageOf(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (EXTENSION_TO_LANGUAGE[ext]) return EXTENSION_TO_LANGUAGE[ext];
  const fallback = ext.replace(/^\./, "");
  return fallback || "unknown";
}

export function groupByLanguage<T extends { path: string }>(
  chunks: T[],
): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const c of chunks) {
    const lang = languageOf(c.path);
    const arr = out.get(lang);
    if (arr) arr.push(c);
    else out.set(lang, [c]);
  }
  return out;
}
