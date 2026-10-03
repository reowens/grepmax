import { describe, expect, it } from "vitest";
import { buildResourceSnapshot } from "../src/lib/utils/resource-snapshot";

describe("resource snapshot", () => {
  it("keeps footprint distinct from RSS and reports independent counters", () => {
    const mb = 1024 * 1024;
    const result = buildResourceSnapshot(
      {
        reason: "recycle-due",
        footprintMb: 2800,
        workers: 2,
        pendingFiles: 10,
        operations: 1,
        maintenance: true,
        lanceCacheBytes: 300 * mb,
      },
      {
        rss: 500 * mb,
        heapTotal: 100 * mb,
        heapUsed: 80 * mb,
        external: 40 * mb,
        arrayBuffers: 20 * mb,
      },
      123,
    );
    expect(result).toEqual({
      at: 123,
      reason: "recycle-due",
      footprintMb: 2800,
      rssMb: 500,
      heapUsedMb: 80,
      externalMb: 40,
      arrayBuffersMb: 20,
      lanceCacheMb: 300,
      workers: 2,
      pendingFiles: 10,
      operations: 1,
      maintenance: true,
    });
  });
});
