import type { Store } from "./store";

export async function ensureStoreExists(
  store: Store,
  storeId: string,
): Promise<void> {
  // Try to create first (idempotent) to ensure Lance table exists, then verify
  try {
    await store.create({
      name: storeId,
      description: "osgrep local index",
    });
  } catch (_err) {
    // Ignore errors if it already exists
  }

  await store.retrieve(storeId);
}

export async function isStoreEmpty(
  store: Store,
  storeId: string,
): Promise<boolean> {
  try {
    for await (const _ of store.listFiles(storeId)) {
      return false;
    }
  } catch (_err) {
    // If we can't list files, treat it as empty/missing
  }
  return true;
}
