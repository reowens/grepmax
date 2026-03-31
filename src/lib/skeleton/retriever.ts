import type { VectorDB } from "../store/vector-db";
import { escapeSqlString } from "../utils/filter-builder";

export async function getStoredSkeleton(
  db: VectorDB,
  filePath: string,
): Promise<string | null> {
  try {
    const table = await db.ensureTable();
    // LanceDB query
    const results = await table
      .query()
      .select(["file_skeleton"])
      .where(`path = '${escapeSqlString(filePath)}' AND is_anchor = true`)
      .limit(1)
      .toArray();

    if (results.length > 0) {
      const skel = results[0].file_skeleton;
      if (typeof skel === "string" && skel.length > 0) {
        return skel;
      }
    }
    return null;
  } catch (_e) {
    // If table doesn't exist or query fails, return null
    return null;
  }
}
