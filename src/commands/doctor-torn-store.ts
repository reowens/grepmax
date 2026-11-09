import * as path from "node:path";
import { PATHS } from "../config";
import { storeMutationDeniedReason } from "../lib/store/maintenance-policy";
import { MetaCache } from "../lib/store/meta-cache";
import { StoreLease, StoreLeaseTimeoutError } from "../lib/store/store-lease";
import {
  assessTornStore,
  describeRepairFailure,
  type MetaReconcileEntry,
  reconcileMetaWithTable,
  repairTornStore,
  type TornFile,
} from "../lib/store/torn-store";
import { VectorDB } from "../lib/store/vector-db";

export type TornStoreDoctorOptions = {
  fix: boolean;
  agent: boolean;
  storeDir?: string;
  lmdbPath?: string;
};

function printFiles(label: string, files: TornFile[], agent: boolean) {
  for (const f of files)
    console.log(
      agent
        ? `${label}\t${f.path}\tbytes=${f.size}\treason=${f.reason}`
        : `  ${label} ${f.path} (${f.size} bytes): ${f.reason}`,
    );
}

async function reconcile(
  storeDir: string,
  lmdbPath: string,
  dryRun: boolean,
  lease?: StoreLease,
): Promise<MetaReconcileEntry[]> {
  const db = new VectorDB(storeDir, undefined, lease, { readOnly: true });
  const meta = new MetaCache(lmdbPath, { readOnly: dryRun });
  try {
    return await reconcileMetaWithTable(db, meta, { dryRun });
  } finally {
    await meta.close();
    await db.close({ releaseLease: false });
  }
}

/**
 * `gmax doctor --torn-store`: read-only check of the table for a torn tail
 * commit plus the metadata entries a rollback would mark for reindex.
 * With --fix it repairs offline under the exclusive store lease, which the
 * daemon's own lease blocks: the daemon repairs at its start instead.
 */
export async function runTornStoreDoctor(
  opts: TornStoreDoctorOptions,
): Promise<number> {
  const storeDir = opts.storeDir ?? PATHS.lancedbDir;
  const lmdbPath = opts.lmdbPath ?? PATHS.lmdbPath;
  const tableDir = path.join(storeDir, "chunks.lance");
  const found = assessTornStore(tableDir);
  console.log(
    opts.agent
      ? `torn_store\tstatus=${found.status}\tlatest=${found.latestVersion}\trestore=${found.restoreVersion}\tmoves=${found.moves.length}\trefusals=${found.refusals.length}`
      : `${found.status === "healthy" ? "ok  " : "FAIL"}  Store: ${found.summary}`,
  );
  printFiles("move", found.moves, opts.agent);
  printFiles("refuse", found.refusals, opts.agent);

  if (opts.fix && found.status === "repairable") {
    const denied = storeMutationDeniedReason();
    if (denied !== null) {
      console.error(`gmax doctor --torn-store --fix refused: ${denied}`);
      return 2;
    }
    let lease: StoreLease | undefined;
    try {
      lease = await StoreLease.acquireExclusive({
        storeDir,
        timeoutMs: 1000,
        role: "doctor:torn-store-repair",
      });
      const result = repairTornStore(storeDir);
      console.log(result.summary);
      if (result.moved.length === 0) return 2;
      const marked = await reconcile(storeDir, lmdbPath, false, lease);
      console.log(
        `Marked ${marked.length} file(s) for reindex; the next catch-up re-embeds them`,
      );
      return 0;
    } catch (error) {
      if (error instanceof StoreLeaseTimeoutError) {
        console.error(
          `Repair refused: ${describeRepairFailure(error)}. The daemon repairs a torn store when it starts: gmax watch restart`,
        );
        return 2;
      }
      throw error;
    } finally {
      await lease?.release();
    }
  }

  if (found.status !== "healthy") return 2;
  // Which files hold vectors in metadata that the table lacks. --fix marks
  // them; LMDB takes concurrent writers, and a file the daemon re-embeds in
  // the meantime is only embedded once more.
  let marked: MetaReconcileEntry[];
  try {
    marked = await reconcile(storeDir, lmdbPath, !opts.fix);
  } catch (error) {
    console.error(
      `Metadata reconcile check failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 2;
  }
  console.log(
    opts.agent
      ? `meta_reconcile\tdry_run=${!opts.fix}\tmarked=${marked.length}`
      : `${marked.length === 0 ? "ok  " : "WARN"}  Metadata: ${marked.length} file(s) ${opts.fix ? "marked" : "would be marked"} for reindex`,
  );
  // Agent output lists every path; the human view stops at 50.
  for (const m of opts.agent ? marked : marked.slice(0, 50))
    console.log(
      opts.agent
        ? `reindex\t${m.path}\t${m.reason}`
        : `  ${m.path}: ${m.reason}`,
    );
  if (!opts.agent && marked.length > 50)
    console.log(`  and ${marked.length - 50} more`);
  return marked.length === 0 || opts.fix ? 0 : 1;
}
