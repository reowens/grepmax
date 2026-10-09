import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { pruneVersions } from "../src/lib/store/lance-cleanup";
import {
  fullTableMaintenanceDisabled,
  maintenancePolicyPath,
  recordMaintenanceContainment,
} from "../src/lib/store/maintenance-policy";
import {
  MAX_CLEANUP_VERSIONS,
  runVersionCleanup,
  VERSION_RETENTION_MS,
} from "../src/lib/store/version-cleanup";
import { resourceBudget } from "../src/lib/utils/resource-budget";

vi.mock("../src/lib/store/lance-cleanup", () => ({
  pruneVersions: vi.fn(),
  prepareCleanupRuntime: vi.fn(),
}));
vi.mock("../src/lib/utils/resource-budget", () => ({
  resourceBudget: { check: vi.fn(), reserve: vi.fn() },
}));
vi.mock("../src/lib/store/maintenance-policy", async (original) => ({
  ...(await original<typeof import("../src/lib/store/maintenance-policy")>()),
  assertStoreMutationAllowed: vi.fn(),
  availableStoreDiskBytes: () => 2 * 1024 ** 2,
}));

describe("independent version reclamation", () => {
  const roots: string[] = [];
  afterEach(() => {
    vi.clearAllMocks();
    for (const root of roots.splice(0))
      fs.rmSync(root, { recursive: true, force: true });
  });
  function fixture() {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), "gmax-version-cleanup-"),
    );
    roots.push(root);
    const reservation = { attach: vi.fn(), release: vi.fn() };
    vi.mocked(resourceBudget.reserve).mockReturnValue(reservation as any);
    return {
      root,
      reservation,
      runtime: { python: "fixture", script: "prune.py" },
      lease: {} as any,
    };
  }
  it("reclaims versions while full-table rewriting is disabled and disk has no rewrite headroom", async () => {
    const f = fixture();
    const before = Date.now();
    vi.mocked(pruneVersions).mockResolvedValue({
      engine: "12.0.0",
      version: 7,
      fragments: 3,
      bytesRemoved: 90,
      versionsRemoved: 128,
      rewritten: false,
      eligibleVersionsRemaining: 20,
      fileBytesBefore: 1000,
      fileBytesAfter: 910,
      allocatedBytesBefore: 1024,
      allocatedBytesAfter: 900,
      freeBytesBefore: 2 * 1024 ** 2,
      freeBytesAfter: 2 * 1024 ** 2 + 124,
    });
    expect(fullTableMaintenanceDisabled()).toBe(true);
    const outcome = await runVersionCleanup(f.root, f.lease, 7, f.runtime);
    const call = vi.mocked(pruneVersions).mock.calls[0];
    expect(call[3].getTime()).toBeGreaterThanOrEqual(
      before - VERSION_RETENTION_MS,
    );
    expect(call[4]).toMatchObject({
      lease: f.lease,
      maxVersions: MAX_CLEANUP_VERSIONS,
      retryUncertain: true,
    });
    expect(outcome).toMatchObject({
      rewritten: false,
      netBytesReclaimed: 124,
      versionsRemoved: 128,
      eligibleVersionsRemaining: 20,
    });
    expect(
      JSON.parse(fs.readFileSync(maintenancePolicyPath(f.root), "utf8")),
    ).toMatchObject({ cleanupPending: false, rewriteBudgetBytes: 0 });
    recordMaintenanceContainment(f.root);
    expect(
      JSON.parse(fs.readFileSync(maintenancePolicyPath(f.root), "utf8"))
        .cleanupPending,
    ).toBe(false);
    expect(f.reservation.release).toHaveBeenCalled();
  });
  it("releases resources without claiming completed cleanup when the helper fails", async () => {
    const f = fixture();
    vi.mocked(pruneVersions).mockRejectedValue(new Error("helper interrupted"));
    await expect(
      runVersionCleanup(f.root, f.lease, 7, f.runtime),
    ).rejects.toThrow("interrupted");
    expect(f.reservation.release).toHaveBeenCalled();
    expect(fs.existsSync(maintenancePolicyPath(f.root))).toBe(false);
  });
});
