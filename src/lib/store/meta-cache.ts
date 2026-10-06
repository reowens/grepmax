import * as fs from "node:fs";
import * as path from "node:path";
import { open, type RootDatabase } from "lmdb";
import { registerCleanup } from "../utils/cleanup";
import {
  assertFreshDiskMutationAllowed,
  assertStoreMutationAllowed,
  storeMutationDeniedReason,
} from "./maintenance-policy";

export type MetaEntry = {
  hash: string;
  mtimeMs: number;
  size: number;
  hashVersion?: number;
  hasVectors?: boolean;
};

export class MetaCache {
  private db: RootDatabase<MetaEntry>;
  private unregisterCleanup?: () => void;
  private closed = false;
  private readonly readOnly: boolean;

  constructor(private readonly lmdbPath: string) {
    let diskAllowsWrites = false;
    try {
      assertFreshDiskMutationAllowed(lmdbPath);
      diskAllowsWrites = true;
    } catch {
      /* Unknown/critical disk allows existing-cache reads only. */
    }
    this.readOnly = storeMutationDeniedReason() !== null || !diskAllowsWrites;
    if (this.readOnly) {
      // Quarantine permits reads of an existing cache, never creating one.
      try {
        fs.lstatSync(lmdbPath);
      } catch {
        throw new Error(
          "gmax metadata cache is quarantined or disk-constrained and unavailable",
        );
      }
    } else {
      assertStoreMutationAllowed();
      assertFreshDiskMutationAllowed(lmdbPath);
      fs.mkdirSync(path.dirname(lmdbPath), { recursive: true });
    }
    this.db = open<MetaEntry>({
      path: lmdbPath,
      compression: true,
      cache: true,
      readOnly: this.readOnly,
    });
    this.unregisterCleanup = registerCleanup(() => this.close());
  }

  get(filePath: string): MetaEntry | undefined {
    return this.db.get(filePath);
  }

  async getAllKeys(): Promise<Set<string>> {
    const keys = new Set<string>();
    for await (const { key } of this.db.getRange()) {
      keys.add(String(key));
    }
    return keys;
  }

  async getKeysWithPrefix(prefix: string): Promise<Set<string>> {
    const keys = new Set<string>();
    for await (const { key } of this.db.getRange({ start: prefix })) {
      const k = String(key);
      if (!k.startsWith(prefix)) break;
      keys.add(k);
    }
    return keys;
  }

  put(filePath: string, entry: MetaEntry): void {
    this.assertWritable();
    this.db.put(filePath, entry);
  }

  delete(filePath: string): void {
    this.assertWritable();
    this.db.remove(filePath);
  }

  private assertWritable(): void {
    assertStoreMutationAllowed();
    assertFreshDiskMutationAllowed(this.lmdbPath);
    if (this.readOnly)
      throw new Error(
        "gmax metadata cache was opened read-only; reopen after reviewing containment",
      );
  }

  async *entries(): AsyncGenerator<{ path: string; entry: MetaEntry }> {
    for await (const { key, value } of this.db.getRange()) {
      if (!value) continue;
      yield { path: String(key), entry: value };
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.unregisterCleanup?.();
    this.unregisterCleanup = undefined;
    await this.db.flushed;
    this.db.close();
  }
}
