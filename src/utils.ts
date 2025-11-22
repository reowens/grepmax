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

  // If the store is empty (e.g., data directory cleared), force a full upload even if hashes match.
  let storeIsEmpty = false;
  try {
    let found = false;
    for await (const _ of store.listFiles(storeId)) {
      found = true;
      break;
    }
    storeIsEmpty = !found;
  } catch (_err) {
    storeIsEmpty = true;
  }

  // If metaStore is provided, use it. Otherwise fallback to listing store files (slow).
  let storeHashes: Map<string, string | undefined>;
  if (metaStore) {
    storeHashes = new Map();
    // We don't populate storeHashes from metaStore here because we check metaStore directly in the loop
    // But to keep logic similar, we could. 
    // However, the loop below uses `storeHashes.get(filePath)`.
    // Let's just use a getter function or map.
  } else {
    storeHashes = await listStoreFileHashes(store, storeId);
  }

  const allFiles = Array.from(fileSystem.getFiles(repoRoot));
  const repoFiles = allFiles.filter(
    (filePath) => !fileSystem.isIgnored(filePath, repoRoot),
  );
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
  }

  return { processed, uploaded, total };
}
