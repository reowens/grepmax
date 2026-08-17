import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { extname } from "node:path";
import { INDEXABLE_EXTENSIONS, MAX_FILE_SIZE_BYTES } from "../../config";
import { resolveContainedPath } from "./path-containment";

export function computeBufferHash(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

/** Hash the exact bytes passed to chunking and embedding. */
export function computeContentHash(buffer: Buffer, _filePath: string): string {
  return computeBufferHash(buffer);
}

export function hasNullByte(buffer: Buffer, sampleLength = 1024): boolean {
  const length = Math.min(buffer.length, sampleLength);
  for (let i = 0; i < length; i++) {
    if (buffer[i] === 0) return true;
  }
  return false;
}

export async function readFileSnapshot(
  filePath: string,
  options: { projectRoot?: string } = {},
): Promise<{ buffer: Buffer; mtimeMs: number; size: number }> {
  const resolved = options.projectRoot
    ? resolveContainedPath(options.projectRoot, filePath, {
        verifyExistingTarget: true,
      })
    : filePath;
  const handle = await fs.promises.open(
    resolved,
    fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
  );
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw new Error("Path is not a regular file");
    if (before.size > MAX_FILE_SIZE_BYTES) {
      throw new Error("File exceeds maximum allowed size");
    }
    const size = before.size;
    const buffer = size > 0 ? Buffer.allocUnsafe(size) : Buffer.alloc(0);
    if (size > 0) {
      let offset = 0;
      while (offset < size) {
        const { bytesRead } = await handle.read(
          buffer,
          offset,
          size - offset,
          offset,
        );
        if (bytesRead <= 0) {
          throw new Error("Unexpected end of file during read");
        }
        offset += bytesRead;
      }
    }
    const after = await handle.stat();
    if (before.mtimeMs !== after.mtimeMs || before.size !== after.size) {
      throw new Error("File changed during read");
    }
    if (options.projectRoot) {
      resolveContainedPath(options.projectRoot, resolved, {
        verifyExistingTarget: true,
      });
      const currentLstat = await fs.promises.lstat(resolved);
      const current = await fs.promises.stat(resolved);
      if (
        currentLstat.isSymbolicLink() ||
        current.dev !== after.dev ||
        current.ino !== after.ino
      ) {
        throw new Error("File identity changed during read");
      }
    }
    return { buffer, mtimeMs: after.mtimeMs, size: after.size };
  } finally {
    await handle.close();
  }
}

export function readContainedTextFileSync(
  projectRoot: string,
  filePath: string,
): string {
  const resolved = resolveContainedPath(projectRoot, filePath, {
    verifyExistingTarget: true,
  });
  const fd = fs.openSync(
    resolved,
    fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
  );
  try {
    const before = fs.fstatSync(fd);
    if (!before.isFile()) throw new Error("Path is not a regular file");
    if (before.size > MAX_FILE_SIZE_BYTES) {
      throw new Error("File exceeds maximum allowed size");
    }
    const buffer = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < buffer.length) {
      const bytesRead = fs.readSync(
        fd,
        buffer,
        offset,
        buffer.length - offset,
        offset,
      );
      if (bytesRead <= 0) throw new Error("Unexpected end of file during read");
      offset += bytesRead;
    }
    const after = fs.fstatSync(fd);
    if (before.mtimeMs !== after.mtimeMs || before.size !== after.size) {
      throw new Error("File changed during read");
    }
    resolveContainedPath(projectRoot, resolved, {
      verifyExistingTarget: true,
    });
    const currentLstat = fs.lstatSync(resolved);
    const current = fs.statSync(resolved);
    if (
      currentLstat.isSymbolicLink() ||
      current.dev !== after.dev ||
      current.ino !== after.ino
    ) {
      throw new Error("File identity changed during read");
    }
    return buffer.toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
}

// Check if a file should be indexed (extension and size).
export function isIndexableFile(filePath: string, size?: number): boolean {
  const ext = extname(filePath).toLowerCase();
  const basename = path.basename(filePath).toLowerCase();
  if (!INDEXABLE_EXTENSIONS.has(ext) && !INDEXABLE_EXTENSIONS.has(basename)) {
    return false;
  }

  const withinSize = (s: number) => s > 0 && s <= MAX_FILE_SIZE_BYTES;

  if (typeof size === "number") {
    return withinSize(size);
  }

  try {
    const stats = fs.statSync(filePath);
    return withinSize(stats.size);
  } catch {
    return false;
  }
}

export function isIndexablePath(filePath: string): boolean {
  return isIndexableFile(filePath);
}

// Markers that only ever appear in a codegen banner. Any one of these, on its
// own, is enough. Tools (protoc, graphql-codegen, Apollo, Relay, Go `stringer`,
// OpenAPI) stamp one of these; doc generators fence their output with the
// `generated-body` / `AUTO-GENERATED-CONTENT` style directives.
const STRONG_GENERATED_MARKER =
  /@generated\b|@autogenerated\b|\bCode generated by |\bauto-?generated by |\bThis (?:file|code) (?:is|was) (?:\w+[ -])?generated|\bmachine[ -]generated\b|\bauto-?generated[-_ ]?content\b|\bgenerated[-_](?:body|content|section|block)\b|\bBEGIN GENERATED\b/i;

// "DO NOT EDIT" is not proof of codegen on its own — humans write it on prose
// they want left alone (archived vendor snapshots, verbatim captures). Real
// codegen banners pair it with a generation word, so require that pairing.
const DO_NOT_EDIT_MARKER = /\bDO NOT EDIT\b/i;
const GENERATION_CONTEXT = /generat|codegen|autogen/i;

const GENERATED_SNIFF_BYTES = 2048;
const DOC_LIKE_EXTENSIONS = /\.(?:md|mdx|markdown|txt|rst|adoc|asciidoc)$/i;

/**
 * Extract the leading banner: the run of shebang, frontmatter, blank, and
 * comment lines at the very top, stopping at the first line of actual code.
 *
 * Scanning raw head bytes instead was the bug this replaces. Two ways it
 * misfired, both silently erasing hand-written files from the index:
 *
 *  - A *generator* was classified as its own output, because the banner it
 *    emits appears as a string literal in its body
 *    (`lines.push('# Auto-generated by ...')`).
 *  - A comment quoting another file's rules ("its README says do not edit")
 *    counted as a banner.
 *
 * A real codegen banner precedes all code, so anchoring here removes both
 * without weakening detection.
 *
 * In doc-like files `#` starts a heading, not a comment, so only frontmatter
 * and HTML comments count — otherwise the whole document body would be read as
 * banner.
 */
function leadingBanner(head: string, filePath?: string): string {
  const docLike = filePath ? DOC_LIKE_EXTENSIONS.test(filePath) : false;
  const lines = head.split("\n");
  const banner: string[] = [];
  let i = 0;

  if (!docLike && lines[0]?.startsWith("#!")) {
    banner.push(lines[0]);
    i = 1;
  }

  // YAML frontmatter is metadata, not code — a generated-doc marker often sits
  // directly after it.
  if (lines[i]?.trim() === "---") {
    banner.push(lines[i]);
    i++;
    while (i < lines.length && lines[i].trim() !== "---")
      banner.push(lines[i++]);
    if (i < lines.length) banner.push(lines[i++]);
  }

  let blockEnd: string | undefined;
  for (; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    if (blockEnd) {
      banner.push(line);
      if (trimmed.includes(blockEnd)) blockEnd = undefined;
      continue;
    }
    if (trimmed === "") {
      banner.push(line);
      continue;
    }
    if (trimmed.startsWith("<!--")) {
      banner.push(line);
      if (!trimmed.includes("-->")) blockEnd = "-->";
      continue;
    }
    if (!docLike) {
      if (trimmed.startsWith("/*")) {
        banner.push(line);
        if (!trimmed.includes("*/")) blockEnd = "*/";
        continue;
      }
      if (
        trimmed.startsWith("//") ||
        trimmed.startsWith("#") ||
        trimmed.startsWith("--") ||
        trimmed.startsWith(";") ||
        trimmed.startsWith("*")
      ) {
        banner.push(line);
        continue;
      }
    }
    break; // first real line of content — the banner is over
  }

  return banner.join("\n");
}

/**
 * Detect machine-generated source by its banner. Generated files flood both the
 * vector index and the symbol graph (codegen types rank as god nodes), so they
 * are skipped at index time. Path globs in `ignore-patterns.ts` catch the
 * obvious filenames; this catches the rest by content.
 *
 * `filePath` is optional but worth passing: without it, doc-like files are
 * scanned with code comment rules, so a markdown `# Heading` reads as a comment.
 */
export function isGeneratedContent(buffer: Buffer, filePath?: string): boolean {
  const head = buffer.subarray(0, GENERATED_SNIFF_BYTES).toString("utf-8");
  const banner = leadingBanner(head, filePath);
  if (!banner.trim()) return false;
  if (STRONG_GENERATED_MARKER.test(banner)) return true;
  return DO_NOT_EDIT_MARKER.test(banner) && GENERATION_CONTEXT.test(banner);
}

export function formatDenseSnippet(text: string, maxLength = 1500): string {
  const clean = text ?? "";
  if (clean.length <= maxLength) return clean;
  return `${clean.slice(0, maxLength)}...`;
}

export function isDevelopment(): boolean {
  // Return false when running from within node_modules
  if (__dirname.includes("node_modules")) {
    return false;
  }
  // Return true only when NODE_ENV is explicitly "development"
  if (process.env.NODE_ENV === "development") {
    return true;
  }
  // Otherwise return false (production/other environments)
  return false;
}
