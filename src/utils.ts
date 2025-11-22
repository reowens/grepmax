import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import pLimit from "p-limit";
import type { FileSystem } from "./lib/file";
import type { Store } from "./lib/store";
import type {
  InitialSyncProgress,
  InitialSyncResult,
} from "./lib/sync-helpers";

const META_FILE = path.join(os.homedir(), ".osgrep", "meta.json");

export class MetaStore {
  private data: Record<string, string> = {};
  private loaded = false;

  async load() {
    if (this.loaded) return;
    try {
      const content = await fs.promises.readFile(META_FILE, "utf-8");
      this.data = JSON.parse(content);
    } catch (e) {
      this.data = {};
    }
    this.loaded = true;
  }

  async save() {
    await fs.promises.mkdir(path.dirname(META_FILE), { recursive: true });
    await fs.promises.writeFile(META_FILE, JSON.stringify(this.data, null, 2));
  }

  get(filePath: string): string | undefined {
    return this.data[filePath];
  }

  set(filePath: string, hash: string) {
    this.data[filePath] = hash;
  }

  delete(filePath: string) {
    delete this.data[filePath];
  }
}

export function computeBufferHash(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

export function computeFileHash(
  filePath: string,
  readFileSyncFn: (p: string) => Buffer,
): string {
  const buffer = readFileSyncFn(filePath);
  return computeBufferHash(buffer);
}

export function isDevelopment(): boolean {
  // Check if running from node_modules (published package)
  if (__dirname.includes("node_modules")) {
    return false;
  }

  // Check if NODE_ENV is set to development
  if (process.env.NODE_ENV === "development") {
    return true;
  }

  // Default to local if we can't determine
  return true;
}

export async function listStoreFileHashes(
  store: Store,
  storeId: string,
): Promise<Map<string, string | undefined>> {
  const byExternalId = new Map<string, string | undefined>();
  for await (const file of store.listFiles(storeId)) {
    const externalId = file.external_id ?? undefined;
    if (!externalId) continue;
    const metadata = file.metadata;
    const hash: string | undefined =
      metadata && typeof metadata.hash === "string" ? metadata.hash : undefined;
    byExternalId.set(externalId, hash);
  }
  return byExternalId;
}

export async function uploadFile(
  store: Store,
  storeId: string,
  filePath: string,
  fileName: string,
  metaStore?: MetaStore,
): Promise<boolean> {
  const buffer = await fs.promises.readFile(filePath);
  if (buffer.length === 0) {
    return false;
  }

  const contentString = buffer.toString("utf-8");
  const hash = computeBufferHash(buffer);

  if (metaStore) {
    const cachedHash = metaStore.get(filePath);
    if (cachedHash === hash) {
      return false;
    }
  }

  const options = {
    external_id: filePath,
    overwrite: true,
    metadata: {
      path: filePath,
      hash,
    },
    content: contentString,
  };

  try {
    await store.uploadFile(storeId, contentString, options);
  } catch (_err) {
    await store.uploadFile(
      storeId,
      new File([buffer], fileName, { type: "text/plain" }),
      options,
    );
  }

  if (metaStore) {
    metaStore.set(filePath, hash);
    await metaStore.save();
  }

  return true;
}

export async function initialSync(
  store: Store,
  fileSystem: FileSystem,
  storeId: string,
  repoRoot: string,
  dryRun?: boolean,
  onProgress?: (info: InitialSyncProgress) => void,
  metaStore?: MetaStore,
): Promise<InitialSyncResult> {
  if (metaStore) {
    await metaStore.load();
  }

  const dbPaths = new Set<string>();
  let storeIsEmpty = false;
  let storeHashes: Map<string, string | undefined> = new Map();
  let initialDbCount = 0;
  try {
    for await (const file of store.listFiles(storeId)) {
      const externalId = file.external_id ?? undefined;
      if (!externalId) continue;
      dbPaths.add(externalId);
      if (!metaStore) {
        const metadata = file.metadata;
        const hash: string | undefined =
          metadata && typeof metadata.hash === "string" ? metadata.hash : undefined;
        storeHashes.set(externalId, hash);
      }
    }
    initialDbCount = dbPaths.size;
    storeIsEmpty = dbPaths.size === 0;
  } catch (_err) {
    storeIsEmpty = true;
  }

  if (metaStore && storeHashes.size === 0) {
    storeHashes = new Map();
  }

  const allFiles = Array.from(fileSystem.getFiles(repoRoot));
  const repoFiles = allFiles.filter(
    (filePath) => !fileSystem.isIgnored(filePath, repoRoot),
  );
  const diskPaths = new Set(repoFiles);

  // Remove records for files that no longer exist
  const stalePaths = Array.from(dbPaths).filter((p) => !diskPaths.has(p));
  if (stalePaths.length > 0) {
    if (dryRun) {
      stalePaths.forEach((p) => console.log("Dry run: would delete", p));
    } else {
      await Promise.all(
        stalePaths.map(async (p) => {
          try {
            await store.deleteFile(storeId, p);
            metaStore?.delete(p);
          } catch (_err) {
            // Ignore individual deletion errors to keep sync going
          }
        }),
      );
      if (metaStore) {
        await metaStore.save();
      }
    }
  }
  if (!dryRun && !storeIsEmpty) {
    storeIsEmpty = initialDbCount - stalePaths.length <= 0;
  }
  const total = repoFiles.length;
  let processed = 0;
  let uploaded = 0;

  const concurrency = 10;
  const limit = pLimit(concurrency);

  await Promise.all(
    repoFiles.map((filePath) =>
      limit(async () => {
        try {
          const buffer = await fs.promises.readFile(filePath);
          const hash = computeBufferHash(buffer);

          let existingHash: string | undefined;
          if (metaStore) {
            existingHash = metaStore.get(filePath);
          } else {
            existingHash = storeHashes.get(filePath);
          }

          processed += 1;
          const shouldUpload =
            storeIsEmpty || !existingHash || existingHash !== hash;

          if (dryRun && shouldUpload) {
            console.log("Dry run: would have uploaded", filePath);
            uploaded += 1;
          } else if (shouldUpload) {
            const didUpload = await uploadFile(
              store,
              storeId,
              filePath,
              path.basename(filePath),
              metaStore // Pass metaStore to update it after upload
            );
            if (didUpload) {
              uploaded += 1;
            }
          }
          onProgress?.({ processed, uploaded, total, filePath });
        } catch (_err) {
          onProgress?.({ processed, uploaded, total, filePath });
        }
      }),
    ),
  );

  // Create/Update FTS index after sync
  if (!dryRun) {
    await store.createFTSIndex(storeId);
    await store.createVectorIndex(storeId);
  }

  return { processed, uploaded, total };
}
