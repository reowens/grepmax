import { v4 as uuidv4 } from "uuid";
import type { Skeletonizer } from "../skeleton";
import type { PreparedChunk } from "../store/types";
import {
  buildAnchorChunk,
  type ChunkParse,
  type ChunkWithContext,
  formatChunkText,
  type TreeSitterChunker,
} from "./chunker";

/** A file's chunks with its anchor first. The chunker must be initialised. */
export async function chunkSource(
  chunker: TreeSitterChunker,
  pathname: string,
  content: string,
  borrowed?: ChunkParse | null,
): Promise<ChunkWithContext[]> {
  const { chunks: parsedChunks, metadata } = await chunker.chunk(
    pathname,
    content,
    borrowed,
  );

  const anchorChunk = buildAnchorChunk(pathname, content, metadata);
  const baseChunks = anchorChunk
    ? [anchorChunk, ...parsedChunks]
    : parsedChunks;

  return baseChunks.map((chunk, idx) => {
    const chunkWithContext = chunk as ChunkWithContext;
    return {
      ...chunkWithContext,
      context: Array.isArray(chunkWithContext.context)
        ? chunkWithContext.context
        : [],
      chunkIndex:
        typeof chunkWithContext.chunkIndex === "number"
          ? chunkWithContext.chunkIndex
          : anchorChunk
            ? idx - 1
            : idx,
      isAnchor:
        chunkWithContext.isAnchor === true || (anchorChunk ? idx === 0 : false),
      imports: metadata.imports,
    };
  });
}

/** Both consumers use the same source and language registry. A file that
 * could not be parsed by the chunker keeps the skeletonizer's own fallback. */
export async function chunkSourceWithSkeleton(
  chunker: TreeSitterChunker,
  skeletonizer: Skeletonizer,
  pathname: string,
  content: string,
) {
  const parsed = await chunker.parseForChunking(pathname, content);
  try {
    const chunks = await chunkSource(chunker, pathname, content, parsed);
    const skeletonResult = await skeletonizer.skeletonizeFile(
      pathname,
      content,
      { includeSummary: true },
      parsed?.tree,
    );
    return { chunks, skeletonResult };
  } finally {
    parsed?.tree.delete();
  }
}

/** The rows a file's chunks become, before embedding. */
export function prepareChunks(
  path: string,
  hash: string,
  chunks: ChunkWithContext[],
  skeleton?: string,
): PreparedChunk[] {
  const texts = chunks.map((chunk) => formatChunkText(chunk, path));
  const prepared: PreparedChunk[] = [];

  for (let i = 0; i < texts.length; i++) {
    const chunk = chunks[i];
    const { content, displayText } = texts[i];
    const prev = texts[i - 1]?.displayText;
    const next = texts[i + 1]?.displayText;

    prepared.push({
      id: uuidv4(),
      path,
      hash,
      content: content, // Now minimal
      display_text: displayText, // Now rich
      context_prev: typeof prev === "string" ? prev : undefined,
      context_next: typeof next === "string" ? next : undefined,
      start_line: chunk.startLine,
      end_line: chunk.endLine,
      chunk_index: chunk.chunkIndex,
      is_anchor: chunk.isAnchor === true,
      chunk_type: typeof chunk.type === "string" ? chunk.type : undefined,
      complexity: chunk.complexity,
      is_exported: chunk.isExported,
      defined_symbols: chunk.definedSymbols,
      referenced_symbols: chunk.referencedSymbols,
      type_referenced_symbols: chunk.typeReferencedSymbols,
      member_referenced_symbols: chunk.memberReferencedSymbols,
      role: chunk.role,
      parent_symbol: chunk.parentSymbol,
      file_skeleton: chunk.isAnchor ? skeleton : undefined,
    });
  }

  return prepared;
}
