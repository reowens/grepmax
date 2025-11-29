import * as fs from "node:fs";
import * as path from "node:path";
import { GRAMMARS_DIR } from "./grammar-loader";
import { getLanguageByExtension } from "../core/languages";

// web-tree-sitter ships a CommonJS build
const TreeSitter = require("web-tree-sitter");
const Parser = TreeSitter.Parser;
const Language = TreeSitter.Language;

export interface Chunk {
  content: string;
  startLine: number;
  endLine: number;
  type:
  | "function"
  | "method"
  | "class"
  | "interface"
  | "type_alias"
  | "block"
  | "other";
  context?: string[];
}

export type ChunkWithContext = Chunk & {
  context: string[];
  chunkIndex?: number;
  isAnchor?: boolean;
};

// Minimal TreeSitter node interface
interface TreeSitterNode {
  type: string;
  text: string;
  startPosition: { row: number; column: number };
  endPosition: { row: number; column: number };
  startIndex: number;
  endIndex: number;
  namedChildren?: TreeSitterNode[];
  parent?: TreeSitterNode;
  childForFieldName?: (field: string) => TreeSitterNode | null;
}

// TreeSitter Parser and Language types
interface TreeSitterParser {
  init(options: { locator: string }): Promise<void>;
  setLanguage(language: TreeSitterLanguage): void;
  parse(content: string): { rootNode: TreeSitterNode };
}

type TreeSitterLanguage = Record<string, never>;

export function extractTopComments(lines: string[]): string[] {
  const comments: string[] = [];
  let inBlock = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (inBlock) {
      comments.push(line);
      if (trimmed.includes("*/")) inBlock = false;
      continue;
    }
    if (trimmed === "") {
      comments.push(line);
      continue;
    }
    if (
      trimmed.startsWith("//") ||
      trimmed.startsWith("#!") ||
      trimmed.startsWith("# ")
    ) {
      comments.push(line);
      continue;
    }
    if (trimmed.startsWith("/*")) {
      comments.push(line);
      if (!trimmed.includes("*/")) inBlock = true;
      continue;
    }
    break;
  }
  while (comments.length > 0 && comments[comments.length - 1].trim() === "") {
    comments.pop();
  }
  return comments;
}

export function extractImports(lines: string[], limit = 200): string[] {
  const modules: string[] = [];
  for (const raw of lines.slice(0, limit)) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith("import ")) {
      const fromMatch = trimmed.match(/from\s+["']([^"']+)["']/);
      const sideEffect = trimmed.match(/^import\s+["']([^"']+)["']/);
      const named = trimmed.match(/import\s+(?:\* as\s+)?([A-Za-z0-9_$]+)/);
      if (fromMatch?.[1]) modules.push(fromMatch[1]);
      else if (sideEffect?.[1]) modules.push(sideEffect[1]);
      else if (named?.[1]) modules.push(named[1]);
      continue;
    }
    const requireMatch = trimmed.match(/require\(\s*["']([^"']+)["']\s*\)/);
    if (requireMatch?.[1]) {
      modules.push(requireMatch[1]);
    }
  }
  return Array.from(new Set(modules));
}

export function extractExports(lines: string[], limit = 200): string[] {
  const exports: string[] = [];
  for (const raw of lines.slice(0, limit)) {
    const trimmed = raw.trim();
    if (!trimmed.startsWith("export") && !trimmed.includes("module.exports"))
      continue;

    const decl = trimmed.match(
      /^export\s+(?:default\s+)?(class|function|const|let|var|interface|type|enum)\s+([A-Za-z0-9_$]+)/,
    );
    if (decl?.[2]) {
      exports.push(decl[2]);
      continue;
    }

    const brace = trimmed.match(/^export\s+\{([^}]+)\}/);
    if (brace?.[1]) {
      const names = brace[1]
        .split(",")
        .map((n) => n.trim())
        .filter(Boolean);
      exports.push(...names);
      continue;
    }

    if (trimmed.startsWith("export default")) {
      exports.push("default");
    }

    if (trimmed.includes("module.exports")) {
      exports.push("module.exports");
    }
  }
  return Array.from(new Set(exports));
}

export function formatChunkText(
  chunk: ChunkWithContext,
  filePath: string,
): string {
  const breadcrumb = [...chunk.context];
  const fileLabel = `File: ${filePath || "unknown"}`;
  const hasFileLabel = breadcrumb.some(
    (entry) => typeof entry === "string" && entry.startsWith("File: "),
  );
  if (!hasFileLabel) {
    breadcrumb.unshift(fileLabel);
  }
  const header = breadcrumb.length > 0 ? breadcrumb.join(" > ") : fileLabel;
  return `${header}\n---\n${chunk.content}`;
}

export function buildAnchorChunk(
  filePath: string,
  content: string,
): Chunk & { context: string[]; chunkIndex: number; isAnchor: boolean } {
  const lines = content.split("\n");
  const topComments = extractTopComments(lines);
  const imports = extractImports(lines);
  const exports = extractExports(lines);

  const preamble: string[] = [];
  let nonBlank = 0;
  let totalChars = 0;
  let lastIncludedLineIdx = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;

    preamble.push(line);
    lastIncludedLineIdx = i;
    nonBlank += 1;
    totalChars += line.length;
    if (nonBlank >= 30 || totalChars >= 1200) break;
  }

  const sections: string[] = [];
  sections.push(`File: ${filePath}`);
  if (imports.length > 0) {
    sections.push(`Imports: ${imports.join(", ")}`);
  }
  if (exports.length > 0) {
    sections.push(`Exports: ${exports.join(", ")}`);
  }
  if (topComments.length > 0) {
    sections.push(`Top comments:\n${topComments.join("\n")}`);
  }
  if (preamble.length > 0) {
    sections.push(`Preamble:\n${preamble.join("\n")}`);
  }
  sections.push("---");
  sections.push("(anchor)");

  const anchorText = sections.join("\n\n");
  const approxEndLine = Math.min(
    lines.length - 1,
    Math.max(0, lastIncludedLineIdx),
  );

  return {
    content: anchorText,
    startLine: 0,
    endLine: approxEndLine,
    type: "block",
    context: [`File: ${filePath}`, "Anchor"],
    chunkIndex: -1,
    isAnchor: true,
  };
}

export class TreeSitterChunker {
  private parser: TreeSitterParser | null = null;
  private languages: Map<string, TreeSitterLanguage | null> = new Map();
  private initialized = false;

  // Tuned for speed: Fill the context window (512 tokens) more aggressively.
  private readonly MAX_CHUNK_LINES = 75;
  private readonly MAX_CHUNK_CHARS = 2000;
  private readonly OVERLAP_LINES = 10;

  // For long single-line or low-newline regions (json, lockfiles, huge strings)
  private readonly OVERLAP_CHARS = 200;

  async init() {
    if (this.initialized) return;
    try {
      await Parser.init({
        locator: require.resolve("web-tree-sitter/tree-sitter.wasm"),
      });
      this.parser = new Parser() as TreeSitterParser;
    } catch (_err) {
      console.warn(
        "⚠️  Offline mode: Semantic search quality reduced (Tree-Sitter unavailable)",
      );
      this.parser = null;
    }

    if (!fs.existsSync(GRAMMARS_DIR)) {
      fs.mkdirSync(GRAMMARS_DIR, { recursive: true });
    }
    this.initialized = true;
  }

  private async getLanguage(lang: string): Promise<TreeSitterLanguage | null> {
    const cached = this.languages.get(lang);
    if (cached !== undefined) return cached;

    const wasmPath = path.join(GRAMMARS_DIR, `tree-sitter-${lang}.wasm`);
    if (!fs.existsSync(wasmPath)) {
      console.warn(
        `⚠️  Missing grammar for ${lang}. Run 'osgrep setup' to download it. Using fallback chunking.`,
      );
      return null;
    }

    try {
      const language = Language
        ? ((await Language.load(wasmPath)) as TreeSitterLanguage | null)
        : null;
      this.languages.set(lang, language);
      return language;
    } catch {
      return null;
    }
  }

  async chunk(filePath: string, content: string): Promise<Chunk[]> {
    if (!this.initialized) await this.init();

    let rawChunks: Chunk[] = [];

    if (this.parser) {
      try {
        rawChunks = await this.chunkWithTreeSitter(filePath, content);
      } catch {
        rawChunks = [];
      }
    }

    if (rawChunks.length === 0) {
      rawChunks = this.fallbackChunk(content, filePath);
    }

    return rawChunks.flatMap((c) => this.splitIfTooBig(c));
  }

  private async chunkWithTreeSitter(
    filePath: string,
    content: string,
  ): Promise<Chunk[]> {
    const ext = path.extname(filePath);
    const langDef = getLanguageByExtension(ext);
    const lang = langDef?.grammar?.name || "";
    if (!lang) return [];

    const language = await this.getLanguage(lang);
    if (!language || !this.parser) return [];

    this.parser.setLanguage(language);
    const tree = this.parser.parse(content);
    const root = tree.rootNode;

    const fileContext = `File: ${filePath}`;
    const chunks: Chunk[] = [];
    const blockChunks: Chunk[] = [];
    let cursorIndex = 0;
    let cursorRow = 0;
    let sawDefinition = false;

    const isDefType = (t: string) => {
      const common = [
        "function_declaration",
        "function_definition",
        "method_definition",
        "class_declaration",
        "class_definition",
        "interface_declaration",
        "type_alias_declaration",
      ];
      const extras: Record<string, string[]> = {
        go: ["function_declaration", "method_declaration", "type_declaration"],
        rust: [
          "function_item",
          "impl_item",
          "trait_item",
          "struct_item",
          "enum_item",
        ],
        cpp: [
          "function_definition",
          "class_specifier",
          "struct_specifier",
          "enum_specifier",
          "namespace_definition",
        ],
        c: ["function_definition", "struct_specifier", "enum_specifier"],
        java: [
          "method_declaration",
          "class_declaration",
          "interface_declaration",
          "enum_declaration",
        ],
        c_sharp: [
          "method_declaration",
          "class_declaration",
          "interface_declaration",
          "enum_declaration",
          "struct_declaration",
          "namespace_declaration",
        ],
        ruby: ["method", "class", "module"],
        php: [
          "function_definition",
          "method_declaration",
          "class_declaration",
          "interface_declaration",
        ],
        json: ["pair"],
      };

      if (common.includes(t)) return true;
      if (extras[lang] && extras[lang].includes(t)) return true;
      return false;
    };

    const classify = (node: TreeSitterNode): Chunk["type"] => {
      const t = node.type;
      if (t.includes("method")) return "method";
      if (isDefType(t) || isTopLevelValueDef(node)) return "function";
      if (t === "class_declaration" || t === "class_definition") return "class";
      if (t === "interface_declaration") return "interface";
      if (t === "type_alias_declaration") return "type_alias";
      return "block";
    };

    const unwrapExport = (node: TreeSitterNode): TreeSitterNode => {
      if (
        node.type === "export_statement" &&
        node.namedChildren &&
        node.namedChildren.length > 0
      ) {
        return node.namedChildren[0];
      }
      return node;
    };

    const isTopLevelValueDef = (node: TreeSitterNode): boolean => {
      const t = node.type;
      if (t !== "lexical_declaration" && t !== "variable_declaration")
        return false;
      const parentType = node.parent?.type || "";
      const allowedParents = ["program", "module", "source_file", "class_body"];
      if (parentType && !allowedParents.includes(parentType)) return false;
      const text = node.text || "";
      if (text.includes("=>")) return true;
      if (text.includes("function ")) return true;
      if (text.includes("class ")) return true;
      if (/(?:^|\n)\s*(?:export\s+)?const\s+[A-Z0-9_]+\s*=/.test(text))
        return true;
      return false;
    };

    const getNodeName = (node: TreeSitterNode): string | null => {
      const byField = (field: string) => {
        const child =
          typeof node.childForFieldName === "function"
            ? node.childForFieldName(field)
            : null;
        if (child?.text) return String(child.text);
        return null;
      };

      const fieldNames = ["name", "property", "identifier"];
      for (const field of fieldNames) {
        const name = byField(field);
        if (name) return name;
      }

      const identifierChild = (node.namedChildren ?? []).find((c) =>
        [
          "identifier",
          "property_identifier",
          "type_identifier",
          "field_identifier",
        ].includes(c.type),
      );
      if (identifierChild?.text) return String(identifierChild.text);

      for (const child of node.namedChildren ?? []) {
        if (child.type === "variable_declarator") {
          const idChild = (child.namedChildren ?? []).find((c) =>
            ["identifier", "property_identifier", "type_identifier"].includes(
              c.type,
            ),
          );
          if (idChild?.text) return String(idChild.text);
        }
      }

      const match = (node.text || "").match(
        /(?:class|function)\s+([A-Za-z0-9_$]+)/,
      );
      if (match?.[1]) return match[1];

      const varMatch = (node.text || "").match(
        /(?:const|let|var)\s+([A-Za-z0-9_$]+)/,
      );
      if (varMatch?.[1]) return varMatch[1];

      return null;
    };

    const labelForNode = (node: TreeSitterNode): string | null => {
      const name = getNodeName(node);
      const t = node.type;
      if (t.includes("class")) return `Class: ${name ?? "<anonymous class>"}`;
      if (t.includes("method"))
        return `Method: ${name ?? "<anonymous method>"}`;
      if (t.includes("interface"))
        return `Interface: ${name ?? "<anonymous interface>"}`;
      if (t.includes("type_alias"))
        return `Type: ${name ?? "<anonymous type>"}`;
      if (t.includes("function"))
        return `Function: ${name ?? "<anonymous function>"}`;
      if (isTopLevelValueDef(node))
        return `Function: ${name ?? "<anonymous function>"}`;
      return name ? `Symbol: ${name}` : null;
    };

    const addChunk = (node: TreeSitterNode, context: string[]) => {
      chunks.push({
        content: node.text,
        startLine: node.startPosition.row,
        endLine: node.endPosition.row,
        type: classify(node),
        context,
      });
    };

    const visit = (node: TreeSitterNode, stack: string[]) => {
      const effective = unwrapExport(node);
      const isDefinition =
        isDefType(effective.type) || isTopLevelValueDef(effective);
      let nextStack = stack;

      if (isDefinition) {
        sawDefinition = true;
        const label = labelForNode(effective);
        const context = [...stack, ...(label ? [label] : [])];
        addChunk(effective, context);
        nextStack = context;
      }

      for (const child of effective.namedChildren ?? []) {
        visit(child, nextStack);
      }
    };

    for (const child of root.namedChildren ?? []) {
      visit(child, [fileContext]);

      const effective = unwrapExport(child);
      const isDefinition =
        isDefType(effective.type) || isTopLevelValueDef(effective);
      if (!isDefinition) continue;

      if (child.startIndex > cursorIndex) {
        const gapText = content.slice(cursorIndex, child.startIndex);
        if (gapText.trim().length > 0) {
          blockChunks.push({
            content: gapText,
            startLine: cursorRow,
            endLine: child.startPosition.row,
            type: "block",
            context: [fileContext],
          });
        }
      }

      cursorIndex = child.endIndex;
      cursorRow = child.endPosition.row;
    }

    if (cursorIndex < content.length) {
      const tailText = content.slice(cursorIndex);
      if (tailText.trim().length > 0) {
        blockChunks.push({
          content: tailText,
          startLine: cursorRow,
          endLine: root.endPosition.row,
          type: "block",
          context: [fileContext],
        });
      }
    }

    if (!sawDefinition) return [];

    const combined = [...blockChunks, ...chunks].sort(
      (a, b) => a.startLine - b.startLine || a.endLine - b.endLine,
    );
    return combined;
  }

  private splitIfTooBig(chunk: Chunk): Chunk[] {
    const charCount = chunk.content.length;
    const lines = chunk.content.split("\n");
    const lineCount = lines.length;

    if (
      lineCount <= this.MAX_CHUNK_LINES &&
      charCount <= this.MAX_CHUNK_CHARS
    ) {
      return [chunk];
    }

    if (charCount > this.MAX_CHUNK_CHARS && lineCount <= this.MAX_CHUNK_LINES) {
      return this.splitByChars(chunk);
    }

    const subChunks: Chunk[] = [];
    const stride = Math.max(1, this.MAX_CHUNK_LINES - this.OVERLAP_LINES);

    const header = this.extractHeaderLine(chunk.content);

    for (let i = 0; i < lines.length; i += stride) {
      const end = Math.min(i + this.MAX_CHUNK_LINES, lines.length);
      const subLines = lines.slice(i, end);
      if (subLines.length < 3 && i > 0) continue;

      let subContent = subLines.join("\n");
      if (header && i > 0 && chunk.type !== "block") {
        subContent = `${header}\n${subContent}`;
      }

      subChunks.push({
        content: subContent,
        startLine: chunk.startLine + i,
        endLine: chunk.startLine + end,
        type: chunk.type,
        context: chunk.context,
      });
    }

    return subChunks.flatMap((sc) =>
      sc.content.length > this.MAX_CHUNK_CHARS ? this.splitByChars(sc) : [sc],
    );
  }

  private splitByChars(chunk: Chunk): Chunk[] {
    const res: Chunk[] = [];
    const stride = Math.max(1, this.MAX_CHUNK_CHARS - this.OVERLAP_CHARS);

    for (let i = 0; i < chunk.content.length; i += stride) {
      const end = Math.min(i + this.MAX_CHUNK_CHARS, chunk.content.length);
      const sub = chunk.content.slice(i, end);
      if (sub.trim().length === 0) continue;

      const prefixLines = chunk.content.slice(0, i).split("\n").length - 1;
      const subLineCount = sub.split("\n").length;

      res.push({
        content: sub,
        startLine: chunk.startLine + prefixLines,
        endLine: chunk.startLine + prefixLines + subLineCount,
        type: chunk.type,
        context: chunk.context,
      });
    }

    return res;
  }

  private extractHeaderLine(text: string): string | null {
    const lines = text.split("\n");
    for (const l of lines) {
      const t = l.trim();
      if (t.length === 0) continue;
      return t;
    }
    return null;
  }

  private fallbackChunk(content: string, filePath: string): Chunk[] {
    const lines = content.split("\n");
    const chunks: Chunk[] = [];
    const stride = Math.max(1, this.MAX_CHUNK_LINES - this.OVERLAP_LINES);
    const context = [`File: ${filePath}`];

    for (let i = 0; i < lines.length; i += stride) {
      const end = Math.min(i + this.MAX_CHUNK_LINES, lines.length);
      const subLines = lines.slice(i, end);
      if (subLines.length === 0) continue;

      const subContent = subLines.join("\n");
      chunks.push({
        content: subContent,
        startLine: i,
        endLine: end,
        type: "block",
        context,
      });
    }

    return chunks;
  }
}
