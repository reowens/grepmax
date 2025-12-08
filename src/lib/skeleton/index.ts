/**
 * Skeleton module - Code compression for AI agents.
 *
 * Reduces token usage by 80-95% while preserving:
 * - Function/method signatures
 * - Class declarations
 * - Type definitions
 * - Summary of what functions do
 */

export {
  BODY_FIELDS,
  getBodyField,
  hasBodyField,
  shouldPreserveWhole,
} from "./body-fields";
export type { SkeletonOptions, SkeletonResult } from "./skeletonizer";
export { Skeletonizer, skeletonizeFile } from "./skeletonizer";
export type { ChunkMetadata, SummaryOptions } from "./summary-formatter";
export {
  formatSkeletonHeader,
  formatSummary,
  getCommentStyle,
} from "./summary-formatter";
