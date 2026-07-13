import * as path from "node:path";
import type { MetaEntry } from "../store/meta-cache";

export const CURRENT_META_HASH_VERSION = 1;

type Reconciliation =
  | { action: "current" }
  | { action: "stamp"; entry: MetaEntry }
  | { action: "reprocess"; mustRewriteVectors: boolean };

function usesLegacyMarkdownHash(filePath: string, entry: MetaEntry): boolean {
  if (entry.hashVersion === CURRENT_META_HASH_VERSION) return false;
  const extension = path.extname(filePath).toLowerCase();
  return extension === ".md" || extension === ".mdx";
}

export function isMetaEntryCacheCurrent(
  entry: MetaEntry | null | undefined,
  _filePath: string,
): entry is MetaEntry & { hashVersion: number; hasVectors: boolean } {
  return (
    entry?.hashVersion === CURRENT_META_HASH_VERSION &&
    typeof entry.hasVectors === "boolean"
  );
}

export function reconcileMetaEntry(
  filePath: string,
  entry: MetaEntry | undefined,
  vectorPresent: boolean,
): Reconciliation {
  if (!entry) {
    return { action: "reprocess", mustRewriteVectors: vectorPresent };
  }

  const explicitVectorState = typeof entry.hasVectors === "boolean";
  if (
    (entry.hasVectors === true && !vectorPresent) ||
    (entry.hasVectors === false && vectorPresent) ||
    (!explicitVectorState && !vectorPresent)
  ) {
    return { action: "reprocess", mustRewriteVectors: true };
  }

  if (
    entry.hashVersion !== undefined &&
    entry.hashVersion !== CURRENT_META_HASH_VERSION
  ) {
    return { action: "reprocess", mustRewriteVectors: false };
  }

  if (usesLegacyMarkdownHash(filePath, entry)) {
    return { action: "reprocess", mustRewriteVectors: false };
  }

  if (entry.hashVersion !== CURRENT_META_HASH_VERSION || !explicitVectorState) {
    return {
      action: "stamp",
      entry: {
        ...entry,
        hashVersion: CURRENT_META_HASH_VERSION,
        hasVectors: vectorPresent,
      },
    };
  }

  return { action: "current" };
}
